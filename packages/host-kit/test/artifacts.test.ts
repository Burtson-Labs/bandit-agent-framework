/**
 * Bandit Artifacts client. Properties: posts multipart to S3Api's /api/artifact
 * with the caller's bearer token, returns the shareable URL, guesses content
 * type from the filename, and throws a clear error (with server detail) on
 * failure — user-initiated sharing shouldn't fail silently.
 */
import { describe, it, expect } from 'vitest';
import {
  publishArtifact,
  guessContentType,
  resolveGatewayToken,
  listArtifacts,
  deleteArtifact,
  clearArtifacts,
  artifactKeyFromUrl
} from '../src/artifacts';

describe('guessContentType', () => {
  it('maps common artifact extensions', () => {
    expect(guessContentType('report.html')).toBe('text/html');
    expect(guessContentType('notes.md')).toBe('text/markdown');
    expect(guessContentType('data.json')).toBe('application/json');
    expect(guessContentType('mystery.bin')).toBe('application/octet-stream');
  });
});

describe('publishArtifact', () => {
  function capturingFetch(response: { ok: boolean; status?: number; body: unknown }) {
    const calls: Array<{ url: string; method?: string; auth?: string; contentType?: string; bodyIsBytes: boolean }> = [];
    const fetchImpl = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        method: init?.method,
        auth: headers.authorization,
        contentType: headers['content-type'],
        // Body is a hand-built Uint8Array now (runtime-agnostic), NOT FormData.
        bodyIsBytes: init?.body instanceof Uint8Array,
      });
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        json: async () => response.body,
      } as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it('uploads a hand-built multipart body with the bearer token, returns the URL', async () => {
    const { calls, fetchImpl } = capturingFetch({
      ok: true,
      body: { url: 'https://s3.burtson.ai/api/artifact/owner-abc/deadbeef.html', key: 'owner-abc/deadbeef.html', size: 42 },
    });
    const result = await publishArtifact({
      s3ApiBaseUrl: 'https://s3.burtson.ai/',
      token: 'jwt-123',
      content: '<h1>report</h1>',
      filename: 'report.html',
      fetchImpl,
    });
    expect(result.url).toMatch(/\/api\/artifact\/owner-abc\/deadbeef\.html$/);
    expect(calls[0]).toMatchObject({
      url: 'https://s3.burtson.ai/api/artifact', // trailing slash trimmed
      method: 'POST',
      auth: 'Bearer jwt-123',
      bodyIsBytes: true, // NOT FormData — the Bun-compat fix
    });
    // We set the multipart content-type ourselves (with the boundary).
    expect(calls[0].contentType).toMatch(/^multipart\/form-data; boundary=----banditartifact/);
  });

  it('throws with the server message on failure (no silent fail)', async () => {
    const { fetchImpl } = capturingFetch({ ok: false, status: 400, body: { message: 'Artifact exceeds the 25 MB limit.' } });
    await expect(publishArtifact({
      s3ApiBaseUrl: 'https://s3.burtson.ai', token: 't', content: 'x', filename: 'big.bin', fetchImpl,
    })).rejects.toThrow(/HTTP 400 — Artifact exceeds the 25 MB limit/);
  });

  it('throws if the upload returns no URL', async () => {
    const { fetchImpl } = capturingFetch({ ok: true, body: { key: 'k' } });
    await expect(publishArtifact({
      s3ApiBaseUrl: 'https://s3.burtson.ai', token: 't', content: 'x', filename: 'a.txt', fetchImpl,
    })).rejects.toThrow(/no URL was returned/);
  });

  it('retries a transient 5xx and succeeds on a later attempt', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) return { ok: false, status: 500, json: async () => ({ message: 'Internal server error' }) } as Response;
      return { ok: true, status: 200, json: async () => ({ url: 'https://s3/api/artifact/k.html', key: 'k.html', size: 1 }) } as Response;
    }) as unknown as typeof fetch;
    const result = await publishArtifact({
      s3ApiBaseUrl: 'https://s3', token: 'jwt', content: 'x', filename: 'a.html', fetchImpl, retryDelayMs: 0,
    });
    expect(result.url).toContain('/api/artifact/k.html');
    expect(calls).toBe(3); // two 500s, then success
  });

  it('does NOT retry a 4xx (terminal client error)', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return { ok: false, status: 400, json: async () => ({ message: 'too big' }) } as Response; }) as unknown as typeof fetch;
    await expect(publishArtifact({
      s3ApiBaseUrl: 'https://s3', token: 'jwt', content: 'x', filename: 'a.html', fetchImpl, retryDelayMs: 0,
    })).rejects.toThrow(/HTTP 400 — too big/);
    expect(calls).toBe(1); // no retry on 4xx
  });

  it('gives up after maxAttempts on persistent 5xx', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return { ok: false, status: 500, json: async () => ({ message: 'boom' }) } as Response; }) as unknown as typeof fetch;
    await expect(publishArtifact({
      s3ApiBaseUrl: 'https://s3', token: 'jwt', content: 'x', filename: 'a.html', fetchImpl, retryDelayMs: 0, maxAttempts: 2,
    })).rejects.toThrow(/HTTP 500 — boom/);
    expect(calls).toBe(2);
  });

  it('exchanges a bai_ key for a gateway JWT, then uploads with THAT JWT', async () => {
    // Two-leg fetch: AuthApi /keys/validate (returns gatewayToken), then S3Api /artifact.
    const calls: Array<{ url: string; auth?: string }> = [];
    const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, auth: (init?.headers as Record<string, string>)?.authorization });
      if (url.endsWith('/api/keys/validate')) {
        return { ok: true, status: 200, json: async () => ({ valid: true, gatewayToken: 'gw-jwt-xyz' }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ url: 'https://s3.burtson.ai/api/artifact/team-1/a.md', key: 'team-1/a.md', size: 3 }) } as Response;
    }) as unknown as typeof fetch;

    const result = await publishArtifact({
      s3ApiBaseUrl: 'https://s3.burtson.ai',
      authBaseUrl: 'https://auth.burtson.ai',
      token: 'bai_secretkey',
      content: 'hey',
      filename: 'a.md',
      fetchImpl,
    });
    expect(result.url).toContain('/api/artifact/team-1/a.md');
    expect(calls[0].url).toBe('https://auth.burtson.ai/api/keys/validate');
    // The S3Api call carries the exchanged JWT, never the raw bai_ key.
    expect(calls[1].url).toBe('https://s3.burtson.ai/api/artifact');
    expect(calls[1].auth).toBe('Bearer gw-jwt-xyz');
  });
});

describe('resolveGatewayToken', () => {
  it('passes a non-bai_ token (already a JWT) straight through, no network call', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return {} as Response; }) as unknown as typeof fetch;
    const out = await resolveGatewayToken('eyJ.header.sig', { fetchImpl });
    expect(out).toBe('eyJ.header.sig');
    expect(called).toBe(false);
  });

  it('exchanges a bai_ key via /api/keys/validate', async () => {
    const fetchImpl = (async (url: string) => ({
      ok: true, status: 200,
      json: async () => ({ valid: true, gatewayToken: 'gw-123' }),
    } as Response)) as unknown as typeof fetch;
    expect(await resolveGatewayToken('bai_abc', { authBaseUrl: 'https://auth.burtson.ai/', fetchImpl })).toBe('gw-123');
  });

  it('throws a clear error when the key is rejected', async () => {
    const fetchImpl = (async () => ({
      ok: true, status: 200, json: async () => ({ valid: false, reason: 'revoked' }),
    } as Response)) as unknown as typeof fetch;
    await expect(resolveGatewayToken('bai_dead', { fetchImpl })).rejects.toThrow(/rejected.*revoked/);
  });
});

describe('artifactKeyFromUrl', () => {
  it('extracts + decodes the key from a share URL', () => {
    expect(artifactKeyFromUrl('https://s3.burtson.ai/api/artifact/team-1/abc.html')).toBe('team-1/abc.html');
    expect(artifactKeyFromUrl('https://s3.burtson.ai/api/artifact/owner-x/a%20b.md')).toBe('owner-x/a b.md');
  });
  it('passes a bare key through unchanged', () => {
    expect(artifactKeyFromUrl('team-1/abc.html')).toBe('team-1/abc.html');
  });
});

describe('artifact management', () => {
  it('listArtifacts GETs /mine with the bearer and returns the array', async () => {
    const calls: Array<{ url: string; method?: string; auth?: string }> = [];
    const fetchImpl = (async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      calls.push({ url, method: init?.method, auth: (init?.headers as Record<string, string>)?.authorization });
      return { ok: true, status: 200, json: async () => ({ count: 1, artifacts: [{ key: 'k', url: 'u', size: 3, lastModified: 't' }] }) } as Response;
    }) as unknown as typeof fetch;
    const items = await listArtifacts({ s3ApiBaseUrl: 'https://s3.burtson.ai/', token: 'jwt', fetchImpl });
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe('k');
    expect(calls[0]).toMatchObject({ url: 'https://s3.burtson.ai/api/artifact/mine', auth: 'Bearer jwt' });
  });

  it('deleteArtifact DELETEs the per-segment-encoded key (accepts a URL)', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method });
      return { ok: true, status: 200, json: async () => ({ deleted: 'k' }) } as Response;
    }) as unknown as typeof fetch;
    await deleteArtifact({ s3ApiBaseUrl: 'https://s3.burtson.ai', token: 'jwt', keyOrUrl: 'https://s3.burtson.ai/api/artifact/team-1/abc.html', fetchImpl });
    expect(calls[0]).toMatchObject({ url: 'https://s3.burtson.ai/api/artifact/team-1/abc.html', method: 'DELETE' });
  });

  it('deleteArtifact surfaces a clear 404 (not found / not yours)', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as unknown as typeof fetch;
    await expect(deleteArtifact({ s3ApiBaseUrl: 'https://s3.burtson.ai', token: 'jwt', keyOrUrl: 'team-x/gone.html', fetchImpl }))
      .rejects.toThrow(/no artifact found/);
  });

  it('clearArtifacts DELETEs /mine and returns the deleted count', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method });
      return { ok: true, status: 200, json: async () => ({ deleted: 7 }) } as Response;
    }) as unknown as typeof fetch;
    const n = await clearArtifacts({ s3ApiBaseUrl: 'https://s3.burtson.ai', token: 'jwt', fetchImpl });
    expect(n).toBe(7);
    expect(calls[0]).toMatchObject({ url: 'https://s3.burtson.ai/api/artifact/mine', method: 'DELETE' });
  });

  it('scope=team adds ?scope=team on publish and clear; default (private) does not', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.includes('/mine')) return { ok: true, status: 200, json: async () => ({ deleted: 0 }) } as Response;
      return { ok: true, status: 200, json: async () => ({ url: 'u', key: 'k', size: 1 }) } as Response;
    }) as unknown as typeof fetch;
    const commonPub = { s3ApiBaseUrl: 'https://s3.burtson.ai', token: 'jwt', content: 'x', filename: 'a.md', fetchImpl } as const;
    await publishArtifact({ ...commonPub, scope: 'team' });
    await publishArtifact({ ...commonPub }); // default private
    await clearArtifacts({ s3ApiBaseUrl: 'https://s3.burtson.ai', token: 'jwt', scope: 'team', fetchImpl });
    await clearArtifacts({ s3ApiBaseUrl: 'https://s3.burtson.ai', token: 'jwt', fetchImpl });
    expect(urls[0]).toBe('https://s3.burtson.ai/api/artifact?scope=team');
    expect(urls[1]).toBe('https://s3.burtson.ai/api/artifact'); // private → no query
    expect(urls[2]).toBe('https://s3.burtson.ai/api/artifact/mine?scope=team');
    expect(urls[3]).toBe('https://s3.burtson.ai/api/artifact/mine');
  });
});

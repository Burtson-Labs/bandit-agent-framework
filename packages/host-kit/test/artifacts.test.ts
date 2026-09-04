/**
 * Bandit Artifacts client. Properties: posts multipart to S3Api's /api/artifact
 * with the caller's bearer token, returns the shareable URL, guesses content
 * type from the filename, and throws a clear error (with server detail) on
 * failure — user-initiated sharing shouldn't fail silently.
 */
import { describe, it, expect } from 'vitest';
import { publishArtifact, guessContentType, resolveGatewayToken } from '../src/artifacts';

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
    const calls: Array<{ url: string; method?: string; auth?: string; hasForm: boolean }> = [];
    const fetchImpl = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
      calls.push({
        url,
        method: init?.method,
        auth: (init?.headers as Record<string, string>)?.authorization,
        hasForm: typeof FormData !== 'undefined' && init?.body instanceof FormData,
      });
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        json: async () => response.body,
      } as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it('uploads with the bearer token and returns the shareable URL', async () => {
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
      hasForm: true,
    });
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

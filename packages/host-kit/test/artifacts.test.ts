/**
 * Bandit Artifacts client. Properties: posts multipart to S3Api's /api/artifact
 * with the caller's bearer token, returns the shareable URL, guesses content
 * type from the filename, and throws a clear error (with server detail) on
 * failure — user-initiated sharing shouldn't fail silently.
 */
import { describe, it, expect } from 'vitest';
import { publishArtifact, guessContentType } from '../src/artifacts';

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
});

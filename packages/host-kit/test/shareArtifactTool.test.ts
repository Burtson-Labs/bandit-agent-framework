/**
 * share_artifact agent tool. Properties: requires a target url/key, forwards the
 * expiry, and returns the external link + revoke token in its output. The URL
 * guard is the tool's own logic (no network); the success path exercises the
 * createShareLink wiring through an injected fetch.
 */
import { describe, it, expect } from 'vitest';
import { buildShareArtifactTool } from '../src/tools/shareArtifactTool';

const baseOpts = { token: 'jwt', s3ApiBaseUrl: 'https://s3' };

describe('buildShareArtifactTool', () => {
  it('errors (no network) when url is missing', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return { ok: true, status: 200, json: async () => ({}) } as Response; }) as unknown as typeof fetch;
    const tool = buildShareArtifactTool({ ...baseOpts, fetchImpl });
    const res = await tool.execute({}, {} as never);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/url/);
    expect(called).toBe(false);
  });

  it('mints a link: POSTs to /share with the parsed expiry, returns url + token', async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method, body: init?.body });
      return { ok: true, status: 200, json: async () => ({ url: 'https://s3/api/artifact/shared/tok', token: 'tok', expiresAt: '2026-09-12T00:00:00Z' }) } as Response;
    }) as unknown as typeof fetch;
    const tool = buildShareArtifactTool({ ...baseOpts, fetchImpl });
    const res = await tool.execute({ url: 'https://s3/api/artifact/team-1/a.html', expires: '7d' }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain('https://s3/api/artifact/shared/tok');
    expect(res.output).toContain('tok'); // revoke token surfaced
    expect(calls[0]).toMatchObject({ url: 'https://s3/api/artifact/share', method: 'POST' });
    expect(JSON.parse(calls[0].body!)).toEqual({ key: 'team-1/a.html', expiryMinutes: 7 * 24 * 60 });
  });

  it('surfaces server errors as a tool error, not a throw', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }), text: async () => 'boom' } as Response)) as unknown as typeof fetch;
    const tool = buildShareArtifactTool({ ...baseOpts, fetchImpl });
    const res = await tool.execute({ url: 'k' }, {} as never);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/Error creating share link/);
  });
});

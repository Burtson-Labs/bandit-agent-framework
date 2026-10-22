/**
 * The Bandit key must not travel in a URL (query strings land in proxy and
 * ingress logs). Validation POSTs it in the JSON body.
 */
import { describe, expect, it } from 'vitest';
import { validateBanditApiKey } from '../../src/helpers/accountApi';

describe('validateBanditApiKey', () => {
  it('sends the key in a POST body, not the URL', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ valid: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await validateBanditApiKey('  bai_fake_for_test  ', fetchImpl);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://auth.burtson.ai/api/keys/validate');
    expect(calls[0].url).not.toContain('bai_');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ key: 'bai_fake_for_test' });
  });

  it('makes no request for an empty key', async () => {
    let called = false;
    const r = await validateBanditApiKey('  ', (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });
});

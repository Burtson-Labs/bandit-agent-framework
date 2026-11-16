/**
 * resolveGatewayOrigin: where conversation recall sends its requests, and the
 * approval card line naming it.
 */
import { describe, it, expect } from 'vitest';
import { resolveGatewayOrigin } from '../../src/helpers/endpoints';
import { describeNetworkDestination } from '../../src/agent/networkDestination';

const config = (apiUrl?: string) => ({
  get<T>(key: string, fallback?: T): T {
    return (key === 'apiUrl' && apiUrl !== undefined ? apiUrl : fallback) as T;
  }
});

describe('resolveGatewayOrigin', () => {
  it('defaults to api.burtson.ai', () => {
    expect(resolveGatewayOrigin(config(), {})).toBe('https://api.burtson.ai');
  });
  it('takes the origin of a configured apiUrl, dropping its path', () => {
    expect(resolveGatewayOrigin(config('https://gw.example:8443/completions'), {})).toBe('https://gw.example:8443');
  });
  it('prefers BANDIT_GATEWAY_URL', () => {
    expect(resolveGatewayOrigin(config('https://gw.example/completions'), { BANDIT_GATEWAY_URL: 'http://localhost:5100/api' })).toBe('http://localhost:5100');
  });
  it('skips a malformed value', () => {
    expect(resolveGatewayOrigin(config('not a url'), { BANDIT_GATEWAY_URL: '::' })).toBe('https://api.burtson.ai');
  });
});

describe('approval card for conversation recall', () => {
  it('names the gateway host and the search words', async () => {
    const d = await describeNetworkDestination('search_conversations', { query: 'pricing plan' }, '/ws', undefined, 'https://gw.example');
    expect(d?.line).toBe('Searches your own synced Bandit chats on Bandit Cloud (gw.example) for: pricing plan');
  });
  it('names the conversation id when reading one', async () => {
    const d = await describeNetworkDestination('read_conversation', { id: 'c-1' }, '/ws', undefined, 'https://gw.example');
    expect(d?.line).toContain('(id c-1) from Bandit Cloud (gw.example)');
  });
});

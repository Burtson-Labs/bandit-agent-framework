/**
 * search_conversations + read_conversation. Properties: the right gateway path
 * and query, a `bai_` key exchanged for a gateway JWT before the call, a JWT
 * sent as-is, results formatted with ids and the read-the-thread nudge, the
 * scope line in both descriptions, failures by status, and no network call
 * for a missing argument.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSearchConversationsTool,
  buildReadConversationTool,
  RECALL_SCOPE_LINE
} from '../src/tools/conversationRecallTools';
import { NETWORK_TOOLS, isNetworkTool } from '../src/permissions';

interface Call { url: string; init?: RequestInit }

function fakeFetch(handler: (url: string) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const { status, body } = handler(String(url));
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      json: async () => JSON.parse(text),
      text: async () => text
    } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const searchBody = {
  query: 'pricing plan',
  results: [
    {
      id: 'c-1',
      title: 'Pricing for Team',
      updatedAt: '2026-11-10T12:00:00Z',
      turnCount: 6,
      snippet: { turnIndex: 2, role: 'user', text: '…settle on $20 a seat…' },
      matchedTerms: 2
    }
  ],
  hasMore: true,
  nextBefore: '2026-11-01T00:00:00Z'
};

const recallBody = {
  id: 'c-1',
  title: 'Pricing for Team',
  updatedAt: '2026-11-10T12:00:00Z',
  turnCount: 6,
  fromTurn: 4,
  turns: [
    { index: 4, question: 'So $20 a seat?', answer: 'Yes, $20 a seat with annual billing.' },
    { index: 5, question: 'And the trial?', answer: '14 days.', toolsUsed: ['web_search'] }
  ],
  hasEarlier: true,
  hasLater: false
};

describe('search_conversations', () => {
  it('calls the gateway search endpoint with the query and a gateway JWT', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: searchBody }));
    const tool = buildSearchConversationsTool({ token: 'eyJ.jwt', gatewayBaseUrl: 'https://api.example/', origin: 'vscode', fetchImpl });
    const res = await tool.execute({ query: 'pricing plan', limit: '99' }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://api.example/api/v1/conversations/search');
    expect(url.searchParams.get('q')).toBe('pricing plan');
    expect(url.searchParams.get('limit')).toBe('20'); // clamped
    expect(url.searchParams.has('before')).toBe(false);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer eyJ.jwt');
    expect(headers['x-bandit-origin']).toBe('vscode');
    expect(res.output).toContain('id=c-1');
    expect(res.output).toContain('"Pricing for Team"');
    expect(res.output).toContain('before="2026-11-01T00:00:00Z"');
    expect(res.output).toContain('call read_conversation');
    expect(res.output).toContain(RECALL_SCOPE_LINE);
  });

  it('exchanges a bai_ key at AuthApi before calling the gateway', async () => {
    const { calls, fetchImpl } = fakeFetch((url) =>
      url.endsWith('/api/keys/validate')
        ? { status: 200, body: { valid: true, gatewayToken: 'gw.jwt' } }
        : { status: 200, body: { query: 'x', results: [], hasMore: false } }
    );
    const tool = buildSearchConversationsTool({ token: 'bai_secret', gatewayBaseUrl: 'https://api.example', authBaseUrl: 'https://auth.example', fetchImpl });
    const res = await tool.execute({ query: 'x' }, {} as never);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/keys/validate', '/api/v1/conversations/search']);
    expect((calls[1].init?.headers as Record<string, string>).authorization).toBe('Bearer gw.jwt');
    expect(res.output).toContain('No synced Bandit conversations match "x"');
  });

  it('refuses an empty query without a network call', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: searchBody }));
    const tool = buildSearchConversationsTool({ token: 'jwt', gatewayBaseUrl: 'https://api.example', fetchImpl });
    const res = await tool.execute({ query: '  ' }, {} as never);
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('says to sign in again on 401 and when the key exchange fails', async () => {
    const unauth = fakeFetch(() => ({ status: 401, body: { error: 'nope' } }));
    const a = await buildSearchConversationsTool({ token: 'jwt', gatewayBaseUrl: 'https://api.example', fetchImpl: unauth.fetchImpl })
      .execute({ query: 'x' }, {} as never);
    expect(a.isError).toBe(true);
    expect(a.output).toContain('Sign in again');

    const rejected = fakeFetch(() => ({ status: 200, body: { valid: false, reason: 'revoked' } }));
    const b = await buildSearchConversationsTool({ token: 'bai_x', gatewayBaseUrl: 'https://api.example', fetchImpl: rejected.fetchImpl })
      .execute({ query: 'x' }, {} as never);
    expect(b.isError).toBe(true);
    expect(b.output).toContain('Sign in again');
    expect(rejected.calls).toHaveLength(1); // never reached the gateway
  });

  it('describes its reach: own synced Bandit chats, never other assistants', () => {
    const tool = buildSearchConversationsTool({ token: 'jwt', gatewayBaseUrl: 'https://api.example' });
    expect(tool.description).toContain("user's own past Bandit conversations");
    expect(tool.description).toContain('not history from other AI assistants');
    expect(tool.description).toContain('Do not guess from conversation titles');
  });
});

describe('read_conversation', () => {
  it('reads one conversation by id and formats a transcript', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: recallBody }));
    const tool = buildReadConversationTool({ token: 'jwt', gatewayBaseUrl: 'https://api.example', fetchImpl });
    const res = await tool.execute({ id: 'c/1', max_messages: '5', from_turn: '4' }, {} as never);
    expect(res.isError).toBeFalsy();
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v1/conversations/c%2F1/recall');
    expect(url.searchParams.get('maxMessages')).toBe('5');
    expect(url.searchParams.get('fromTurn')).toBe('4');
    expect(res.output).toContain('--- turn 4 ---');
    expect(res.output).toContain('User: So $20 a seat?');
    expect(res.output).toContain('Bandit: Yes, $20 a seat with annual billing.');
    expect(res.output).toContain('(Bandit used: web_search)');
    expect(res.output).toContain('Earlier turns exist');
  });

  it('explains a 404 instead of letting the model guess', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 404, body: '' }));
    const res = await buildReadConversationTool({ token: 'jwt', gatewayBaseUrl: 'https://api.example', fetchImpl })
      .execute({ id: 'nope' }, {} as never);
    expect(res.isError).toBe(true);
    expect(res.output).toContain('no such conversation in this account');
  });

  it('refuses a missing id without a network call', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: recallBody }));
    const res = await buildReadConversationTool({ token: 'jwt', gatewayBaseUrl: 'https://api.example', fetchImpl })
      .execute({}, {} as never);
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('conversation recall is a network tool', () => {
  it('is in NETWORK_TOOLS, so it asks by default and offline mode refuses it', () => {
    for (const name of ['search_conversations', 'read_conversation']) {
      expect(NETWORK_TOOLS.has(name), name).toBe(true);
      expect(isNetworkTool(name), name).toBe(true);
    }
  });
});

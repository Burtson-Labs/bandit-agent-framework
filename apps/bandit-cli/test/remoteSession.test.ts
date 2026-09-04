/**
 * RemoteSession — the live-session leg of remote control. Driven with a fake
 * fetch so the whole register → receive-remote-turn → mirror loop runs with no
 * network: registering returns a session id, a session-tagged inbox envelope
 * becomes a host prompt, and mirrored turns POST to the session's event stream.
 */
import { describe, it, expect } from 'vitest';
import { RemoteSession } from '@burtson-labs/host-kit';

interface Call { url: string; method: string; body?: unknown }

/** A fake fetch: registers a session, streams one SSE task, records posts. */
function makeFetch(opts: { sessionId: string; inboxTask?: object }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.endsWith('/api/stealth/runner/session') && method === 'POST') {
      return jsonResponse({ sessionId: opts.sessionId, mode: 'plan' });
    }
    if (url.endsWith('/api/stealth/runner/inbox') && method === 'GET') {
      // One task then the stream ends (the loop reconnects; the test aborts first).
      const lines = opts.inboxTask ? `data: ${JSON.stringify(opts.inboxTask)}\n\n` : '';
      return sseResponse(lines);
    }
    if (url.includes('/events') && method === 'POST') {
      return jsonResponse({ ok: true }, 202);
    }
    return jsonResponse({ error: 'unexpected' }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function baseOpts(fetchImpl: typeof fetch, onRemoteTurn: (p: string) => void) {
  return new RemoteSession({
    gatewayBase: 'https://gw.test',
    token: 'tok',
    deviceId: 'cli-test',
    deviceLabel: 'test',
    webBase: 'https://web.test',
    title: 'my project',
    mode: 'plan',
    onRemoteTurn
  }, fetchImpl);
}

describe('RemoteSession', () => {
  it('registers and exposes a continue URL', async () => {
    const { fetchImpl, calls } = makeFetch({ sessionId: 'sess1' });
    const s = baseOpts(fetchImpl, () => {});
    const url = await s.start();
    expect(s.id).toBe('sess1');
    expect(s.active).toBe(true);
    expect(url).toBe('https://web.test/remote/sess1');
    const reg = calls.find((c) => c.url.endsWith('/runner/session'));
    expect(reg?.body).toMatchObject({ deviceId: 'cli-test', title: 'my project', mode: 'plan' });
    s.stop();
    expect(s.active).toBe(false);
  });

  it('delivers a session-tagged inbox turn to onRemoteTurn', async () => {
    const received: string[] = [];
    const { fetchImpl } = makeFetch({
      sessionId: 'sess2',
      inboxTask: { protocol: 1, taskId: 'delivery1', prompt: 'fix the header', sessionId: 'sess2', mode: 'plan' }
    });
    const s = baseOpts(fetchImpl, (p) => received.push(p));
    await s.start();
    // Give the background inbox loop a tick to yield the task.
    await new Promise((r) => setTimeout(r, 20));
    s.stop();
    expect(received).toContain('fix the header');
  });

  it('ignores an inbox envelope for a DIFFERENT session', async () => {
    const received: string[] = [];
    const { fetchImpl } = makeFetch({
      sessionId: 'mine',
      inboxTask: { protocol: 1, taskId: 'd', prompt: 'not for me', sessionId: 'someone-else', mode: 'plan' }
    });
    const s = baseOpts(fetchImpl, (p) => received.push(p));
    await s.start();
    await new Promise((r) => setTimeout(r, 20));
    s.stop();
    expect(received).toEqual([]);
  });

  it('mirrors user + assistant to the session event stream', async () => {
    const { fetchImpl, calls } = makeFetch({ sessionId: 'sess3' });
    const s = baseOpts(fetchImpl, () => {});
    await s.start();
    await s.mirrorUser('what is this repo?');
    await s.mirrorAssistant('It is a TypeScript monorepo.');
    s.stop();
    const posts = calls.filter((c) => c.url.includes('/tasks/sess3/events') && c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toMatchObject({ type: 'user.message', text: 'what is this repo?', taskId: 'sess3' });
    expect(posts[1].body).toMatchObject({ type: 'assistant.delta', text: 'It is a TypeScript monorepo.', taskId: 'sess3' });
    // Never emits turn.completed for a session (would flip the container status).
    expect(posts.some((p) => (p.body as { type: string }).type === 'turn.completed')).toBe(false);
  });
});

/**
 * Contract tests for `buildCliChatFn` — the streaming-chat adapter
 * extracted out of cli.ts's runPrompt. Mirrors the extension's
 * apps/bandit-stealth/test/agent/chatFn.test.ts pattern.
 *
 * Each test is anchored to a load-bearing behavior of the inline
 * closure that historically lived in cli.ts. A test that breaks here
 * is signalling that the chat closure's contract has drifted, not
 * that the test is wrong — diff against the buildCliChatFn body line
 * by line before "fixing" the test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolLoopMessage } from '@burtson-labs/agent-core';
import {
  buildCliChatFn,
  getInflightChats,
  __resetChatModuleStateForTests,
  type CliChatFnDeps
} from '../src/agent/cliChatFn';

// The provider factory lives in stealth-core-runtime. We mock the
// `createProvider` entry so the chat closure uses a hand-rolled fake
// streaming provider without touching Ollama / network.
const fakeProviderChat = vi.fn();
vi.mock('@burtson-labs/stealth-core-runtime', () => ({
  createProvider: vi.fn(async () => ({
    chat: (...args: unknown[]) => fakeProviderChat(...args)
  }))
}));

interface FakeChunk {
  message?: { role?: string; content?: string; thinking?: string };
  done?: boolean;
}

function fakeStream(chunks: FakeChunk[], opts: { deferUntil?: Promise<void>; onReturn?: () => void } = {}) {
  return {
    [Symbol.asyncIterator](): AsyncIterator<FakeChunk> {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<FakeChunk>> {
          if (opts.deferUntil) await opts.deferUntil;
          if (i >= chunks.length) return { done: true, value: undefined as unknown as FakeChunk };
          return { done: false, value: chunks[i++] };
        },
        async return(): Promise<IteratorResult<FakeChunk>> {
          opts.onReturn?.();
          return { done: true, value: undefined as unknown as FakeChunk };
        }
      };
    }
  };
}

function makeDeps(overrides: Partial<CliChatFnDeps> = {}): CliChatFnDeps {
  return {
    settings: {} as CliChatFnDeps['settings'],
    model: 'test-model',
    pendingImages: undefined,
    getThink: () => undefined,
    onThinking: undefined,
    getAbortSignal: undefined,
    getWatchdogMs: () => 0, // disable watchdog by default; specific tests override
    ...overrides
  };
}

const oneMessage: ToolLoopMessage[] = [{ role: 'user', content: 'hi' }];

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of it) out.push(chunk);
  return out;
}

beforeEach(() => {
  fakeProviderChat.mockReset();
  __resetChatModuleStateForTests();
});

describe('buildCliChatFn — provider output streams verbatim', () => {
  it('yields message.content from each chunk in order, ignoring chunks with no content', () => {
    return (async () => {
      fakeProviderChat.mockImplementation(() =>
        fakeStream([
          { message: { content: 'hello ' } },
          { message: { content: '' } }, // no-content chunk — filtered
          { message: { content: 'world' }, done: true }
        ])
      );
      const chat = await buildCliChatFn(makeDeps());
      const out = await collect(chat(oneMessage, undefined, undefined));
      expect(out).toEqual(['hello ', 'world']);
    })();
  });

  it('treats a chunk with done:true as end-of-stream even if it has content', async () => {
    fakeProviderChat.mockImplementation(() =>
      fakeStream([
        { message: { content: 'one' } },
        { message: { content: 'final' }, done: true },
        { message: { content: 'NEVER-YIELDED' } } // after done
      ])
    );
    const chat = await buildCliChatFn(makeDeps());
    const out = await collect(chat(oneMessage, undefined, undefined));
    expect(out).toEqual(['one', 'final']);
  });
});

describe('buildCliChatFn — thinking channel routed to onThinking, not yielded as text', () => {
  it('passes message.thinking to the onThinking hook and never yields it as text', async () => {
    const seen: string[] = [];
    fakeProviderChat.mockImplementation(() =>
      fakeStream([
        { message: { content: '', thinking: 'tok1' } },
        { message: { content: '', thinking: 'tok2' } },
        { message: { content: 'real-content' }, done: true }
      ])
    );
    const chat = await buildCliChatFn(makeDeps({ onThinking: (chunk) => seen.push(chunk) }));
    const out = await collect(chat(oneMessage, undefined, undefined));
    expect(seen).toEqual(['tok1', 'tok2']);
    expect(out).toEqual(['real-content']);
  });

  it('does not crash when onThinking is omitted; thinking chunks are silently dropped', async () => {
    fakeProviderChat.mockImplementation(() =>
      fakeStream([
        { message: { content: '', thinking: 'ignored' } },
        { message: { content: 'content' }, done: true }
      ])
    );
    const chat = await buildCliChatFn(makeDeps());
    const out = await collect(chat(oneMessage, undefined, undefined));
    expect(out).toEqual(['content']);
  });
});

describe('buildCliChatFn — abort propagation', () => {
  it('throws USER_ABORT immediately when the signal is already aborted before the call starts (no provider.chat invoked)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    fakeProviderChat.mockImplementation(() => fakeStream([{ message: { content: 'NEVER' }, done: true }]));
    const chat = await buildCliChatFn(makeDeps({ getAbortSignal: () => ctrl.signal }));
    await expect(collect(chat(oneMessage, undefined, undefined))).rejects.toMatchObject({ code: 'USER_ABORT' });
    expect(fakeProviderChat).not.toHaveBeenCalled();
  });

  it('rejects with USER_ABORT mid-stream when the signal fires after the call started', async () => {
    const ctrl = new AbortController();
    let releaseHang = () => undefined as void;
    const hang = new Promise<void>((res) => { releaseHang = res; });
    fakeProviderChat.mockImplementation(() => fakeStream([{ message: { content: 'wont-arrive' }, done: true }], { deferUntil: hang }));
    const chat = await buildCliChatFn(makeDeps({ getAbortSignal: () => ctrl.signal }));
    const collectPromise = collect(chat(oneMessage, undefined, undefined));
    // Trigger the abort while iter.next() is hanging on the deferred chunk.
    setTimeout(() => ctrl.abort(), 10);
    await expect(collectPromise).rejects.toMatchObject({ code: 'USER_ABORT' });
    releaseHang();
  });
});

describe('buildCliChatFn — watchdog', () => {
  it('throws a WATCHDOG-tagged error when the watchdog fires before the first chunk arrives', async () => {
    let releaseHang = () => undefined as void;
    const hang = new Promise<void>((res) => { releaseHang = res; });
    fakeProviderChat.mockImplementation(() =>
      fakeStream([{ message: { content: 'too-late' }, done: true }], { deferUntil: hang })
    );
    // 1ms watchdog — fires before the deferred chunk ever resolves.
    // BANDIT_NO_TOKEN_WATCHDOG_MS env var takes precedence over the
    // getWatchdogMs callback, so set it for this case.
    const prev = process.env.BANDIT_NO_TOKEN_WATCHDOG_MS;
    process.env.BANDIT_NO_TOKEN_WATCHDOG_MS = '1';
    try {
      const chat = await buildCliChatFn(makeDeps());
      await expect(collect(chat(oneMessage, undefined, undefined))).rejects.toMatchObject({ code: 'WATCHDOG' });
    } finally {
      if (prev === undefined) delete process.env.BANDIT_NO_TOKEN_WATCHDOG_MS;
      else process.env.BANDIT_NO_TOKEN_WATCHDOG_MS = prev;
      releaseHang();
    }
  });

  it('disables the watchdog entirely when BANDIT_NO_TOKEN_WATCHDOG_MS=0', async () => {
    fakeProviderChat.mockImplementation(() =>
      fakeStream([{ message: { content: 'on-time' }, done: true }])
    );
    const prev = process.env.BANDIT_NO_TOKEN_WATCHDOG_MS;
    process.env.BANDIT_NO_TOKEN_WATCHDOG_MS = '0';
    try {
      const chat = await buildCliChatFn(makeDeps());
      const out = await collect(chat(oneMessage, undefined, undefined));
      expect(out).toEqual(['on-time']);
    } finally {
      if (prev === undefined) delete process.env.BANDIT_NO_TOKEN_WATCHDOG_MS;
      else process.env.BANDIT_NO_TOKEN_WATCHDOG_MS = prev;
    }
  });
});

describe('buildCliChatFn — per-turn image attachment', () => {
  it('attaches pendingImages on the first chat call only; subsequent calls leave the images field unset', async () => {
    const calls: { request: { images?: string[] } }[] = [];
    fakeProviderChat.mockImplementation((request: { images?: string[] }) => {
      calls.push({ request });
      return fakeStream([{ message: { content: 'ok' }, done: true }]);
    });
    const chat = await buildCliChatFn(makeDeps({ pendingImages: ['data:image/png;base64,AAA'] }));
    await collect(chat(oneMessage, undefined, undefined));
    await collect(chat(oneMessage, undefined, undefined));
    expect(calls[0].request.images).toEqual(['data:image/png;base64,AAA']);
    expect(calls[1].request.images).toBeUndefined();
  });

  it('never sets the images field when pendingImages is undefined', async () => {
    let captured: { images?: string[] } | undefined;
    fakeProviderChat.mockImplementation((request: { images?: string[] }) => {
      captured = request;
      return fakeStream([{ message: { content: 'ok' }, done: true }]);
    });
    const chat = await buildCliChatFn(makeDeps({ pendingImages: undefined }));
    await collect(chat(oneMessage, undefined, undefined));
    expect(captured?.images).toBeUndefined();
  });
});

describe('buildCliChatFn — think override precedence', () => {
  it('per-call think override wins over the session-level getter', async () => {
    let captured: { think?: boolean } | undefined;
    fakeProviderChat.mockImplementation((request: { think?: boolean }) => {
      captured = request;
      return fakeStream([{ message: { content: 'ok' }, done: true }]);
    });
    const chat = await buildCliChatFn(makeDeps({ getThink: () => true }));
    await collect(chat(oneMessage, undefined, { think: false }));
    expect(captured?.think).toBe(false);
  });

  it('falls back to the session getter when no per-call override is passed', async () => {
    let captured: { think?: boolean } | undefined;
    fakeProviderChat.mockImplementation((request: { think?: boolean }) => {
      captured = request;
      return fakeStream([{ message: { content: 'ok' }, done: true }]);
    });
    const chat = await buildCliChatFn(makeDeps({ getThink: () => true }));
    await collect(chat(oneMessage, undefined, undefined));
    expect(captured?.think).toBe(true);
  });

  it('omits the think field entirely when neither the session getter nor per-call override is set', async () => {
    let captured: { think?: boolean } | undefined;
    fakeProviderChat.mockImplementation((request: { think?: boolean }) => {
      captured = request;
      return fakeStream([{ message: { content: 'ok' }, done: true }]);
    });
    const chat = await buildCliChatFn(makeDeps());
    await collect(chat(oneMessage, undefined, undefined));
    expect('think' in (captured ?? {})).toBe(false);
  });
});

describe('buildCliChatFn — inflightChats bookkeeping', () => {
  it('decrements the inflight counter in the finally block even on error', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    fakeProviderChat.mockImplementation(() => fakeStream([]));
    const chat = await buildCliChatFn(makeDeps({ getAbortSignal: () => ctrl.signal }));
    await expect(collect(chat(oneMessage, undefined, undefined))).rejects.toMatchObject({ code: 'USER_ABORT' });
    expect(getInflightChats()).toBe(0);
  });

  it('decrements after a successful stream too', async () => {
    fakeProviderChat.mockImplementation(() =>
      fakeStream([{ message: { content: 'ok' }, done: true }])
    );
    const chat = await buildCliChatFn(makeDeps());
    await collect(chat(oneMessage, undefined, undefined));
    expect(getInflightChats()).toBe(0);
  });
});

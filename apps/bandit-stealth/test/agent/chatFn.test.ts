/**
 * Contract tests for `buildChatFn` — the streaming-chat closure extracted
 * out of performToolUseCompletion in Phase D #4.
 *
 * These tests pin the four most failure-prone behaviors the extraction
 * had to preserve. Each one is anchored to a specific past bug whose
 * recurrence would re-introduce a user-visible UX regression. A test
 * that breaks here is signalling that the chat closure's contract has
 * drifted, not that the test is wrong — diff against the buildChatFn
 * body line by line before "fixing" the test.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  AIChatRequest,
  AIChatResponse,
  ChatProvider
} from '@burtson-labs/stealth-core-runtime';
import type { ToolLoopMessage } from '@burtson-labs/agent-core';
import { buildChatFn, type ChatFnDeps } from '../../src/agent/chatFn';
import { TurnState } from '../../src/agent/turnState';
import type { ConversationEntry } from '../../src/services/conversationTypes';

function makeEntry(): ConversationEntry {
  return { id: 'a-1', role: 'assistant', content: '', timestamp: 0, payload: '' };
}

/**
 * Fake ChatProvider that yields a fixed sequence of AIChatResponse
 * chunks. Tracks whether `iterator.return()` was called so the
 * abort-cleanup contract can be verified.
 */
function makeFakeProvider(
  chunks: AIChatResponse[],
  opts: { onReturn?: () => void; deferUntil?: Promise<void> } = {}
): { provider: ChatProvider; returnCalled: () => boolean; capturedRequest: () => AIChatRequest | undefined } {
  let returned = false;
  let capturedRequest: AIChatRequest | undefined;
  const provider: ChatProvider = {
    chat(request: AIChatRequest): AsyncIterable<AIChatResponse> {
      capturedRequest = request;
      return {
        [Symbol.asyncIterator](): AsyncIterator<AIChatResponse> {
          let i = 0;
          return {
            async next(): Promise<IteratorResult<AIChatResponse>> {
              if (opts.deferUntil) await opts.deferUntil;
              if (i >= chunks.length) return { done: true, value: undefined as unknown as AIChatResponse };
              const value = chunks[i++];
              return { done: false, value };
            },
            async return(): Promise<IteratorResult<AIChatResponse>> {
              returned = true;
              opts.onReturn?.();
              return { done: true, value: undefined as unknown as AIChatResponse };
            }
          };
        }
      };
    }
  };
  return {
    provider,
    returnCalled: () => returned,
    capturedRequest: () => capturedRequest
  };
}

function makeDeps(provider: ChatProvider, overrides: Partial<ChatFnDeps> = {}): ChatFnDeps {
  return {
    state: new TurnState(makeEntry()),
    provider,
    model: 'test-model',
    temperature: 0.2,
    thinkOverride: undefined,
    turnImages: [],
    turnSignal: new AbortController().signal,
    getConfiguredWatchdogMs: () => 0, // disable watchdog by default; specific tests override
    setStatusMessage: vi.fn(),
    ...overrides
  };
}

const noMessages: ToolLoopMessage[] = [{ role: 'user', content: 'hi' }];

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of it) out.push(chunk);
  return out;
}

describe('buildChatFn — reasoning fence state machine', () => {
  it('opens the fence once on the first thinking chunk, keeps subsequent thinking inside, closes on the first real content chunk', async () => {
    // The pre-2026-04 regression: each thinking chunk was wrapped in
    // its own complete ```bandit-reasoning ... ``` fence, so a 17-token
    // reasoning burst rendered as 17 separate cards in the webview.
    // Fix: open once, append inside, close once on real content.
    const { provider } = makeFakeProvider([
      { message: { role: 'assistant', content: '', thinking: 'tok1' } },
      { message: { role: 'assistant', content: '', thinking: 'tok2' } },
      { message: { role: 'assistant', content: 'real' }, done: true }
    ]);
    const chat = buildChatFn(makeDeps(provider));
    const out = await collect(chat(noMessages, undefined, undefined));

    // The opening token carries the fence header; subsequent thinking
    // tokens are yielded bare (still INSIDE the open fence); the first
    // real content chunk emits the closer first, then the content
    // itself.
    expect(out).toEqual([
      '\n```bandit-reasoning\ntok1',
      'tok2',
      '\n```\n',
      'real'
    ]);
    // Regression guard: there must be exactly ONE opening fence in the
    // joined stream — not one per thinking token.
    const joined = out.join('');
    const openCount = (joined.match(/```bandit-reasoning/g) ?? []).length;
    expect(openCount).toBe(1);
  });

  it('whitespace-only content chunks do NOT close an open reasoning fence', async () => {
    // qwen3.6 (and probably others) streams chunks that pair a thinking
    // token with a `'\n'` content delta. The old code treated any
    // non-empty content as "fence over", so each thinking token got its
    // own complete fence (multi-card stacking). Fix: whitespace stays
    // inside the open fence; only `text.trim().length > 0` content
    // closes it. This test is the regression pin for that distinction.
    const { provider } = makeFakeProvider([
      { message: { role: 'assistant', content: '', thinking: 'tok' } },
      { message: { role: 'assistant', content: '\n' } },   // whitespace-only — must NOT close fence
      { message: { role: 'assistant', content: '   ' } },   // whitespace-only — must NOT close fence
      { message: { role: 'assistant', content: 'real' }, done: true }
    ]);
    const chat = buildChatFn(makeDeps(provider));
    const out = await collect(chat(noMessages, undefined, undefined));

    // The whitespace chunks yield through (they're emitted as content)
    // but they do NOT prepend a closer. Only the 'real' chunk does.
    expect(out).toEqual([
      '\n```bandit-reasoning\ntok',
      '\n',
      '   ',
      '\n```\n',
      'real'
    ]);
    // Regression guard: exactly one fence open and exactly one close.
    const joined = out.join('');
    expect((joined.match(/```bandit-reasoning/g) ?? []).length).toBe(1);
    expect((joined.match(/\n```\n/g) ?? []).length).toBe(1);
  });
});

describe('buildChatFn — abort signal', () => {
  it('aborts the stream cleanly with code=USER_ABORT and calls iterator.return on the provider', async () => {
    // The chat closure listens on turnSignal once and rejects the chat
    // when the user clicks the webview's Stop button. The catch path
    // must call iterator.return?.() so the provider's underlying fetch
    // is cleaned up (otherwise we leak open HTTP streams across turns).
    // Listener cleanup happens in finally.
    const controller = new AbortController();
    // `deferUntil` keeps the provider's iterator parked so we can fire
    // the abort BEFORE the first chunk arrives — i.e. simulate the
    // "abort during a long Ollama generation" path.
    let releaseProvider: (() => void) | undefined;
    const deferUntil = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const { provider, returnCalled } = makeFakeProvider(
      [{ message: { role: 'assistant', content: 'never reaches the consumer' }, done: true }],
      { deferUntil }
    );

    const chat = buildChatFn(makeDeps(provider, { turnSignal: controller.signal }));
    const it = chat(noMessages, undefined, undefined)[Symbol.asyncIterator]();
    // Kick off the first chunk request, then abort.
    const firstChunkPromise = it.next();
    controller.abort();
    // Release the parked provider iterator so the catch+finally
    // unwinds — otherwise the test hangs.
    releaseProvider?.();

    let caught: (Error & { code?: string }) | null = null;
    try {
      await firstChunkPromise;
      throw new Error('expected USER_ABORT rejection');
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('USER_ABORT');
    expect(caught?.message).toBe('aborted by user');
    // Cleanup contract: the provider's iterator.return() must have
    // been called so HTTP streams don't leak.
    expect(returnCalled()).toBe(true);
  });

  it('closes an open reasoning fence in the catch path before re-throwing on abort', async () => {
    // Live-test regression (post-v1.7.351): a turn aborted while
    // the model was emitting thinking tokens left an unclosed
    // ```bandit-reasoning fence in the assistant content. The
    // webview renders the content as one markdown doc, so the
    // next tool's bandit-tl marker landed INSIDE the leaked
    // fence. Fix: yield the closing fence in the catch block
    // before re-throwing, so the closer is delivered to the
    // consumer (agent-core's llm_chunk handler) before the error
    // propagates. The assistant content is guaranteed balanced.
    const controller = new AbortController();
    // First chunk arrives synchronously (opens the fence); the
    // second call is parked behind `releaseSecond` so we can fire
    // the abort while the fence is still open and the chat()
    // generator is waiting on the next chunk.
    let releaseSecond: (() => void) | undefined;
    const parkSecond = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let callCount = 0;
    const provider: ChatProvider = {
      chat(_request: AIChatRequest): AsyncIterable<AIChatResponse> {
        return {
          [Symbol.asyncIterator](): AsyncIterator<AIChatResponse> {
            return {
              async next(): Promise<IteratorResult<AIChatResponse>> {
                callCount += 1;
                if (callCount === 1) {
                  return {
                    done: false,
                    value: { message: { role: 'assistant', content: '', thinking: 'mid-reasoning-token' } }
                  };
                }
                await parkSecond;
                return { done: true, value: undefined as unknown as AIChatResponse };
              },
              async return(): Promise<IteratorResult<AIChatResponse>> {
                return { done: true, value: undefined as unknown as AIChatResponse };
              }
            };
          }
        };
      }
    };

    const chat = buildChatFn(makeDeps(provider, { turnSignal: controller.signal }));
    const iterator = chat(noMessages, undefined, undefined)[Symbol.asyncIterator]();

    // First chunk: the opening fence + thinking token. Verifies
    // setup: the fence is now open.
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toBe('\n```bandit-reasoning\nmid-reasoning-token');

    // Kick off the next chunk request, then abort mid-stream.
    const nextPromise = iterator.next();
    controller.abort();
    releaseSecond?.();

    // The catch path must yield the closer BEFORE the error
    // propagates. The consumer (a for-await loop) would see the
    // closer first, append it to the assistant content, then
    // catch the abort error on the next next() call.
    const second = await nextPromise;
    expect(second.done).toBe(false);
    expect(second.value).toBe('\n```\n');

    // Following next() rejects with USER_ABORT, terminating the
    // generator.
    let caught: (Error & { code?: string }) | null = null;
    try {
      await iterator.next();
      throw new Error('expected USER_ABORT rejection');
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    expect(caught?.code).toBe('USER_ABORT');
  });

  it('a pre-aborted turnSignal rejects immediately without calling provider.chat()', async () => {
    // If the user smashes Stop right before the next iteration kicks
    // off, the chat closure must reject before it ever opens a stream.
    // The guard at the top of buildChatFn handles this case.
    const controller = new AbortController();
    controller.abort();
    const chatSpy = vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined as unknown as AIChatResponse }) })
    }));
    const provider = { chat: chatSpy } as unknown as ChatProvider;
    const chat = buildChatFn(makeDeps(provider, { turnSignal: controller.signal }));

    let caught: (Error & { code?: string }) | null = null;
    try {
      for await (const _ of chat(noMessages, undefined, undefined)) {
        // unreachable
      }
      throw new Error('expected USER_ABORT rejection');
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    expect(caught?.code).toBe('USER_ABORT');
    // The aborted check fires BEFORE provider.chat() is invoked, so
    // we never even open the stream — saves a wasted HTTP request
    // when the user mashes Stop between iterations.
    expect(chatSpy).toHaveBeenCalledTimes(0);
  });
});

describe('buildChatFn — turnImages first-call-only', () => {
  it('attaches images on the first chat() and never on subsequent calls in the same turn', async () => {
    // The Ollama vision adapter rejects multi-turn images; if a
    // tool-result follow-up call re-attaches the user's image the
    // whole turn fails. `state.imagesAlreadySent` is the once-per-turn
    // latch that prevents this — moved to TurnState in Phase D #4
    // scaffolding so it survives the closure extraction.
    const state = new TurnState(makeEntry());
    const captured: AIChatRequest[] = [];
    const provider: ChatProvider = {
      chat(request: AIChatRequest): AsyncIterable<AIChatResponse> {
        captured.push(request);
        return {
          async *[Symbol.asyncIterator]() {
            yield { message: { role: 'assistant', content: 'ok' }, done: true };
          }
        };
      }
    };
    const chat = buildChatFn(makeDeps(provider, { state, turnImages: ['base64-image-1'] }));

    await collect(chat([{ role: 'user', content: 'describe' }], undefined, undefined));
    await collect(chat([{ role: 'user', content: 'and again' }], undefined, undefined));

    expect(captured.length).toBe(2);
    expect(captured[0].images).toEqual(['base64-image-1']);
    // The second call must NOT carry images, even though `turnImages`
    // is still in the closure scope — the `imagesAlreadySent` latch
    // suppresses it.
    expect(captured[1].images).toBeUndefined();
    expect(state.imagesAlreadySent).toBe(true);
  });
});

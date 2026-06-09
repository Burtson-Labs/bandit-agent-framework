import type { ChatFn, ToolLoopMessage } from '@burtson-labs/agent-core';
import type {
  AIChatRequest,
  AIChatResponse,
  ChatProvider
} from '@burtson-labs/stealth-core-runtime';

import { createNoTokenWatchdogError, resolveNoTokenWatchdog } from '../helpers/watchdog';
import type { TurnState } from './turnState';

/**
 * Inputs to `buildChatFn`. Splits the chat closure's captures into:
 *
 *  - `state`: per-turn mutable state owned by `TurnState`
 *    (`imagesAlreadySent`, `inflightChats`, `largePromptWatchdogNoticeShown`).
 *  - Per-turn constants: `model`, `temperature`, `thinkOverride`, `turnImages`,
 *    `provider`, `turnSignal`.
 *  - Provider-level callbacks: `getConfiguredWatchdogMs`, `setStatusMessage`.
 *
 * Everything else the closure needed lives in module-scope helpers
 * (`resolveNoTokenWatchdog`, `createNoTokenWatchdogError`) or `process.env`.
 */
export interface ChatFnDeps {
  state: TurnState;
  provider: ChatProvider;
  model: string;
  temperature: number;
  thinkOverride: boolean | undefined;
  turnImages: string[];
  turnSignal: AbortSignal;
  getConfiguredWatchdogMs: () => number | undefined;
  setStatusMessage: (text: string) => void;
}

/**
 * Build the `ChatFn` adapter that the tool-use loop calls for every chat
 * iteration of a turn. Adapts the streaming `ChatProvider.chat()` async
 * iterable into the loop's expected `(messages, tools, callOptions) =>
 * AsyncIterable<string>` shape and yields reasoning-fence-wrapped or plain
 * text chunks back to the loop.
 *
 * Load-bearing behaviors preserved byte-for-byte from the inline closure:
 *
 *  - **Reasoning fence state machine.** Opens a single
 *    ```` ```bandit-reasoning ```` fence on the first thinking token, keeps
 *    subsequent thinking tokens inside the open fence, and closes the fence
 *    the moment real content arrives. Whitespace-only content chunks
 *    (`text.trim().length === 0` — e.g. qwen3.6's `'\n'` deltas paired with
 *    reasoning tokens) DO NOT close the fence. This is what stopped the
 *    pre-2026-04 "reasoning-card stacking" bug where N reasoning tokens
 *    rendered as N separate `bandit-reasoning` cards instead of one. The
 *    fence is also defensively closed at the very end of the generator in
 *    case the stream ends without a `done: true` chunk (some gateway error
 *    paths).
 *
 *  - **No-token watchdog.** Each `iterator.next()` races against a timer
 *    sized by `resolveNoTokenWatchdog`; if the timer fires before the next
 *    chunk arrives, the chat rejects with a structured
 *    `createNoTokenWatchdogError` carrying model/peer/call-id telemetry.
 *    The timer is cleared after every chunk (success path) and in the
 *    finally block (failure path). Without this the chat can hang
 *    indefinitely on a stuck Ollama upstream.
 *
 *  - **Abort signal.** Listens once on `turnSignal` and rejects the chat
 *    on abort with `code === 'USER_ABORT'`. Pre-aborted signals reject
 *    immediately. The listener is removed in the finally block so we
 *    don't leak listeners across calls in the same turn.
 *
 *  - **`inflightChats` bump in try/finally.** Increments at the top of
 *    chat() and decrements in finally, so the early-throw path still
 *    decrements. The watchdog reads `inflightPeers: inflightChats` to
 *    widen its timeout when multiple chats are concurrent (parent +
 *    subagents).
 *
 *  - **`imagesAlreadySent` first-call only.** Flips to true after the
 *    first chat() call that attaches `turnImages`. Subsequent calls
 *    (tool-result follow-ups) must NOT re-attach images — the Ollama
 *    vision adapter rejects multi-turn images and the rest of the turn
 *    fails. The `turnImages.length > 0` guard handles the no-images
 *    case so the initial default-false on `state.imagesAlreadySent` is
 *    equivalent to the previous `let imagesAlreadySent = turnImages.length === 0`.
 *
 *  - **`largePromptWatchdogNoticeShown` once-per-turn.** A turn that
 *    fans out into many chat() calls (subagent loop) sees the watchdog
 *    notice at most once.
 *
 *  - **`iterator.return?.()` on error.** Best-effort cleanup of the
 *    provider's async iterator so partial streams don't pile up. Optional
 *    chaining matters — some providers don't implement `.return()`.
 *
 * Regressions in any of these are user-visible UX bugs, not refactor
 * misses. See `apps/bandit-stealth/test/agent/chatFn.test.ts` for the
 * contract tests pinning the most failure-prone of them.
 */
export function buildChatFn(deps: ChatFnDeps): ChatFn {
  const {
    state,
    provider,
    model,
    temperature,
    thinkOverride,
    turnImages,
    turnSignal,
    getConfiguredWatchdogMs,
    setStatusMessage
  } = deps;

  return async function* (
    messages: ToolLoopMessage[],
    tools,
    callOptions
  ): AsyncGenerator<string, void, unknown> {
    const request: AIChatRequest = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      temperature
    };
    // Per-call thinking override (single-shot, set by the loop's
    // recovery path) wins over the closure-captured user preference.
    // Loop sets `false` after reasoning-only retries exhaust.
    const effectiveThinkOverride =
      callOptions?.think !== undefined ? callOptions.think : thinkOverride;
    if (effectiveThinkOverride !== undefined) {
      request.think = effectiveThinkOverride;
    }
    if (!state.imagesAlreadySent && turnImages.length > 0) {
      request.images = turnImages;
      state.imagesAlreadySent = true;
    }
    if (tools && tools.length > 0) {
      // ToolUseLoop is in nativeTools mode — forward the schemas to
      // Ollama so the model's chat template serializes them in its
      // compact native format instead of our XML block.
      request.tools = tools as unknown as AIChatRequest['tools'];
    }
    const promptChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    const watchdog = resolveNoTokenWatchdog({
      promptChars,
      inflightPeers: state.inflightChats,
      envValue: process.env.BANDIT_NO_TOKEN_WATCHDOG_MS,
      configValue: getConfiguredWatchdogMs()
    });
    if (
      !state.largePromptWatchdogNoticeShown &&
      watchdog.source === 'auto' &&
      watchdog.ms > 75_000 &&
      (promptChars >= 80_000 || watchdog.inflightPeers >= 2)
    ) {
      state.largePromptWatchdogNoticeShown = true;
      const kb = Math.round(promptChars / 1024);
      const peerNote = watchdog.inflightPeers > 0
        ? ` + ${watchdog.inflightPeers} peer${watchdog.inflightPeers === 1 ? '' : 's'}`
        : '';
      setStatusMessage(`Watchdog sized to ${Math.round(watchdog.ms / 1000)}s for this turn (${kb} KB${peerNote})`);
    }
    if (turnSignal.aborted) {
      const err = new Error('aborted by user') as Error & { code?: string };
      err.code = 'USER_ABORT';
      throw err;
    }

    const callStartedAt = Date.now();
    const callId = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const peersAtStart = state.inflightChats;
    state.inflightChats += 1;
    let chunksReceived = 0;
    let thinkingChunks = 0;
    let contentChunks = 0;
    let firstChunkMs: number | null = null;
    let firstThinkingMs: number | null = null;
    let firstContentMs: number | null = null;
    // Streaming reasoning state machine — see the JSDoc on buildChatFn
    // for the load-bearing whitespace-vs-content distinction.
    let reasoningFenceOpen = false;
    const closeReasoningFence = (): string => {
      if (!reasoningFenceOpen) {return '';}
      reasoningFenceOpen = false;
      return '\n```\n';
    };
    const stream = provider.chat(request);
    const iterator = stream[Symbol.asyncIterator]();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearWatchdog = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const armWatchdog = (): Promise<never> | null => {
      if (watchdog.ms === 0) {return null;}
      return new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(createNoTokenWatchdogError({
            elapsedMs: watchdog.ms,
            model: request.model,
            think: request.think,
            messages: messages.length,
            promptChars,
            chunksReceived,
            thinkingChunks,
            contentChunks,
            firstChunkMs,
            firstThinkingMs,
            firstContentMs,
            peersAtStart,
            inflightNow: state.inflightChats,
            callId,
            verbose: /^(1|true)$/i.test(process.env.BANDIT_VERBOSE ?? '')
          }));
        }, watchdog.ms);
      });
    };
    let abortListener: (() => void) | null = null;
    const abortPromise = new Promise<never>((_, reject) => {
      if (turnSignal.aborted) {
        const err = new Error('aborted by user') as Error & { code?: string };
        err.code = 'USER_ABORT';
        reject(err);
        return;
      }
      abortListener = () => {
        const err = new Error('aborted by user') as Error & { code?: string };
        err.code = 'USER_ABORT';
        reject(err);
      };
      turnSignal.addEventListener('abort', abortListener, { once: true });
    });
    const clearAbortListener = () => {
      if (abortListener) {
        turnSignal.removeEventListener('abort', abortListener);
        abortListener = null;
      }
    };
    try {
      while (true) {
        const races: Promise<unknown>[] = [iterator.next()];
        const watchdogPromise = armWatchdog();
        if (watchdogPromise) {races.push(watchdogPromise);}
        races.push(abortPromise);
        const result = (await Promise.race(races)) as IteratorResult<AIChatResponse>;
        clearWatchdog();
        if (result.done) {break;}

        const chunk = result.value;
        chunksReceived += 1;
        if (firstChunkMs === null) {firstChunkMs = Date.now() - callStartedAt;}
        // Stream chain-of-thought reasoning as a `bandit-reasoning`
        // fence so the webview renders it in a collapsed disclosure
        // block. Emitted before content so the reasoning lands above
        // the answer in transcript order.
        const reasoning = chunk.message?.thinking;
        if (reasoning) {
          thinkingChunks += 1;
          if (firstThinkingMs === null) {firstThinkingMs = Date.now() - callStartedAt;}
          if (!reasoningFenceOpen) {
            reasoningFenceOpen = true;
            yield `\n\`\`\`bandit-reasoning\n${reasoning}`;
          } else {
            yield reasoning;
          }
        }
        const text = chunk.message?.content ?? '';
        if (text) {
          contentChunks += 1;
          if (firstContentMs === null) {firstContentMs = Date.now() - callStartedAt;}
          // Close any open reasoning fence before emitting REAL
          // content — but NOT when the chunk is whitespace-only.
          // qwen3.6 (and probably others) streams chunks that pair
          // a thinking token with a `'\n'` content delta. The old
          // code treated any non-empty content as "fence over",
          // so each thinking token got its own complete fence and
          // the webview rendered N separate `bandit-reasoning`
          // cards instead of one. Whitespace stays inside the
          // open reasoning fence; meaningful content closes it.
          if (text.trim().length > 0) {
            const closer = closeReasoningFence();
            if (closer) {yield closer;}
          }
          yield text;
        }
        if (chunk.done) {
          const closer = closeReasoningFence();
          if (closer) {yield closer;}
          break;
        }
      }
    } catch (error) {
      // Close any open reasoning fence BEFORE re-throwing. Without
      // this, an abort or transient error mid-thinking leaks an
      // unclosed ```bandit-reasoning fence into the assistant
      // content. The webview renders the content as one markdown
      // doc, so an unclosed fence captures every subsequent
      // append — retry attempts, status messages, tool-execute
      // bandit-tl markers — as reasoning text instead of as the
      // chat panel's real surface. Live-test pattern that surfaced
      // this: a turn aborted mid-reasoning ended with the fence
      // still open, and the next tool's bandit-tl marker landed
      // inside it. The yielded closer is delivered to the
      // consumer (agent-core's llm_chunk handler) before the
      // error propagates, so the assistant content always ends
      // with a balanced fence regardless of the failure path.
      if (reasoningFenceOpen) {
        yield closeReasoningFence();
      }
      try {
        await iterator.return?.();
      } catch {
        // best-effort provider cleanup
      }
      throw error;
    } finally {
      clearWatchdog();
      clearAbortListener();
      state.inflightChats = Math.max(0, state.inflightChats - 1);
    }
    // Defensive: if the stream ended without a `done` chunk (some
    // gateway error paths) make sure the fence isn't left open.
    const trailingClose = closeReasoningFence();
    if (trailingClose) {yield trailingClose;}
  };
}

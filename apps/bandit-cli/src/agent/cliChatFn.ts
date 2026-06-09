/**
 * CLI-side `ChatFn` adapter — counterpart to the extension's
 * `apps/bandit-stealth/src/agent/chatFn.ts`. Builds the streaming
 * provider → tool-use-loop adapter used by every chat call in the CLI's
 * runPrompt path.
 *
 * Load-bearing behaviors preserved byte-for-byte from the inline closure
 * that historically lived in cli.ts:
 *
 *  - **Per-turn image attachment.** Images attached to the turn (via
 *    @-mention of a PNG/JPG) are sent on the FIRST chat call only;
 *    subsequent tool-loop iterations don't re-send them. Mirrors the
 *    extension's `imagesAlreadySent` pattern.
 *
 *  - **No-token watchdog with auto-scale + overrides.** Each iter.next()
 *    races against a watchdog timer. Sizing follows env var >
 *    config/slash override > formula precedence, where the formula is
 *    `max(120s + peerHeadroom, min(300s, 2ms/char + peerHeadroom))`
 *    with `peerHeadroom = inflightChats * 25s`. The first time a chat
 *    call crosses the large-prompt OR multi-peer threshold, a one-shot
 *    informational note is emitted to stdout naming the watchdog
 *    deadline and the override env var.
 *
 *  - **Pre-call abort short-circuit.** If the turn's signal is already
 *    aborted before this chat call, throw `USER_ABORT` immediately
 *    without spinning up a provider.chat().
 *
 *  - **Mid-stream abort race.** iter.next() races against the turn's
 *    signal so Esc during a first-token hang propagates without
 *    waiting for the watchdog. Listener is detached in the finally
 *    block whether the stream completed normally, errored, or was
 *    aborted.
 *
 *  - **Thinking channel routed to onThinking.** Provider yields
 *    `message.thinking` separately from `message.content`. We route
 *    thinking through the caller's hook (so it can coordinate spinner
 *    state) and yield only content text to the loop.
 *
 *  - **inflightChats bookkeeping.** Module-level counter incremented
 *    on every chat start and decremented in the finally block. Used by
 *    the watchdog auto-scale formula AND by the large-prompt notice
 *    threshold, AND surfaced in watchdog telemetry.
 */
import {
  createProvider,
  type ProviderSettings
} from '@burtson-labs/stealth-core-runtime';
import type { ChatFn, ToolLoopMessage } from '@burtson-labs/agent-core';
import { c, glyph } from '../ansi';

// Module-level concurrency counter — tracks how many chat streams are
// inflight from this CLI process at any given moment. Used in the
// watchdog telemetry so we can tell apart "model is genuinely stuck"
// from "Ollama is queueing because of >1 concurrent stream from
// background subagents." Increments on stream start, decrements in the
// finally block.
let inflightChats = 0;

// one-shot per-session flag so the large-prompt warning only fires the
// FIRST time a chat call exceeds the threshold. After that the user
// already knows; nagging on every call would be noise.
let largePromptWarningShown = false;
const LARGE_PROMPT_BYTES = 80_000;

/**
 * Test-only reset of the module-level counters. Lets contract tests
 * pin behavior that depends on "first call in process" — the one-shot
 * large-prompt notice — without leaking state between describe blocks.
 */
export function __resetChatModuleStateForTests(): void {
  inflightChats = 0;
  largePromptWarningShown = false;
}

/**
 * Read the current inflight chat count. Exposed for tests + diagnostic
 * surfaces (the `/diag` slash command's peer report).
 */
export function getInflightChats(): number {
  return inflightChats;
}

export interface CliChatFnDeps {
  settings: ProviderSettings;
  model: string;
  /** Images attached to this turn (via @-mention). Sent on the first
   * chat call only; undefined/empty means "no images this turn". */
  pendingImages: string[] | undefined;
  /** Returns the per-session `think` override. Called on EVERY chat
   * request so `/think on` takes effect without rebuilding the
   * provider. `undefined` falls back to runtime default. */
  getThink: () => boolean | undefined;
  /** Thinking delta handler. Required for spinner coordination — the
   * provider yields message.thinking separately from message.content
   * for reasoning-capable models and direct stdout writes collide
   * with the spinner. Omit to silently drop thinking. */
  onThinking?: (chunk: string) => void;
  /** Returns the active turn's AbortSignal so the chat closure can
   * race iter.next() against an abort fire. Read on EVERY chat call
   * because the controller is per-turn. */
  getAbortSignal?: () => AbortSignal | undefined;
  /** Returns the session-level watchdog override (ms). Read on every
   * chat call so `/watchdog off` / `/watchdog 120s` takes effect
   * mid-session. `undefined` means "no override — use the formula". */
  getWatchdogMs?: () => number | undefined;
}

export async function buildCliChatFn(deps: CliChatFnDeps): Promise<ChatFn> {
  const { settings, model, pendingImages, getThink, onThinking, getAbortSignal, getWatchdogMs } = deps;
  const provider = await createProvider(settings);
  // Images attached to this turn (via @-mention of a PNG/JPG/etc.) are
  // forwarded on the FIRST chat call only — subsequent tool-loop
  // iterations shouldn't re-send the same bytes and re-bloat the prompt.
  // Mirrors the extension.ts `imagesAlreadySent` pattern.
  let imagesAlreadySent = !pendingImages || pendingImages.length === 0;
  return async function* (messages: ToolLoopMessage[], tools, callOptions) {
    const request: {
      model: string;
      messages: { role: string; content: string }[];
      stream: boolean;
      temperature: number;
      tools?: unknown;
      images?: string[];
      think?: boolean;
    } = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      temperature: 0.2,
      // When ToolUseLoop is in nativeTools mode, it passes the schemas
      // on every chat call. Forward to the provider which will route to
      // Ollama's native `tools` field (model's chat template handles
      // schema serialization — ~30-50% fewer tokens than our XML block).
      tools
    };
    if (!imagesAlreadySent && pendingImages && pendingImages.length > 0) {
      request.images = pendingImages;
      imagesAlreadySent = true;
    }
    // Per-call thinking override (single-shot, set by the loop's
    // recovery path) wins over the session-level preference. Loop
    // sets `false` after reasoning-only retries exhaust to break
    // models out of thinking-only stalls. Mirrors the extension's
    // chat closure handling for parity across hosts.
    const sessionThinkOverride = getThink();
    const effectiveThink =
      callOptions?.think !== undefined ? callOptions.think : sessionThinkOverride;
    if (effectiveThink !== undefined) {
      request.think = effectiveThink;
    }

    // NOTE: the existing Spinner (spinner.ts, started from runPrompt)
    // already provides the "model is busy" animation with playful
    // rotating verbs ("rummaging", "pondering", etc). We deliberately
    // do NOT start a second ticker here — it would race the existing
    // one on the same \r line and cause the flicker observed
    // 2026-04-24.
    //
    // No-token watchdog: abort the stream when the model has gone
    // quiet for `WATCHDOG_MS` without producing either content or
    // thinking. Without this, a model that gets stuck mid-reasoning
    // ( with gemma4:e4b on an open-ended
    // creative ask: zero `llm_chunk` events emitted, spinner span
    // for minutes with nothing to show the user) leaves the user
    // staring at a dead spinner with no signal that anything is
    // wrong. Any chunk — content OR thinking — resets the timer so
    // genuinely-slow models that are still producing tokens aren't
    // killed. Override via BANDIT_NO_TOKEN_WATCHDOG_MS=0 to disable
    // entirely or =N to tune for a slow cold-load.
    // Hoisted up from below so the watchdog can scale with prompt size.
    const promptChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    // precedence: env var > config/slash override > auto-scale.
    // The env override is per-shell (diagnostic sessions); the config
    // override (via /watchdog or ~/.bandit/config.json watchdogMs) is
    // persistent. Both bypass the auto-scale formula.
    const envParsed = Number.parseInt(process.env.BANDIT_NO_TOKEN_WATCHDOG_MS ?? '', 10);
    const envOverride = Number.isFinite(envParsed) && envParsed >= 0;
    const watchdogMs = envOverride ? envParsed : 0;
    const configOverrideRaw = !envOverride ? getWatchdogMs?.() : undefined;
    const configOverride = typeof configOverrideRaw === 'number'
      && Number.isFinite(configOverrideRaw)
      && configOverrideRaw >= 0;
    // Watchdog sizing: 120s floor + 2ms/char + 300s cap, plus 25s per
    // concurrent in-flight stream (the gateway serializes first-token
    // windows so each peer adds queue depth). The floor covers fixed
    // overhead; the per-char term scales with model prefill time on
    // large prompts (~0.5-1ms/char on a 27B Q4 model). Env override
    // (BANDIT_NO_TOKEN_WATCHDOG_MS) and config override win in that order.
    const peers = Math.max(0, inflightChats);
    const peerHeadroomMs = peers * 25_000;
    const baselineMs = 120_000 + peerHeadroomMs;
    const WATCHDOG_MS = envOverride
      ? watchdogMs
      : configOverride
        ? (configOverrideRaw as number)
        : Math.max(baselineMs, Math.min(300_000, (promptChars * 2) + peerHeadroomMs));

    // Telemetry — request start time, updated as chunks arrive, dumped
    // on watchdog fire to distinguish "model is stuck" from "gateway
    // queueing", "first-token prefill latency", and "thinking-only
    // model never emits a non-thinking chunk".
    const callStartedAt = Date.now();
    if (
      !largePromptWarningShown &&
      (promptChars >= LARGE_PROMPT_BYTES || peers >= 2) &&
      WATCHDOG_MS > 75_000 &&
      !envOverride
    ) {
      largePromptWarningShown = true;
      const kb = Math.round(promptChars / 1024);
      const watchdogSec = Math.round(WATCHDOG_MS / 1000);
      const peerNote = peers > 0 ? ` (+${peers} peer${peers === 1 ? '' : 's'})` : '';
      process.stdout.write(
        '\n' +
        c.dim(`  ${glyph.info} watchdog sized to ${watchdogSec}s for this turn (~${kb} KB${peerNote}). `) +
        c.dim(`Override: `) + c.cyan(`BANDIT_NO_TOKEN_WATCHDOG_MS=N`) +
        c.dim(` (ms; 0 to disable)`) +
        '\n'
      );
    }
    const myCallId = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    inflightChats += 1;
    const peersAtStart = inflightChats - 1;
    let chunksReceived = 0;
    let thinkingChunks = 0;
    let contentChunks = 0;
    let firstChunkAt: number | null = null;
    let firstThinkingAt: number | null = null;
    let firstContentAt: number | null = null;

    // abort short-circuit. If the turn was already aborted
    // before this chat call even started, bail with the same shape as
    // a mid-stream abort. Without this, a queued line whose turn was
    // cancelled in flight would still spin up a new provider.chat().
    const preStartSignal = getAbortSignal?.();
    if (preStartSignal?.aborted) {
      inflightChats = Math.max(0, inflightChats - 1);
      const err = new Error('aborted by user') as Error & { code?: string };
      err.code = 'USER_ABORT';
      throw err;
    }

    const stream = provider.chat(request as never);
    const iter = stream[Symbol.asyncIterator]();
    let timer: NodeJS.Timeout | null = null;
    const armTimer = (resetReject: (err: Error) => void): Promise<never> | null => {
      if (WATCHDOG_MS === 0) return null;
      return new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const elapsed = (WATCHDOG_MS / 1000).toFixed(0);
          const ttfc = firstChunkAt !== null ? `${firstChunkAt}ms` : 'NEVER';
          const ttft = firstThinkingAt !== null ? `${firstThinkingAt}ms` : 'NEVER';
          const ttcontent = firstContentAt !== null ? `${firstContentAt}ms` : 'NEVER';
          const diag = [
            `model=${request.model}`,
            `think=${request.think === undefined ? 'default' : String(request.think)}`,
            `messages=${messages.length}`,
            `promptChars=${promptChars}`,
            `chunks=${chunksReceived}(content=${contentChunks},thinking=${thinkingChunks})`,
            `ttfc=${ttfc}`,
            `ttft=${ttft}`,
            `ttcontent=${ttcontent}`,
            `peersAtStart=${peersAtStart}`,
            `inflightNow=${inflightChats}`,
            `callId=${myCallId}`
          ].join(' ');
          // friendlier error. Lead with what happened
          // and what to do. Hide the diagnostic stack behind
          // BANDIT_VERBOSE=1 so the everyday user isn't dropped
          // into a wall of telemetry. The retry hint is the
          // load-bearing message — first-token watchdog fires are
          // almost always cold-load / network blips that recover
          // on the next attempt.
          const verbose = /^(1|true)$/i.test(process.env.BANDIT_VERBOSE ?? '');
          const tail = verbose
            ? ` [${diag}]`
            : '';
          const friendly = `The model server didn't respond within ${elapsed}s. Most often this is a cold-load or a transient gateway blip — retrying usually works. To extend the watchdog: export BANDIT_NO_TOKEN_WATCHDOG_MS=120000 (2m) or =0 to disable. For diagnostics: BANDIT_VERBOSE=1.${tail}`;
          // tag the error so the REPL queue-worker can detect
          // a string of dead-server calls and stop draining the queue
          // instead of grinding every queued message through the same
          // 90-second watchdog. Without the tag, watchdog errors look
          // identical to model-output errors and consecutive-failure
          // detection can't tell them apart.
          const watchdogErr = new Error(friendly) as Error & { code?: string };
          watchdogErr.code = 'WATCHDOG';
          resetReject(watchdogErr);
          reject(new Error('watchdog'));
        }, WATCHDOG_MS);
      });
    };
    const clearWatchdog = () => { if (timer) { clearTimeout(timer); timer = null; } };
    // per-call abort race. Watch the active turn's signal
    // and reject the iter.next() race when it fires. Without this,
    // a first-token hang locks up the call until the watchdog times
    // out (~75-240s depending on prompt size) even though the user
    // has pressed Esc and expected immediate cancellation. The race
    // gives Esc the same fast-path the watchdog already enjoys.
    const turnSignal = getAbortSignal?.();
    let abortListener: (() => void) | null = null;
    const abortPromise: Promise<never> | null = turnSignal
      ? new Promise<never>((_, reject) => {
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
        })
      : null;
    const clearAbortListener = () => {
      if (turnSignal && abortListener) {
        turnSignal.removeEventListener('abort', abortListener);
        abortListener = null;
      }
    };
    try {
      while (true) {
        let stallReject: (err: Error) => void = () => undefined;
        const stallSignal = new Promise<never>((_, reject) => { stallReject = reject; });
        const watchdogPromise = armTimer(stallReject);
        try {
          // Race: iter.next() vs watchdog (timeout) vs abort (Esc/user).
          // Empty array spreads collapse cleanly when watchdog or abort
          // is disabled (env override / no signal supplied).
          const races: Promise<unknown>[] = [iter.next()];
          if (watchdogPromise) races.push(watchdogPromise, stallSignal);
          if (abortPromise) races.push(abortPromise);
          const next = races.length > 1 ? Promise.race(races) : races[0];
          const result = (await next) as IteratorResult<{ message?: { content?: string; thinking?: string }; done?: boolean }>;
          clearWatchdog();
          if (result.done) break;
          const chunk = result.value;
          chunksReceived += 1;
          if (firstChunkAt === null) firstChunkAt = Date.now() - callStartedAt;
          // Chain-of-thought from the provider's structured `thinking`
          // field. Routed through the caller's onThinking hook so it can
          // coordinate with the spinner — direct stdout writes here
          // previously collided with the spinner's \r\x1b[2K redraws and
          // produced garbled fragments ( on
          // bandit-logic / Qwen 3.6).
          const thinking = chunk.message?.thinking;
          if (thinking) {
            thinkingChunks += 1;
            if (firstThinkingAt === null) firstThinkingAt = Date.now() - callStartedAt;
            onThinking?.(thinking);
          }
          const text = chunk.message?.content ?? '';
          if (text) {
            contentChunks += 1;
            if (firstContentAt === null) firstContentAt = Date.now() - callStartedAt;
            yield text;
          }
          if (chunk.done) break;
        } catch (err) {
          clearWatchdog();
          // Surface the watchdog message to the user via the same
          // path the spinner uses; the loop above will see the
          // generator throw and end the iteration with whatever
          // text was already yielded.
          throw err;
        }
      }
    } finally {
      clearWatchdog();
      clearAbortListener();
      inflightChats = Math.max(0, inflightChats - 1);
    }
  };
}

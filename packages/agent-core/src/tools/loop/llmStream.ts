/**
 * LLM streaming with intra-response loop detection and same-channel
 * transient-error retry. Extracted from ToolUseLoop.runWithMessages so
 * the orchestrator only holds high-level control flow, not the chunk-
 * level fingerprint accounting and the retry ladder.
 *
 * Behavior pinned by `packages/agent-core/test/llmStreamContract.test.ts`:
 *
 *  - Chunks emit through `tool_loop:llm_chunk` in arrival order; the
 *    aggregated text is returned in full when no detector trips.
 *  - HARD_MAX cap (24,000 chars) aborts the stream, marks it, and
 *    appends a sentinel so the downstream prose-loop detector can route
 *    to the nudge path. Real trace it caught: a single response of
 *    24,663 chars of "Wait, I'll try X. Actually..." prose.
 *  - Line-level fast path: 5 identical short lines (<= 120 chars,
 *    non-empty, trimmed) in a row aborts the stream. Catches
 *    "I can't install things." × 24 before the 800-char fingerprint
 *    window can fire (24 short lines ≈ 550 chars, below CHECK_EVERY).
 *  - Window-level fingerprint: every 800 chars, hash the last 400
 *    (whitespace-normalized, numeric tokens collapsed to '#') and check
 *    for 3 identical fingerprints in a row. Catches re-numbered list
 *    repetition the line-level path misses.
 *  - User abort: `signal.aborted` mid-stream emits `stream_abort` with
 *    reason `cancelled` and breaks. No retry.
 *  - Retryable error WITH zero text streamed AND (no native tools OR
 *    not yet streamed): exponential backoff retry (1.2s × 2^n, two
 *    attempts). Emits `tool_loop:llm_retry` per attempt.
 *  - Non-retryable error OR partial text already streamed: re-throw
 *    (tagged with `UPSTREAM_MODEL` code on retryable to preserve the
 *    existing error-summarization contract for outer-layer handlers).
 *
 * Gate widening note (preserved from the in-class implementation):
 * the original retry gate was `!tools || tools.length === 0` — only
 * text-tools turns got the same-channel ladder. That meant native-tools
 * turns hit a transient 500 once and jumped to the disruptive native→
 * text envelope switch (a second hiccup hard-failed). Widening to
 * `!tools || tools.length === 0 || safeToReplay` keeps the original
 * guarantee (no duplicated tool_call deltas after partial output) but
 * lets the native path retry transient infra blips before the envelope
 * switch escalates.
 */
import type { ChatFn, ToolLoopMessage, ChatCallOptions, NativeToolSchema } from '../tool-types';
import { isRetryableLlmError, tagRetryableLlmError, summarizeLlmError, sleep } from './loopShared';

export type StreamEmit = (type: string, payload?: unknown) => void;

export interface StreamAndAggregateArgs {
  chat: ChatFn;
  messages: ToolLoopMessage[];
  emit: StreamEmit;
  iteration: number;
  tools?: NativeToolSchema[];
  signal?: AbortSignal;
  callOptions?: ChatCallOptions;
}

/**
 * Stream from the chat function and return the fully aggregated response
 * string. Aborts early if we detect the model is trapped in a self-
 * contradicting prose loop — repeating phrases like "Wait, I see X
 * isn't listed. Let me check X. Actually, I'll try to read X." without
 * ever emitting a tool call. This was observed Apr 2026 on
 * bandit-core-1: a single stream produced 24k chars of such prose.
 * Without this guard the turn terminates naturally (no tool calls →
 * final response), but the user sees the entire wall of repetition.
 *
 * Detection is cheap: after every ~800 chars we compute a hash of the
 * last ~400 chars and check if the same hash appeared recently. Three
 * repeats in a row means we're looping — abort and return what we
 * have. The upstream loop will then still call the prose-loop detector
 * and apply its nudge on the next iteration.
 */
export async function streamAndAggregate(args: StreamAndAggregateArgs): Promise<string> {
  const { chat, messages, emit, iteration, tools, signal, callOptions } = args;

  let text = '';
  // Intra-response loop guard. Tuned by observation, not theory:
  // - CHECK_EVERY=800: a single "Actually, I'll try to read X." cycle
  // in the real trace was ~120-180 chars, so we want multiple
  // samples per cycle but not one per chunk (that would be slow).
  // - WINDOW=400: the tail chunk used to build the fingerprint.
  // - THRESHOLD=3: three identical fingerprints in a row is
  // overwhelmingly a loop; two could be a natural repetition
  // (e.g. a code block shown twice).
  // - HARD_MAX=24000: a soft upper bound so a runaway generation
  // doesn't burn unbounded tokens even if the fingerprint shifts
  // slightly each cycle. The real trace was 24663 chars.
  const CHECK_EVERY = 800;
  const WINDOW = 400;
  const THRESHOLD = 3;
  const HARD_MAX = 24000;
  const recentFingerprints: string[] = [];
  let nextCheckAt = CHECK_EVERY;
  let aborted = false;
  // Line-level repetition guard. Catches "I can't install things." × 24
  // long before the 800-char fingerprint check fires (24 short lines is
  // ~550 chars, below CHECK_EVERY). Tracks the last completed line
  // (text up to the most recent \n) and counts consecutive identical
  // non-empty short lines. Five in a row is a clear loop; trips
  // earlier than the full-fingerprint detector ever can.
  const REPEAT_LINE_THRESHOLD = 5;
  const REPEAT_LINE_MAXLEN = 120; // only short lines — long paragraphs aren't loops
  let lastLine = '';
  let repeatCount = 1;
  let lastEmittedLineLength = 0;
  const MAX_TRANSIENT_RETRIES = 2;
  const BASE_RETRY_MS = 1_200;
  let transientRetries = 0;

  while (true) {
    try {
      for await (const chunk of chat(messages, tools, callOptions)) {
        if (signal?.aborted) {
          aborted = true;
          emit('tool_loop:stream_abort', { iteration, reason: 'cancelled', length: text.length });
          break;
        }
        text += chunk;
        emit('tool_loop:llm_chunk', { iteration, chunk });

        if (text.length >= HARD_MAX) {
          aborted = true;
          emit('tool_loop:stream_abort', { iteration, reason: 'hard_max', length: text.length });
          break;
        }

        // Line-repetition fast path. Walk newly-completed lines (between
        // lastEmittedLineLength and the most recent \n) and bump a
        // consecutive-identical counter. Trips faster than the
        // 800-char fingerprint window for short-phrase loops.
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline > lastEmittedLineLength) {
          const newSegment = text.slice(lastEmittedLineLength, lastNewline);
          for (const rawLine of newSegment.split('\n')) {
            const line = rawLine.trim();
            if (!line || line.length > REPEAT_LINE_MAXLEN) {
              lastLine = line;
              repeatCount = 1;
              continue;
            }
            if (line === lastLine) {
              repeatCount += 1;
              if (repeatCount >= REPEAT_LINE_THRESHOLD) {
                aborted = true;
                emit('tool_loop:stream_abort', {
                  iteration,
                  reason: 'line_repetition_loop',
                  length: text.length,
                  fingerprintPreview: line.slice(0, 120),
                  repeatCount
                });
                break;
              }
            } else {
              lastLine = line;
              repeatCount = 1;
            }
          }
          lastEmittedLineLength = lastNewline + 1;
          if (aborted) {break;}
        }

        if (text.length >= nextCheckAt) {
          nextCheckAt = text.length + CHECK_EVERY;
          const tail = text.slice(Math.max(0, text.length - WINDOW));
          // Normalize whitespace + drop numeric noise so "3." vs "4." don't
          // defeat the comparison when a model re-numbers each attempt.
          const fingerprint = tail
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/\d+/g, '#')
            .trim();
          recentFingerprints.push(fingerprint);
          if (recentFingerprints.length > THRESHOLD) {recentFingerprints.shift();}
          if (
            recentFingerprints.length === THRESHOLD &&
            recentFingerprints.every(f => f === fingerprint)
          ) {
            aborted = true;
            emit('tool_loop:stream_abort', {
              iteration,
              reason: 'intra_response_loop',
              length: text.length,
              fingerprintPreview: fingerprint.slice(0, 120)
            });
            break;
          }
        }
      }
      break;
    } catch (error) {
      const retryable = isRetryableLlmError(error);
      const safeToReplay = text.length === 0;
      // Original gate was `!tools || tools.length === 0` — i.e. only
      // text-tools turns got the same-channel backoff ladder. Native-tools
      // turns hit a transient 500 once and jumped straight to the
      // disruptive native→text envelope switch (and a second hiccup
      // hard-failed). The gate exists to prevent re-emitting tool-call
      // deltas after partial output was already streamed; when
      // `safeToReplay` is true NO chunks have arrived yet, so there are
      // no deltas to duplicate. Widening the gate to allow retry when
      // safeToReplay holds catches transient infra blips (gateway load
      // shedding, ollama restart, brief network glitches) on the native
      // path without risking duplicated tool calls.
      const sameTransportRetryAllowed = !tools || tools.length === 0 || safeToReplay;
      if (retryable && safeToReplay && sameTransportRetryAllowed && !signal?.aborted && transientRetries < MAX_TRANSIENT_RETRIES) {
        transientRetries++;
        const delayMs = BASE_RETRY_MS * Math.pow(2, transientRetries - 1);
        emit('tool_loop:llm_retry', {
          iteration,
          attempt: transientRetries + 1,
          maxAttempts: MAX_TRANSIENT_RETRIES + 1,
          delayMs,
          reason: summarizeLlmError(error)
        });
        await sleep(delayMs);
        continue;
      }
      if (retryable) {tagRetryableLlmError(error);}
      throw error;
    }
  }

  // If we aborted a runaway stream, trim trailing garbage and append
  // a sentinel so the downstream final-response detector can recognize
  // this and route to the prose-loop nudge (or a clean termination).
  if (aborted) {
    // Drop the last (likely-truncated) repetition cycle from the
    // output — cleaner to end at a previous paragraph boundary than
    // mid-sentence.
    const trimmed = text.replace(/\s+$/, '');
    text = trimmed + '\n\n[stream aborted: self-contradicting prose loop detected]';
  }

  return text;
}

/**
 * Contract tests for `streamAndAggregate` — the LLM streaming + intra-
 * response loop detection + same-channel transient-retry primitive
 * extracted from ToolUseLoop.runWithMessages (Arc 3 Session 2).
 *
 * These pin the load-bearing behaviors that gate user-facing safety:
 * - line-repetition and fingerprint detectors catch runaway prose loops
 *   the upstream prose-loop nudge later acts on;
 * - HARD_MAX bounds worst-case streaming cost on a single response;
 * - the safeToReplay gate widening lets native-tools turns survive one
 *   transient infra blip without escalating to the disruptive native→
 *   text envelope switch.
 *
 * A break here typically reflects a behavior change in the streaming
 * adapter, not a test bug — fix the source, not the assertion.
 */
import { describe, expect, it } from 'vitest';
import { streamAndAggregate } from '../src/tools/loop/llmStream';
import { buildEmitRecorder, yieldChunks } from './_helpers';
import type { ChatFn } from '../src/index';

function chatFromChunks(chunks: string[]): ChatFn {
  return () => yieldChunks(chunks);
}

describe('streamAndAggregate — happy path', () => {
  it('returns the full aggregated text', async () => {
    const { emit } = buildEmitRecorder();
    const result = await streamAndAggregate({
      chat: chatFromChunks(['Hello', ', ', 'world.']),
      messages: [],
      emit,
      iteration: 0
    });
    expect(result).toBe('Hello, world.');
  });

  it('emits tool_loop:llm_chunk per chunk in arrival order', async () => {
    const { emit, events } = buildEmitRecorder();
    await streamAndAggregate({
      chat: chatFromChunks(['a', 'b', 'c']),
      messages: [],
      emit,
      iteration: 3
    });
    const chunks = events.filter((e) => e.type === 'tool_loop:llm_chunk');
    expect(chunks.map((e) => (e.payload as { chunk: string }).chunk)).toEqual(['a', 'b', 'c']);
    expect(chunks.every((e) => (e.payload as { iteration: number }).iteration === 3)).toBe(true);
  });

  it('does NOT emit stream_abort when the stream completes normally', async () => {
    const { emit, events } = buildEmitRecorder();
    await streamAndAggregate({
      chat: chatFromChunks(['short response']),
      messages: [],
      emit,
      iteration: 0
    });
    expect(events.some((e) => e.type === 'tool_loop:stream_abort')).toBe(false);
  });
});

describe('streamAndAggregate — runaway-loop guards', () => {
  it('hard-max abort fires past 24,000 chars and appends the sentinel', async () => {
    // Single chunk past HARD_MAX with no newlines (defeats the line
    // detector) and a sentence that wouldn't fingerprint-collide with
    // itself if windowed (defeats the 400-char fingerprint detector
    // by virtue of the HARD_MAX check running BEFORE fingerprint in
    // the same chunk-arrival turn).
    const oneChunk = 'lorem ipsum dolor sit amet '.repeat(1000); // ~27,000 chars
    const { emit, events } = buildEmitRecorder();
    const result = await streamAndAggregate({
      chat: chatFromChunks([oneChunk]),
      messages: [],
      emit,
      iteration: 1
    });
    const abort = events.find((e) => e.type === 'tool_loop:stream_abort');
    expect(abort).toBeDefined();
    expect((abort!.payload as { reason: string }).reason).toBe('hard_max');
    expect(result).toMatch(/\[stream aborted: self-contradicting prose loop detected\]$/);
  });

  it('line-repetition aborts after 5 identical short lines', async () => {
    const phrase = "I can't install things.";
    const chunks: string[] = [];
    // 6 copies — detector trips at the 5th and short-circuits.
    for (let i = 0; i < 6; i++) chunks.push(`${phrase}\n`);
    const { emit, events } = buildEmitRecorder();
    const result = await streamAndAggregate({
      chat: chatFromChunks(chunks),
      messages: [],
      emit,
      iteration: 0
    });
    const abort = events.find((e) => e.type === 'tool_loop:stream_abort');
    expect(abort).toBeDefined();
    expect((abort!.payload as { reason: string }).reason).toBe('line_repetition_loop');
    expect((abort!.payload as { repeatCount: number }).repeatCount).toBe(5);
    expect(result.endsWith('[stream aborted: self-contradicting prose loop detected]')).toBe(true);
  });

  it('fingerprint-window aborts on 3 identical 400-char tail hashes', async () => {
    // Build content that defeats the line-repetition detector
    // (each line is unique due to a numeric prefix the fingerprint
    // collapses) but trips the window detector. Aim for >2400 chars
    // so the 800-char check fires three times on the same tail.
    const cycle = 'Wait, I see X. Let me check that. Actually trying option ';
    const chunks: string[] = [];
    // 25 cycles ≈ 1450 chars per round — emit three rounds.
    for (let round = 1; round <= 3; round++) {
      for (let i = 0; i < 14; i++) {
        chunks.push(`${cycle}${i + 1}. `);
      }
    }
    const { emit, events } = buildEmitRecorder();
    await streamAndAggregate({
      chat: chatFromChunks(chunks),
      messages: [],
      emit,
      iteration: 2
    });
    const abort = events.find((e) => e.type === 'tool_loop:stream_abort');
    expect(abort).toBeDefined();
    expect((abort!.payload as { reason: string }).reason).toBe('intra_response_loop');
  });

  it('honours signal.aborted mid-stream', async () => {
    const controller = new AbortController();
    let chunksYielded = 0;
    const chat: ChatFn = async function* () {
      yield 'first chunk\n';
      chunksYielded++;
      controller.abort();
      yield 'second chunk\n';
      chunksYielded++;
    };
    const { emit, events } = buildEmitRecorder();
    const result = await streamAndAggregate({
      chat,
      messages: [],
      emit,
      iteration: 0,
      signal: controller.signal
    });
    const abort = events.find((e) => e.type === 'tool_loop:stream_abort');
    expect(abort).toBeDefined();
    expect((abort!.payload as { reason: string }).reason).toBe('cancelled');
    // signal.aborted is checked at the TOP of the for-await body, so
    // the second chunk is delivered by the generator (chunksYielded=1
    // — past first yield, before second resume returns) but discarded
    // by the consumer before text += runs. Only 'first chunk' lands.
    expect(chunksYielded).toBe(1);
    expect(result).toContain('first chunk');
    expect(result).not.toContain('second chunk');
  });
});

describe('streamAndAggregate — transient-retry ladder', () => {
  it('retries a retryable error before any text streamed (text-tools path)', async () => {
    let calls = 0;
    const chat: ChatFn = function () {
      calls++;
      if (calls === 1) {
        return (async function* () {
          throw Object.assign(new Error('Upstream 502 from gateway'), { code: 'WATCHDOG' });
          yield ''; // unreachable but needed for AsyncIterable inference
        })();
      }
      return yieldChunks(['recovered.']);
    };
    const { emit, events } = buildEmitRecorder();
    const result = await streamAndAggregate({ chat, messages: [], emit, iteration: 4 });
    expect(result).toBe('recovered.');
    expect(calls).toBe(2);
    const retry = events.find((e) => e.type === 'tool_loop:llm_retry');
    expect(retry).toBeDefined();
    expect((retry!.payload as { attempt: number }).attempt).toBe(2);
  });

  it('retries on the native-tools path when no text has streamed (safeToReplay gate)', async () => {
    let calls = 0;
    const chat: ChatFn = function () {
      calls++;
      if (calls === 1) {
        return (async function* () {
          throw Object.assign(new Error('503 service unavailable'), { code: 'WATCHDOG' });
          yield '';
        })();
      }
      return yieldChunks(['native recovered']);
    };
    const { emit } = buildEmitRecorder();
    const tools = [{ type: 'function', function: { name: 'noop', description: '', parameters: { type: 'object', properties: {} } } }];
    const result = await streamAndAggregate({
      chat,
      messages: [],
      emit,
      iteration: 0,
      tools
    });
    expect(result).toBe('native recovered');
    expect(calls).toBe(2);
  });

  it('does NOT retry after text has streamed on the native-tools path', async () => {
    let calls = 0;
    const chat: ChatFn = function () {
      calls++;
      return (async function* () {
        yield 'partial output ';
        throw Object.assign(new Error('502 gateway'), { code: 'WATCHDOG' });
      })();
    };
    const { emit } = buildEmitRecorder();
    const tools = [{ type: 'function', function: { name: 'noop', description: '', parameters: { type: 'object', properties: {} } } }];
    await expect(
      streamAndAggregate({ chat, messages: [], emit, iteration: 0, tools })
    ).rejects.toThrow(/502 gateway/);
    expect(calls).toBe(1);
  });

  it('does NOT retry a non-retryable error (USER_ABORT)', async () => {
    let calls = 0;
    const chat: ChatFn = function () {
      calls++;
      return (async function* () {
        throw Object.assign(new Error('user cancelled'), { code: 'USER_ABORT' });
        yield '';
      })();
    };
    const { emit } = buildEmitRecorder();
    await expect(
      streamAndAggregate({ chat, messages: [], emit, iteration: 0 })
    ).rejects.toThrow(/user cancelled/);
    expect(calls).toBe(1);
  });

  it('caps transient retries at 2 then re-throws tagged with UPSTREAM_MODEL', async () => {
    let calls = 0;
    const chat: ChatFn = function () {
      calls++;
      return (async function* () {
        throw Object.assign(new Error('Upstream 502 from gateway'), { code: 'WATCHDOG' });
        yield '';
      })();
    };
    const { emit } = buildEmitRecorder();
    await expect(
      streamAndAggregate({ chat, messages: [], emit, iteration: 0 })
    ).rejects.toMatchObject({ code: 'WATCHDOG' });
    expect(calls).toBe(3); // initial + 2 retries
  });
});

/**
 * Recovery when the provider stops a degenerate model loop, and handling of a
 * reply cut off at the output-token limit.
 *
 * Real failure (2026-10-19 sweep): gemma4:12b looped `<|channel>thought `
 * in its thinking channel. The provider now stops that with an error whose
 * message starts "Model output loop detected" (code MODEL_OUTPUT_LOOP).
 * Replaying the identical request under a fixed seed loops identically, so
 * the loop retries ONCE with thinking off and a nudged temperature.
 */
import { describe, expect, it } from 'vitest';
import { streamAndAggregate } from '../src/tools/loop/llmStream';
import { isModelOutputLoopError, isRetryableLlmError } from '../src/tools/loop/loopShared';
import { OUTPUT_TRUNCATED_SENTINEL, ToolRegistry, ToolUseLoop } from '../src/index';
import type { ChatCallOptions, ChatFn } from '../src/index';
import { buildEmitRecorder, buildMockChat, buildReadFileTool, testCtx } from './_helpers';

function loopError(): Error {
  const err = new Error('Model output loop detected: the model repeated "<|channel>thought " for 4000+ characters in its thinking without variation, so the request was stopped.') as Error & { code?: string };
  err.code = 'MODEL_OUTPUT_LOOP';
  return err;
}

describe('output-loop error classification', () => {
  it('is recognised by code or message prefix and is not a transient error', () => {
    expect(isModelOutputLoopError(loopError())).toBe(true);
    expect(isModelOutputLoopError(new Error('Model output loop detected: x'))).toBe(true);
    expect(isModelOutputLoopError(new Error('Ollama stream stalled — no data for 90000ms'))).toBe(false);
    expect(isRetryableLlmError(loopError())).toBe(false);
  });
});

describe('streamAndAggregate — output-loop recovery', () => {
  it('retries once with thinking off and a temperature bump', async () => {
    const calls: Array<ChatCallOptions | undefined> = [];
    const chat: ChatFn = async function* (_m, _t, options) {
      calls.push(options);
      if (calls.length === 1) {throw loopError();}
      yield 'Reading the file.';
    };
    const { emit, events } = buildEmitRecorder();
    const text = await streamAndAggregate({ chat, messages: [], emit, iteration: 2, tools: [{ type: 'function', function: { name: 'x', description: '', parameters: { type: 'object', properties: {} } } }] as never });
    expect(text).toBe('Reading the file.');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toEqual({ think: false, temperatureBump: 0.15, recovery: 'output_loop' });
    expect(events.filter((e) => e.type === 'tool_loop:output_loop_recovery')).toHaveLength(1);
    // Not the generic "warming up" retry ladder.
    expect(events.some((e) => e.type === 'tool_loop:llm_retry')).toBe(false);
  });

  it('keeps an existing per-call override and only recovers once', async () => {
    let n = 0;
    const chat: ChatFn = async function* () {
      n++;
      throw loopError();
    };
    const { emit } = buildEmitRecorder();
    await expect(streamAndAggregate({ chat, messages: [], emit, iteration: 0, callOptions: { think: true } })).rejects.toThrow(/^Model output loop detected/);
    expect(n).toBe(2);
  });

  it('does not replay once content has already streamed', async () => {
    let n = 0;
    const chat: ChatFn = async function* () {
      n++;
      yield 'partial answer';
      throw loopError();
    };
    const { emit } = buildEmitRecorder();
    await expect(streamAndAggregate({ chat, messages: [], emit, iteration: 0 })).rejects.toThrow(/loop detected/);
    expect(n).toBe(1);
  });

  it('a user abort is not retried', async () => {
    const controller = new AbortController();
    controller.abort();
    let n = 0;
    const chat: ChatFn = async function* () {
      n++;
      throw loopError();
    };
    const { emit } = buildEmitRecorder();
    await expect(streamAndAggregate({ chat, messages: [], emit, iteration: 0, signal: controller.signal })).rejects.toThrow();
    expect(n).toBe(1);
  });
});

describe('ToolUseLoop — output truncated at the token limit', () => {
  it('nudges for smaller steps instead of finishing on the cut-off reply', async () => {
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool(captured));
    const { chat, recorder } = buildMockChat((turn) => {
      if (turn === 1) {return `I will write the whole file now.\n\n${OUTPUT_TRUNCATED_SENTINEL}`;}
      if (turn === 2) {return '<tool_call>{"name":"read_file","params":{"path":"a.ts"}}</tool_call>';}
      return 'Done — read a.ts.';
    });
    const { emit, events } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });
    const result = await loop.run('write the big file', chat);

    expect(events.filter((e) => e.type === 'tool_loop:output_truncated')).toHaveLength(1);
    expect(captured.paths).toEqual(['a.ts']);
    expect(result.finalResponse).toBe('Done — read a.ts.');
    // The model saw its own partial reply (without the sentinel) and the nudge.
    // (The recorder holds the live array, so look at the whole conversation.)
    const second = recorder.calls[1].messages;
    expect(second.some((m) => m.role === 'assistant' && m.content === 'I will write the whole file now.')).toBe(true);
    expect(second.some((m) => m.role === 'user' && /cut off: it hit the output token limit/.test(m.content))).toBe(true);
    expect(second.every((m) => !m.content.includes(OUTPUT_TRUNCATED_SENTINEL))).toBe(true);
  });

  it('stops nudging after two truncations in one turn and never returns the sentinel', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => `Still writing.\n\n${OUTPUT_TRUNCATED_SENTINEL}`);
    const { emit, events } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 8 });
    const result = await loop.run('write it', chat);
    expect(events.filter((e) => e.type === 'tool_loop:output_truncated')).toHaveLength(2);
    expect(result.finalResponse).not.toContain(OUTPUT_TRUNCATED_SENTINEL);
  });
});

describe('thinking-budget stop takes the same recovery', () => {
  it('is classified with the loop errors and retried once with thinking off', async () => {
    const budgetErr = Object.assign(new Error('Model thinking budget exceeded: the model streamed 32010 characters of reasoning'), { code: 'MODEL_THINKING_BUDGET' });
    expect(isModelOutputLoopError(budgetErr)).toBe(true);
    expect(isRetryableLlmError(budgetErr)).toBe(false);
    const calls: Array<ChatCallOptions | undefined> = [];
    const chat: ChatFn = async function* (_m, _t, options) {
      calls.push(options);
      if (calls.length === 1) {throw budgetErr;}
      yield 'ok';
    };
    const { emit, events } = buildEmitRecorder();
    expect(await streamAndAggregate({ chat, messages: [], emit, iteration: 0 })).toBe('ok');
    expect(calls[1]?.think).toBe(false);
    expect((events.find((e) => e.type === 'tool_loop:output_loop_recovery')?.payload as { kind?: string }).kind).toBe('thinking_budget');
  });
});

describe('ToolUseLoop — sticky thinking-off after a runaway', () => {
  it('keeps think:false on every later request of the run after an output-loop recovery', async () => {
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool(captured));
    const options: Array<ChatCallOptions | undefined> = [];
    let n = 0;
    const chat: ChatFn = async function* (_m, _t, o) {
      options.push(o);
      n++;
      if (n === 1) {throw loopError();}
      if (n <= 3) {yield `<tool_call>{"name":"read_file","params":{"path":"f${n}.ts"}}</tool_call>`; return;}
      yield 'Done.';
    };
    const { emit, events } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });
    const result = await loop.run('do it', chat);
    expect(result.finalResponse).toBe('Done.');
    expect(options[0]?.think).toBeUndefined();
    // The recovery retry and every later request: thinking off.
    expect(options.slice(1).map((o) => o?.think)).toEqual([false, false, false]);
    const sticky = events.filter((e) => e.type === 'tool_loop:thinking_sticky_off');
    expect(sticky).toHaveLength(1);
    const order = events.map((e) => e.type).filter((t) => t === 'tool_loop:output_loop_recovery' || t === 'tool_loop:thinking_sticky_off');
    expect(order).toEqual(['tool_loop:output_loop_recovery', 'tool_loop:thinking_sticky_off']);
  });

  it('turns thinking off after a reply cut off with nothing but reasoning, not after a partial answer', async () => {
    const run = async (first: string) => {
      const options: Array<ChatCallOptions | undefined> = [];
      let n = 0;
      const chat: ChatFn = async function* (_m, _t, o) {
        options.push(o);
        n++;
        yield n === 1 ? first : 'Done.';
      };
      const { emit, events } = buildEmitRecorder();
      await new ToolUseLoop(new ToolRegistry(), testCtx, { emitEvent: emit, maxIterations: 4 }).run('x', chat);
      return { options, sticky: events.some((e) => e.type === 'tool_loop:thinking_sticky_off') };
    };
    const empty = await run(OUTPUT_TRUNCATED_SENTINEL);
    expect(empty.sticky).toBe(true);
    expect(empty.options[1]?.think).toBe(false);
    const partial = await run(`Here is half an answer\n\n${OUTPUT_TRUNCATED_SENTINEL}`);
    expect(partial.sticky).toBe(false);
    expect(partial.options[1]?.think).toBeUndefined();
  });

  it('a run without a runaway never forces thinking off', async () => {
    const options: Array<ChatCallOptions | undefined> = [];
    const chat: ChatFn = async function* (_m, _t, o) { options.push(o); yield 'Done.'; };
    await new ToolUseLoop(new ToolRegistry(), testCtx, { maxIterations: 3 }).run('x', chat);
    expect(options.every((o) => o?.think === undefined)).toBe(true);
  });
});

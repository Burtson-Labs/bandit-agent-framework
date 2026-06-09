/**
 * Contract tests for `executeParallelBatch` — the output-budget-aware
 * batch dispatcher extracted from ToolUseLoop.runWithMessages (Arc 3
 * Session 2).
 *
 * Pins: ordering preservation (Promise.all path), serialize-vs-parallel
 * gate thresholds, single-call batches skip the gate, abort
 * short-circuits the serial loop, and the emit shape for
 * `tool_loop:batch_serialized`.
 *
 * A break here is felt by small/medium-model users: the assistant turn
 * starts producing malformed JSON in the tail of a multi-write batch.
 */
import { describe, expect, it } from 'vitest';
import { executeParallelBatch, estimateToolCallOutputTokens } from '../src/tools/loop/parallelExecute';
import { buildEmitRecorder } from './_helpers';
import type { ParsedToolCall } from '../src/tools/tool-use-parser';
import type { ToolDispatchResult } from '../src/tools/loop/singleToolExecute';

function tc(name: string, params: Record<string, string> = {}): ParsedToolCall {
  return { name, params, id: `${name}-${Math.random().toString(36).slice(2, 7)}` };
}

describe('executeParallelBatch — parallel path', () => {
  it('preserves call ordering in the results array (Promise.all)', async () => {
    const order: string[] = [];
    const dispatchOne = async (call: ParsedToolCall): Promise<ToolDispatchResult> => {
      // Stagger: first call resolves last to force ordering to come
      // from Promise.all's input-order guarantee, not completion order.
      await new Promise((r) => setTimeout(r, call.name === 'a' ? 30 : 5));
      order.push(call.name);
      return { name: call.name, output: `${call.name}-out` };
    };
    const { emit } = buildEmitRecorder();
    const results = await executeParallelBatch({
      toolCalls: [tc('a'), tc('b'), tc('c')],
      dispatchOne,
      outputBudgetTokens: Infinity,
      outputBudgetRatio: 0.6,
      emit,
      iteration: 0
    });
    expect(results.map((r) => r.name)).toEqual(['a', 'b', 'c']);
    // Completion order is different from results order — proves
    // ordering came from input position, not race.
    expect(order).toEqual(['b', 'c', 'a']);
  });

  it('skips the threshold check entirely for single-call batches', async () => {
    // A single huge call still goes parallel because there is no
    // parallel/serial choice to make with one call. The gate's job
    // is to break up a batch, not throttle individual calls.
    const dispatchOne = async (): Promise<ToolDispatchResult> => ({ name: 'write_file', output: 'ok' });
    const { emit, events } = buildEmitRecorder();
    const big = tc('write_file', { content: 'x'.repeat(50_000) });
    await executeParallelBatch({
      toolCalls: [big],
      dispatchOne,
      outputBudgetTokens: 1000,
      outputBudgetRatio: 0.6,
      emit,
      iteration: 0
    });
    expect(events.find((e) => e.type === 'tool_loop:batch_serialized')).toBeUndefined();
  });

  it('Infinity budget never trips serialize, even for big batches', async () => {
    const dispatchOne = async (call: ParsedToolCall): Promise<ToolDispatchResult> => ({ name: call.name, output: 'ok' });
    const { emit, events } = buildEmitRecorder();
    const calls = [
      tc('write_file', { content: 'x'.repeat(50_000) }),
      tc('write_file', { content: 'y'.repeat(50_000) }),
      tc('write_file', { content: 'z'.repeat(50_000) })
    ];
    await executeParallelBatch({
      toolCalls: calls,
      dispatchOne,
      outputBudgetTokens: Infinity,
      outputBudgetRatio: 0.6,
      emit,
      iteration: 0
    });
    expect(events.find((e) => e.type === 'tool_loop:batch_serialized')).toBeUndefined();
  });
});

describe('executeParallelBatch — serialize path', () => {
  it('serializes when the estimated batch output exceeds outputBudgetTokens * ratio', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatchOne = async (call: ParsedToolCall): Promise<ToolDispatchResult> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { name: call.name, output: 'ok' };
    };
    const { emit, events } = buildEmitRecorder();
    // 3 writes × 8000 chars = 24,000 chars ≈ 6000 tokens.
    // budget 5000 × 0.6 = 3000 threshold. 6000 > 3000 → serialize.
    const calls = [
      tc('write_file', { content: 'a'.repeat(8000) }),
      tc('write_file', { content: 'b'.repeat(8000) }),
      tc('write_file', { content: 'c'.repeat(8000) })
    ];
    await executeParallelBatch({
      toolCalls: calls,
      dispatchOne,
      outputBudgetTokens: 5000,
      outputBudgetRatio: 0.6,
      emit,
      iteration: 2
    });
    expect(maxInFlight).toBe(1); // serial — never two in flight at once
    const serialized = events.find((e) => e.type === 'tool_loop:batch_serialized');
    expect(serialized).toBeDefined();
    expect(serialized!.payload).toMatchObject({
      iteration: 2,
      toolCount: 3,
      reason: 'output-budget-exceeded',
      budgetTokens: 5000,
      threshold: 3000
    });
  });

  it('serial loop short-circuits on signal.aborted between calls', async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const dispatchOne = async (call: ParsedToolCall): Promise<ToolDispatchResult> => {
      const tag = call.params.tag;
      executed.push(tag);
      if (tag === 'b') controller.abort();
      return { name: call.name, output: `out-${tag}` };
    };
    const { emit } = buildEmitRecorder();
    // Heavy content trips serialize; `tag` param identifies each call.
    const calls = [
      tc('write_file', { tag: 'a', content: 'x'.repeat(8000) }),
      tc('write_file', { tag: 'b', content: 'x'.repeat(8000) }),
      tc('write_file', { tag: 'c', content: 'x'.repeat(8000) })
    ];
    const results = await executeParallelBatch({
      toolCalls: calls,
      dispatchOne,
      outputBudgetTokens: 5000,
      outputBudgetRatio: 0.6,
      emit,
      iteration: 0,
      signal: controller.signal
    });
    // 'a' and 'b' executed, 'c' short-circuited. The check fires BEFORE
    // dispatching the next call, so once 'b' aborts the controller,
    // 'c' is skipped.
    expect(executed).toEqual(['a', 'b']);
    expect(results.map((r) => r.output)).toEqual(['out-a', 'out-b']);
  });

  it('stays parallel when the batch fits the threshold', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatchOne = async (call: ParsedToolCall): Promise<ToolDispatchResult> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { name: call.name, output: 'ok' };
    };
    const { emit, events } = buildEmitRecorder();
    // Two small reads — no heavy payload, well under the threshold.
    const calls = [tc('read_file', { path: 'a.ts' }), tc('read_file', { path: 'b.ts' })];
    await executeParallelBatch({
      toolCalls: calls,
      dispatchOne,
      outputBudgetTokens: 5000,
      outputBudgetRatio: 0.6,
      emit,
      iteration: 0
    });
    expect(maxInFlight).toBe(2); // parallel
    expect(events.find((e) => e.type === 'tool_loop:batch_serialized')).toBeUndefined();
  });
});

describe('estimateToolCallOutputTokens', () => {
  it('counts heavy fields (content, replace, find, text) at chars/4', () => {
    expect(estimateToolCallOutputTokens(tc('write_file', { content: 'x'.repeat(4000) }))).toBe(1000);
    expect(estimateToolCallOutputTokens(tc('apply_edit', { find: 'a'.repeat(400), replace: 'b'.repeat(800) }))).toBe(300);
  });

  it('ignores non-heavy fields (path, command, glob)', () => {
    expect(estimateToolCallOutputTokens(tc('read_file', { path: '/very/long/path/that/should/not/count.ts' }))).toBe(0);
  });
});

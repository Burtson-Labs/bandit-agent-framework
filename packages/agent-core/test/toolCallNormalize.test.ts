/**
 * Contract tests for `normalizeToolCallBatch` — the dedup / fanout-cap /
 * parallel-cap / total-cap stage extracted from
 * ToolUseLoop.runWithMessages (Arc 3 Session 1).
 *
 * Pins the four normalization passes and the telemetry event each emits.
 * A break here signals the normalization contract has drifted; the
 * orchestrator depends on the dropped-count return values to compose
 * the model-facing "you emitted N too many calls" note (see the
 * `droppedToolCalls`/`droppedForegroundTaskCalls` references in
 * tool-use-loop.ts).
 */
import { describe, expect, it } from 'vitest';
import { normalizeToolCallBatch } from '../src/tools/loop/toolCallNormalize';
import type { ParsedToolCall } from '../src/tools/tool-use-parser';

function tc(name: string, params: Record<string, string> = {}, raw = ''): ParsedToolCall {
  return { name, params, raw: raw || `<tool_call>${name}</tool_call>` };
}

function makeEmit(): { emit: (type: string, payload?: unknown) => void; events: Array<{ type: string; payload: unknown }> } {
  const events: Array<{ type: string; payload: unknown }> = [];
  return { events, emit: (type, payload) => events.push({ type, payload }) };
}

describe('normalizeToolCallBatch — byte-identical dedup', () => {
  it('drops calls with the same name + params signature, keeps the first occurrence', () => {
    const { emit, events } = makeEmit();
    const result = normalizeToolCallBatch({
      toolCalls: [
        tc('search_code', { query: 'foo' }),
        tc('search_code', { query: 'foo' }), // dup
        tc('search_code', { query: 'foo' }), // dup
        tc('read_file', { path: 'a.ts' })
      ],
      iteration: 3,
      maxParallelTools: 10,
      maxTotalTools: 100,
      totalToolsExecuted: 0,
      emit
    });
    expect(result.accepted.map((c) => `${c.name}:${c.params.query ?? c.params.path}`)).toEqual([
      'search_code:foo',
      'read_file:a.ts'
    ]);
    expect(result.dedupedCount).toBe(2);
    const deduped = events.find((e) => e.type === 'tool_loop:tool_call_deduped');
    expect(deduped?.payload).toMatchObject({ iteration: 3, removed: 2, kept: 2 });
  });

  it('does not run dedup (or emit) on a single-call iteration', () => {
    const { emit, events } = makeEmit();
    const result = normalizeToolCallBatch({
      toolCalls: [tc('read_file', { path: 'a.ts' })],
      iteration: 0,
      maxParallelTools: 10,
      maxTotalTools: 100,
      totalToolsExecuted: 0,
      emit
    });
    expect(result.accepted.length).toBe(1);
    expect(result.dedupedCount).toBe(0);
    expect(events.find((e) => e.type === 'tool_loop:tool_call_deduped')).toBeUndefined();
  });

  it('treats different param values as distinct (no over-collapsing)', () => {
    const { emit } = makeEmit();
    const result = normalizeToolCallBatch({
      toolCalls: [
        tc('search_code', { query: 'foo' }),
        tc('search_code', { query: 'bar' })
      ],
      iteration: 0,
      maxParallelTools: 10,
      maxTotalTools: 100,
      totalToolsExecuted: 0,
      emit
    });
    expect(result.accepted.length).toBe(2);
    expect(result.dedupedCount).toBe(0);
  });
});

describe('normalizeToolCallBatch — foreground-task fanout cap', () => {
  it('keeps at most ONE foreground task per iteration and drops the rest', () => {
    const { emit, events } = makeEmit();
    const result = normalizeToolCallBatch({
      toolCalls: [
        tc('task', { goal: 'a' }), // foreground (no run_in_background)
        tc('task', { goal: 'b' }), // foreground — dropped
        tc('task', { goal: 'c' })  // foreground — dropped
      ],
      iteration: 1,
      maxParallelTools: 10,
      maxTotalTools: 100,
      totalToolsExecuted: 0,
      emit
    });
    expect(result.accepted.map((c) => c.params.goal)).toEqual(['a']);
    expect(result.droppedForegroundTaskCalls).toBe(2);
    const capped = events.find((e) => e.type === 'tool_loop:foreground_task_fanout_capped');
    expect(capped?.payload).toMatchObject({ iteration: 1, kept: 1, dropped: 2 });
  });

  it('does NOT cap background tasks (run_in_background=true)', () => {
    const { emit, events } = makeEmit();
    const result = normalizeToolCallBatch({
      toolCalls: [
        tc('task', { goal: 'a', run_in_background: 'true' }),
        tc('task', { goal: 'b', run_in_background: 'true' }),
        tc('task', { goal: 'c', run_in_background: 'true' })
      ],
      iteration: 1,
      maxParallelTools: 10,
      maxTotalTools: 100,
      totalToolsExecuted: 0,
      emit
    });
    expect(result.accepted.length).toBe(3);
    expect(result.droppedForegroundTaskCalls).toBe(0);
    expect(events.find((e) => e.type === 'tool_loop:foreground_task_fanout_capped')).toBeUndefined();
  });

  it('allows the first foreground task even when other foreground tasks follow', () => {
    const { emit } = makeEmit();
    const result = normalizeToolCallBatch({
      toolCalls: [
        tc('read_file', { path: 'a.ts' }),
        tc('task', { goal: 'a' }),
        tc('task', { goal: 'b' }),
        tc('read_file', { path: 'b.ts' })
      ],
      iteration: 0,
      maxParallelTools: 10,
      maxTotalTools: 100,
      totalToolsExecuted: 0,
      emit
    });
    expect(result.accepted.map((c) => `${c.name}:${c.params.path ?? c.params.goal}`)).toEqual([
      'read_file:a.ts',
      'task:a',
      'read_file:b.ts'
    ]);
    expect(result.droppedForegroundTaskCalls).toBe(1);
  });
});

describe('normalizeToolCallBatch — per-iteration parallel cap', () => {
  it('slices to maxParallelTools and emits the cap event', () => {
    const { emit, events } = makeEmit();
    const result = normalizeToolCallBatch({
      toolCalls: [
        tc('read_file', { path: 'a.ts' }),
        tc('read_file', { path: 'b.ts' }),
        tc('read_file', { path: 'c.ts' }),
        tc('read_file', { path: 'd.ts' }),
        tc('read_file', { path: 'e.ts' })
      ],
      iteration: 2,
      maxParallelTools: 2,
      maxTotalTools: 100,
      totalToolsExecuted: 0,
      emit
    });
    expect(result.accepted.map((c) => c.params.path)).toEqual(['a.ts', 'b.ts']);
    expect(result.droppedParallelCap).toBe(3);
    const capped = events.find((e) => e.type === 'tool_loop:tool_call_capped');
    expect(capped?.payload).toMatchObject({ iteration: 2, kept: 2, dropped: 3, requested: 5 });
  });
});

describe('normalizeToolCallBatch — per-turn total cap', () => {
  it('slices the batch to fit the remaining per-turn budget', () => {
    const { emit, events } = makeEmit();
    const result = normalizeToolCallBatch({
      toolCalls: [
        tc('read_file', { path: 'a.ts' }),
        tc('read_file', { path: 'b.ts' }),
        tc('read_file', { path: 'c.ts' })
      ],
      iteration: 4,
      maxParallelTools: 10,
      maxTotalTools: 5,
      totalToolsExecuted: 4, // only 1 slot left
      emit
    });
    expect(result.accepted.length).toBe(1);
    expect(result.droppedTotalCap).toBe(2);
    const capped = events.find((e) => e.type === 'tool_loop:tool_call_total_capped');
    expect(capped?.payload).toMatchObject({
      iteration: 4,
      requested: 3,
      kept: 1,
      totalSoFar: 4,
      maxTotalTools: 5
    });
  });

  it('returns an empty accepted list when no per-turn budget remains', () => {
    const { emit } = makeEmit();
    const result = normalizeToolCallBatch({
      toolCalls: [tc('read_file', { path: 'a.ts' })],
      iteration: 0,
      maxParallelTools: 10,
      maxTotalTools: 5,
      totalToolsExecuted: 5,
      emit
    });
    expect(result.accepted).toEqual([]);
    expect(result.droppedTotalCap).toBe(1);
  });
});

describe('normalizeToolCallBatch — pass ordering invariant', () => {
  it('applies dedup → foreground-cap → parallel-cap → total-cap in that order', () => {
    // Build a batch where every pass would mis-handle if reordered:
    // - 6 raw calls
    // - 1 duplicate (so dedup drops 1 → 5)
    // - 2 foreground tasks (foreground-cap drops 1 → 4)
    // - parallel cap 3 (parallel-cap drops 1 → 3)
    // - total budget 2 (total-cap drops 1 → 2)
    const { emit } = makeEmit();
    const result = normalizeToolCallBatch({
      toolCalls: [
        tc('search_code', { query: 'foo' }),
        tc('search_code', { query: 'foo' }), // dup → dropped by dedup
        tc('task', { goal: 'a' }),
        tc('task', { goal: 'b' }), // 2nd foreground → dropped
        tc('read_file', { path: 'a.ts' }),
        tc('read_file', { path: 'b.ts' })
      ],
      iteration: 0,
      maxParallelTools: 3,
      maxTotalTools: 10,
      totalToolsExecuted: 8, // 2 slots left
      emit
    });
    expect(result.dedupedCount).toBe(1);
    expect(result.droppedForegroundTaskCalls).toBe(1);
    expect(result.droppedParallelCap).toBe(1);
    expect(result.droppedTotalCap).toBe(1);
    expect(result.accepted.length).toBe(2);
  });
});

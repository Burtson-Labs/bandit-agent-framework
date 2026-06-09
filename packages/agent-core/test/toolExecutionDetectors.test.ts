/**
 * Detector contracts: tool-execution edge cases.
 *
 *   - tool_loop:tool_call_deduped — identical tool calls within ONE
 *     iteration get dropped (model emitted 4× search_code with the
 *     same params; only one runs).
 *   - tool_loop:tool_call_total_capped — one iteration's batch would
 *     push past maxTotalTools — the batch is sliced to fit.
 *   - tool_loop:repeat_breaker — same tool with same key invoked
 *     REPEAT_LIMIT=3 iterations in a row → returns a synthetic
 *     "loop detected" error instead of executing.
 *   - tool_loop:tool_not_found — model called a tool name not in
 *     the registry → synthetic error result.
 *   - tool_loop:tool_error — tool's execute() threw → caught,
 *     surfaced as an isError result, event emitted.
 *   - tool_loop:todo_progress_nudge — model set up a todo plan
 *     earlier but has done >= 2 edits since without updating it →
 *     one-shot nudge to call todo_write again.
 *
 * Closes the detector-coverage map: every `emit('tool_loop:*')`
 * call in the source has at least one regression test.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import type { AgentTool, ToolResult } from '../src/index';
import {
  testCtx,
  buildMockChat,
  buildEmitRecorder
} from './_helpers';

describe('tool_call_deduped', () => {
  it('drops semantically-equal calls (same name+params, different raw text) within one iteration', async () => {
    // The XML parser drops BYTE-IDENTICAL raw blocks before the loop
    // ever sees them — so this test uses calls that have the same
    // name+params but vary in whitespace inside the JSON. The parser
    // extracts both, and the loop's signature-based dedup at 1437
    // (`name::JSON.stringify(params)`) catches the semantic duplicate.
    const captured = { calls: 0 };
    const registry = new ToolRegistry();
    registry.register({
      name: 'search_code',
      description: 'search',
      parameters: [{ name: 'query', description: 'q', required: true }],
      async execute(): Promise<ToolResult> {
        captured.calls += 1;
        return { output: 'hits' };
      }
    });
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        // Two calls with IDENTICAL params but differently-formatted
        // raw text. Parser extracts both, loop dedup keeps one.
        return [
          '<tool_call>{"name":"search_code","params":{"query":"foo"}}</tool_call>',
          '<tool_call>{"name":"search_code", "params":{"query":"foo"}}</tool_call>'
        ].join('\n');
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('search', chat);
    expect(captured.calls).toBe(1);
    const fires = events.filter((e) => e.type === 'tool_loop:tool_call_deduped');
    expect(fires.length).toBe(1);
    expect((fires[0].payload as { removed?: number }).removed).toBe(1);
    expect((fires[0].payload as { kept?: number }).kept).toBe(1);
  });
});

describe('tool_call_total_capped', () => {
  it('slices the batch when it would push past the remaining maxTotalTools budget', async () => {
    const captured = { calls: 0 };
    const registry = new ToolRegistry();
    registry.register({
      name: 'noop',
      description: 'noop',
      parameters: [{ name: 'i', description: 'i', required: false }],
      async execute(): Promise<ToolResult> {
        captured.calls += 1;
        return { output: 'ok' };
      }
    });
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        // Three calls in one iteration with maxTotalTools=2 — the
        // batch should be sliced to 2 and the event fires.
        return [
          '<tool_call>{"name":"noop","params":{"i":"1"}}</tool_call>',
          '<tool_call>{"name":"noop","params":{"i":"2"}}</tool_call>',
          '<tool_call>{"name":"noop","params":{"i":"3"}}</tool_call>'
        ].join('\n');
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      maxIterations: 4,
      maxTotalTools: 2
    });

    await loop.run('do work', chat);
    expect(captured.calls).toBeLessThanOrEqual(2);
    const fires = events.filter((e) => e.type === 'tool_loop:tool_call_total_capped');
    expect(fires.length).toBe(1);
  });
});

describe('repeat_breaker', () => {
  it('returns a synthetic loop-detected error when the same tool+key fires 3 iterations in a row', async () => {
    const captured = { calls: 0 };
    const registry = new ToolRegistry();
    registry.register({
      name: 'apply_edit',
      description: 'edit',
      parameters: [
        { name: 'path', description: 'p', required: true },
        { name: 'find', description: 'f', required: true },
        { name: 'replace', description: 'r', required: true }
      ],
      async execute(): Promise<ToolResult> {
        captured.calls += 1;
        return { output: 'edit applied' };
      }
    });
    const sameCall = '<tool_call>{"name":"apply_edit","params":{"path":"a.ts","find":"foo","replace":"bar"}}</tool_call>';
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      // Same call across 4 iters — breaker fires on iter 3 (REPEAT_LIMIT=3).
      if (turn <= 4) return sameCall;
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 8 });

    await loop.run('edit a file', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:repeat_breaker');
    expect(fires.length).toBeGreaterThanOrEqual(1);
    expect((fires[0].payload as { name?: string }).name).toBe('apply_edit');
    // Three actual executes happened before the breaker tripped on the 4th.
    expect(captured.calls).toBeLessThanOrEqual(3);
  });
});

describe('tool_not_found', () => {
  it('fires when the model calls a tool that is not registered', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return '<tool_call>{"name":"made_up_tool","params":{}}</tool_call>';
      }
      return 'OK, falling back to prose.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('do something', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:tool_not_found');
    expect(fires.length).toBe(1);
    expect((fires[0].payload as { name?: string }).name).toBe('made_up_tool');
  });
});

describe('tool_error', () => {
  it('fires when a tool execute() throws an exception', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'broken_tool',
      description: 'broken',
      parameters: [],
      async execute(): Promise<ToolResult> {
        throw new Error('tool blew up');
      }
    });
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return '<tool_call>{"name":"broken_tool","params":{}}</tool_call>';
      return 'OK.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('do it', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:tool_error');
    expect(fires.length).toBe(1);
    expect((fires[0].payload as { name?: string }).name).toBe('broken_tool');
    expect((fires[0].payload as { error?: string }).error).toContain('tool blew up');
  });
});

describe('todo_progress_nudge', () => {
  function buildEditTool(): AgentTool {
    return {
      name: 'apply_edit',
      description: 'edit',
      parameters: [
        { name: 'path', description: 'p', required: true },
        { name: 'find', description: 'f', required: true },
        { name: 'replace', description: 'r', required: true }
      ],
      async execute(): Promise<ToolResult> {
        return { output: 'edit applied' };
      }
    };
  }
  function buildTodoTool(): AgentTool {
    return {
      name: 'todo_write',
      description: 'todo',
      parameters: [{ name: 'items', description: 'items', required: true }],
      async execute(): Promise<ToolResult> {
        return { output: 'plan saved' };
      }
    };
  }

  it('fires after >=2 successful edits with no todo_write update across >=3 iterations', async () => {
    const registry = new ToolRegistry();
    registry.register(buildEditTool());
    registry.register(buildTodoTool());

    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return '<tool_call>{"name":"todo_write","params":{"items":"[{\\"content\\":\\"step\\",\\"status\\":\\"pending\\"}]"}}</tool_call>';
      }
      // Distinct edit calls so the repeat_breaker doesn't fire first.
      // After iter 1's todo_write, every successful edit increments
      // editsSinceLastTodo. After STALE_DELTA (3) iterations and
      // EDIT_THRESHOLD (2) edits, the nudge fires.
      if (turn === 2) return '<tool_call>{"name":"apply_edit","params":{"path":"a.ts","find":"a","replace":"b"}}</tool_call>';
      if (turn === 3) return '<tool_call>{"name":"apply_edit","params":{"path":"b.ts","find":"x","replace":"y"}}</tool_call>';
      if (turn === 4) return '<tool_call>{"name":"apply_edit","params":{"path":"c.ts","find":"p","replace":"q"}}</tool_call>';
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 8 });

    await loop.run('refactor', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:todo_progress_nudge');
    expect(fires.length).toBe(1);
    const payload = fires[0].payload as { editsSinceLastTodo?: number; iterationsSinceLastTodo?: number };
    expect(payload.editsSinceLastTodo).toBeGreaterThanOrEqual(2);
    expect(payload.iterationsSinceLastTodo).toBeGreaterThanOrEqual(3);
  });

  it('does NOT fire when no prior todo_write was ever called', async () => {
    const registry = new ToolRegistry();
    registry.register(buildEditTool());
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return '<tool_call>{"name":"apply_edit","params":{"path":"a.ts","find":"a","replace":"b"}}</tool_call>';
      if (turn === 2) return '<tool_call>{"name":"apply_edit","params":{"path":"b.ts","find":"x","replace":"y"}}</tool_call>';
      if (turn === 3) return '<tool_call>{"name":"apply_edit","params":{"path":"c.ts","find":"p","replace":"q"}}</tool_call>';
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 8 });

    await loop.run('edit', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:todo_progress_nudge');
    expect(fires.length).toBe(0);
  });
});

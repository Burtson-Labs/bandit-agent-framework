/**
 * Compaction + goal-anchor contracts for ToolUseLoop.
 *
 * Two cooperating mechanisms:
 *
 *   1. tool_loop:compacted — when messageTokenBudget is set, the
 *      loop runs compactToolMessages each iteration and emits a
 *      summary event with before/after token counts.
 *   2. tool_loop:goal_anchor — re-injects the original user goal as
 *      a corrective system-style message when the loop is at risk
 *      of drifting. Triggered by either (eligible iteration depth +
 *      message tokens) or aggressive compaction (>=25% drop OR
 *      >=10k absolute drop).
 *
 * The two events form the loop's defense against context drift.
 * Pinning the firing thresholds + payloads here so a future change
 * that lowers/raises the trigger silently is caught.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import {
  testCtx,
  buildMockChat,
  buildEmitRecorder,
  buildReadFileTool
} from './_helpers';

describe('compaction (tool_loop:compacted)', () => {
  it('fires with messagesCompacted, beforeTokens, afterTokens when the budget bites', async () => {
    const registry = new ToolRegistry();
    // Each turn fires a tool call so the message history accumulates
    // tool-result entries — enough to exceed a deliberately tiny
    // budget after a few iterations.
    registry.register(buildReadFileTool({ paths: [] }));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn < 5) return `<tool_call>{"name":"read_file","params":{"path":"f${turn}.ts"}}</tool_call>`;
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      messageTokenBudget: 50, // tiny — almost any tool history exceeds it
      maxIterations: 8
    });

    await loop.run('read all', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:compacted');
    expect(fires.length).toBeGreaterThanOrEqual(1);
    const first = fires[0].payload as {
      messagesCompacted?: number;
      beforeTokens?: number;
      afterTokens?: number;
    };
    expect(first.messagesCompacted).toBeGreaterThan(0);
    expect(first.beforeTokens).toBeGreaterThan(0);
    expect(first.afterTokens).toBeGreaterThanOrEqual(0);
    expect(first.afterTokens).toBeLessThanOrEqual(first.beforeTokens ?? 0);
  });

  it('does NOT fire when messageTokenBudget is unset', async () => {
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool({ paths: [] }));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn < 5) return `<tool_call>{"name":"read_file","params":{"path":"f${turn}.ts"}}</tool_call>`;
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    // No budget — compaction loop should be skipped entirely.
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 8 });

    await loop.run('read all', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:compacted');
    expect(fires.length).toBe(0);
  });

  it('does NOT fire when messages fit under the budget', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return 'Just answering, no tools.';
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      messageTokenBudget: 100_000, // huge — small history fits easily
      maxIterations: 4
    });

    await loop.run('say hi', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:compacted');
    expect(fires.length).toBe(0);
  });
});

describe('goal anchor (tool_loop:goal_anchor)', () => {
  it('fires at iteration >= 2 when message-token weight exceeds 4000', async () => {
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    // read_file returns a heavy payload so the message history grows
    // past 4000 chars within two iterations.
    registry.register({
      name: 'read_file',
      description: 'read',
      parameters: [{ name: 'path', description: 'p', required: true }],
      async execute(params: Record<string, string>) {
        captured.paths.push(params.path ?? '');
        // ~5000 chars per call.
        return { output: 'A'.repeat(5000) };
      }
    });
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn < 4) return `<tool_call>{"name":"read_file","params":{"path":"f${turn}.ts"}}</tool_call>`;
      return 'Final answer based on what I read.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 8 });

    await loop.run('read the source files and answer', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:goal_anchor');
    expect(fires.length).toBeGreaterThanOrEqual(1);
    const payload = fires[0].payload as {
      iteration?: number;
      goalPreview?: string;
      refire?: boolean;
      postAggressiveCompaction?: boolean;
    };
    expect(payload.iteration).toBeGreaterThanOrEqual(2);
    expect(payload.goalPreview).toContain('read the source files');
    expect(payload.refire).toBe(false);
    expect(payload.postAggressiveCompaction).toBe(false);
  });

  it('does NOT fire at iteration < 2 (eligibility floor)', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_file',
      description: 'read',
      parameters: [{ name: 'path', description: 'p', required: true }],
      async execute() {
        return { output: 'A'.repeat(8000) }; // big payload
      }
    });
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return '<tool_call>{"name":"read_file","params":{"path":"a.ts"}}</tool_call>';
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('read it', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:goal_anchor');
    expect(fires.length).toBe(0);
  });

  it('aggressive compaction (>=25% drop) forces an immediate goal_anchor with postAggressiveCompaction=true', async () => {
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_file',
      description: 'read',
      parameters: [{ name: 'path', description: 'p', required: true }],
      async execute(params: Record<string, string>) {
        captured.paths.push(params.path ?? '');
        // Each tool result is heavy enough that compaction has plenty
        // to collapse — a single round drops well over 25%.
        return { output: 'B'.repeat(20_000) };
      }
    });
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn < 4) return `<tool_call>{"name":"read_file","params":{"path":"f${turn}.ts"}}</tool_call>`;
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      messageTokenBudget: 1000, // forces aggressive compaction every iter
      maxIterations: 6
    });

    await loop.run('analyze the codebase', chat);
    const compactions = events.filter((e) => e.type === 'tool_loop:compacted');
    const anchors = events.filter((e) => e.type === 'tool_loop:goal_anchor');
    expect(compactions.length).toBeGreaterThanOrEqual(1);
    expect(anchors.length).toBeGreaterThanOrEqual(1);
    // At least one anchor should be flagged as triggered by aggressive
    // compaction — the override path that bypasses the iteration-depth
    // and refire-gap gates.
    const aggressiveAnchor = anchors.find(
      (a) => (a.payload as { postAggressiveCompaction?: boolean }).postAggressiveCompaction === true
    );
    expect(aggressiveAnchor).toBeDefined();
  });
});

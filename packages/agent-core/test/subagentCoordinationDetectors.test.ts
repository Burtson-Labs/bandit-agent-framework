/**
 * Detector contracts: subagent-coordination cluster.
 *
 *   - tool_loop:fired_and_forgotten_nudge — fires when one iteration
 *     spawns 2+ background subagents (`task` calls with
 *     `run_in_background: "true"`) that succeeded. Tells the parent
 *     to stop polling them or replaying the same work — synopses
 *     auto-inject on a later turn.
 *
 * The subagent-first-iter recovery (`tool_loop:subagent_first_iter_no_tool_call`)
 * is covered by the constructor-options test suite under the
 * `isSubagent` field. This file pins the parent-side detectors that
 * gate how the parent treats spawned subagents.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import type { AgentTool, ToolResult } from '../src/index';
import {
  testCtx,
  buildMockChat,
  buildEmitRecorder
} from './_helpers';

/** Fake `task` tool that records spawns and returns a synthetic
 *  task id. Always succeeds so the detector's
 *  !toolResults[idx]?.isError filter passes. */
function buildFakeTaskTool(captured: { spawns: Array<{ goal: string; background: boolean }> }): AgentTool {
  return {
    name: 'task',
    description: 'fake task tool for tests',
    parameters: [
      { name: 'goal', description: 'goal', required: true },
      { name: 'context', description: 'ctx', required: false },
      { name: 'run_in_background', description: 'bg', required: false }
    ],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      captured.spawns.push({
        goal: params.goal ?? '',
        background: String(params.run_in_background ?? '').toLowerCase() === 'true'
      });
      return { output: 'spawned task: bg-id-' + captured.spawns.length };
    }
  };
}

describe('fired-and-forgotten detector (tool_loop:fired_and_forgotten_nudge)', () => {
  const twoBackgroundTaskCalls = [
    '<tool_call>{"name":"task","params":{"goal":"audit packages/agent-core","run_in_background":"true"}}</tool_call>',
    '<tool_call>{"name":"task","params":{"goal":"audit apps/bandit-stealth","run_in_background":"true"}}</tool_call>'
  ].join('\n');

  it('fires when one iteration spawns 2+ background subagents', async () => {
    const captured = { spawns: [] as Array<{ goal: string; background: boolean }> };
    const registry = new ToolRegistry();
    registry.register(buildFakeTaskTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return twoBackgroundTaskCalls;
      return 'Waiting for subagents to land.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('audit the codebase', chat);
    expect(captured.spawns.length).toBe(2);
    expect(captured.spawns.every((s) => s.background)).toBe(true);
    const fires = events.filter((e) => e.type === 'tool_loop:fired_and_forgotten_nudge');
    expect(fires.length).toBe(1);
    expect((fires[0].payload as { backgroundSpawns?: number }).backgroundSpawns).toBe(2);
  });

  it('does NOT fire on a single background spawn', async () => {
    const captured = { spawns: [] as Array<{ goal: string; background: boolean }> };
    const registry = new ToolRegistry();
    registry.register(buildFakeTaskTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return '<tool_call>{"name":"task","params":{"goal":"audit one thing","run_in_background":"true"}}</tool_call>';
      }
      return 'OK.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('audit one thing', chat);
    expect(captured.spawns.length).toBe(1);
    const fires = events.filter((e) => e.type === 'tool_loop:fired_and_forgotten_nudge');
    expect(fires.length).toBe(0);
  });

  it('caps multiple foreground task calls to one blocking subagent', async () => {
    const captured = { spawns: [] as Array<{ goal: string; background: boolean }> };
    const registry = new ToolRegistry();
    registry.register(buildFakeTaskTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        // Two task calls but both foreground — sequential scoped work,
        // not the fan-out-and-poll pattern the detector targets.
        return [
          '<tool_call>{"name":"task","params":{"goal":"audit X"}}</tool_call>',
          '<tool_call>{"name":"task","params":{"goal":"audit Y","run_in_background":"false"}}</tool_call>'
        ].join('\n');
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('audit', chat);
    expect(captured.spawns.length).toBe(1);
    expect(captured.spawns[0].goal).toBe('audit X');
    expect(captured.spawns.every((s) => !s.background)).toBe(true);
    expect(events.filter((e) => e.type === 'tool_loop:fired_and_forgotten_nudge')).toHaveLength(0);
    const caps = events.filter((e) => e.type === 'tool_loop:foreground_task_fanout_capped');
    expect(caps).toHaveLength(1);
    expect(caps[0].payload).toMatchObject({ kept: 1, dropped: 1 });
  });

  it('tells the model why extra foreground task calls were dropped', async () => {
    const registry = new ToolRegistry();
    registry.register(buildFakeTaskTool({ spawns: [] }));
    let turn = 0;
    const { chat, recorder } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return [
          '<tool_call>{"name":"task","params":{"goal":"audit X"}}</tool_call>',
          '<tool_call>{"name":"task","params":{"goal":"audit Y"}}</tool_call>'
        ].join('\n');
      }
      return 'Done.';
    });
    const { emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('audit', chat);
    expect(recorder.callCount).toBeGreaterThanOrEqual(2);
    const retryMessages = recorder.calls[1].messages;
    const lastUser = [...retryMessages].reverse().find((m) => m.role === 'user');
    expect(lastUser?.content ?? '').toContain('foreground task subagents');
    expect(lastUser?.content ?? '').toContain('run_in_background="true"');
    expect(lastUser?.content ?? '').toContain('repo overviews');
  });

  it('is one-per-turn even when a later iteration spawns more background subagents', async () => {
    const captured = { spawns: [] as Array<{ goal: string; background: boolean }> };
    const registry = new ToolRegistry();
    registry.register(buildFakeTaskTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return twoBackgroundTaskCalls;
      if (turn === 2) {
        // Re-fire pressure: same shape on the next iter. The detector
        // should still only fire once per turn.
        return [
          '<tool_call>{"name":"task","params":{"goal":"audit C","run_in_background":"true"}}</tool_call>',
          '<tool_call>{"name":"task","params":{"goal":"audit D","run_in_background":"true"}}</tool_call>'
        ].join('\n');
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });

    await loop.run('big audit', chat);
    expect(captured.spawns.length).toBe(4);
    const fires = events.filter((e) => e.type === 'tool_loop:fired_and_forgotten_nudge');
    expect(fires.length).toBe(1);
  });

  it('appends a nudge listing the spawned goals', async () => {
    const registry = new ToolRegistry();
    registry.register(buildFakeTaskTool({ spawns: [] }));
    let turn = 0;
    const { chat, recorder } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return twoBackgroundTaskCalls;
      return 'Done.';
    });
    const { emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('audit', chat);
    // The next chat call after the nudge fires should include a user
    // message that mentions both spawned goals.
    expect(recorder.callCount).toBeGreaterThanOrEqual(2);
    const retryMessages = recorder.calls[1].messages;
    const lastUser = [...retryMessages].reverse().find((m) => m.role === 'user');
    expect(lastUser?.content ?? '').toContain('audit packages/agent-core');
    expect(lastUser?.content ?? '').toContain('audit apps/bandit-stealth');
    expect(lastUser?.content ?? '').toMatch(/auto-inject|terminate this turn|check_task/);
  });
});

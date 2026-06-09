/**
 * Contract tests for `applyGoalAnchorIfNeeded` — the per-iteration
 * goal-anchor injector extracted from ToolUseLoop.runWithMessages
 * (Arc 3 Session 3).
 *
 * Pins the eligibility floor, the refire gap, the aggressive-compaction
 * override, and the tool-list block that defends against the
 * "tool not registered" survivor + small/mid-model "tool doesn't exist"
 * hallucination after aggressive compaction. A break here means the
 * model starts drifting again on long tool-result chains, or anchor
 * messages fire too aggressively and burn prompt budget on every turn.
 */
import { describe, expect, it } from 'vitest';
import { applyGoalAnchorIfNeeded, GOAL_ANCHOR_REFIRE_GAP } from '../src/tools/loop/goalAnchor';
import { ToolRegistry } from '../src/tools/tool-registry';
import type { ToolLoopMessage, AgentTool } from '../src/index';
import { buildEmitRecorder } from './_helpers';

function bigPayload(targetChars: number): ToolLoopMessage {
  // Fills the messageTokens reduce so the >4000 floor trips.
  return { role: 'user', content: 'x'.repeat(targetChars) };
}

function emptyRegistry(): ToolRegistry {
  return new ToolRegistry();
}

function registryWith(names: string[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const name of names) {
    const tool: AgentTool = {
      name,
      description: `noop ${name}`,
      parameters: [],
      async execute() { return { output: 'ok' }; }
    };
    r.register(tool);
  }
  return r;
}

describe('applyGoalAnchorIfNeeded — short-circuit guards', () => {
  it('no-fire when originalGoal is empty', () => {
    const { emit, events } = buildEmitRecorder();
    const messages = [bigPayload(5000)];
    const result = applyGoalAnchorIfNeeded({
      originalGoal: '',
      priorUserPromptCount: 0,
      hitLimit: false,
      iteration: 5,
      lastGoalAnchorIteration: -1,
      aggressiveCompactionThisIteration: true, // override that would normally fire
      messages,
      registry: emptyRegistry(),
      emit
    });
    expect(result.anchored).toBe(false);
    expect(result.lastGoalAnchorIteration).toBe(-1);
    expect(events).toEqual([]);
    expect(messages).toHaveLength(1); // unchanged
  });

  it('no-fire when hitLimit (the loop is already wrapping up)', () => {
    const { emit, events } = buildEmitRecorder();
    const messages = [bigPayload(5000)];
    const result = applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 0,
      hitLimit: true,
      iteration: 5,
      lastGoalAnchorIteration: -1,
      aggressiveCompactionThisIteration: true,
      messages,
      registry: emptyRegistry(),
      emit
    });
    expect(result.anchored).toBe(false);
    expect(events).toEqual([]);
  });
});

describe('applyGoalAnchorIfNeeded — eligibility floor', () => {
  it('no-fire when iteration < 2 (too early to drift)', () => {
    const { emit } = buildEmitRecorder();
    const result = applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 0,
      hitLimit: false,
      iteration: 1,
      lastGoalAnchorIteration: -1,
      aggressiveCompactionThisIteration: false,
      messages: [bigPayload(5000)],
      registry: emptyRegistry(),
      emit
    });
    expect(result.anchored).toBe(false);
  });

  it('no-fire when messageTokens <= 4000 (not enough recency-bias risk)', () => {
    const { emit } = buildEmitRecorder();
    const result = applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 0,
      hitLimit: false,
      iteration: 5,
      lastGoalAnchorIteration: -1,
      aggressiveCompactionThisIteration: false,
      messages: [bigPayload(3000)],
      registry: emptyRegistry(),
      emit
    });
    expect(result.anchored).toBe(false);
  });

  it('fires when iteration >= 2 AND messageTokens > 4000 AND never anchored', () => {
    const { emit, events } = buildEmitRecorder();
    const messages: ToolLoopMessage[] = [bigPayload(5000)];
    const result = applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 0,
      hitLimit: false,
      iteration: 5,
      lastGoalAnchorIteration: -1,
      aggressiveCompactionThisIteration: false,
      messages,
      registry: emptyRegistry(),
      emit
    });
    expect(result.anchored).toBe(true);
    expect(result.lastGoalAnchorIteration).toBe(5);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_loop:goal_anchor');
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain('CURRENT GOAL');
    expect(messages[1].content).toContain('fix the bug');
  });
});

describe('applyGoalAnchorIfNeeded — refire gap', () => {
  it('does NOT refire before GOAL_ANCHOR_REFIRE_GAP iterations have passed', () => {
    const { emit } = buildEmitRecorder();
    const result = applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 0,
      hitLimit: false,
      iteration: 5 + GOAL_ANCHOR_REFIRE_GAP - 1, // one short
      lastGoalAnchorIteration: 5,
      aggressiveCompactionThisIteration: false,
      messages: [bigPayload(5000)],
      registry: emptyRegistry(),
      emit
    });
    expect(result.anchored).toBe(false);
  });

  it('refires when >= GOAL_ANCHOR_REFIRE_GAP iterations after the last anchor', () => {
    const { emit, events } = buildEmitRecorder();
    const newIter = 5 + GOAL_ANCHOR_REFIRE_GAP;
    const result = applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 0,
      hitLimit: false,
      iteration: newIter,
      lastGoalAnchorIteration: 5,
      aggressiveCompactionThisIteration: false,
      messages: [bigPayload(5000)],
      registry: emptyRegistry(),
      emit
    });
    expect(result.anchored).toBe(true);
    expect(result.lastGoalAnchorIteration).toBe(newIter);
    expect((events[0].payload as { refire: boolean }).refire).toBe(true);
  });
});

describe('applyGoalAnchorIfNeeded — aggressive-compaction override', () => {
  it('fires on aggressive compaction even when iteration < 2 (eligibility floor bypassed)', () => {
    const { emit, events } = buildEmitRecorder();
    const messages: ToolLoopMessage[] = [bigPayload(500)]; // tiny, would NOT trip eligibility
    const result = applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 0,
      hitLimit: false,
      iteration: 0,
      lastGoalAnchorIteration: -1,
      aggressiveCompactionThisIteration: true,
      messages,
      registry: emptyRegistry(),
      emit
    });
    expect(result.anchored).toBe(true);
    expect((events[0].payload as { postAggressiveCompaction: boolean }).postAggressiveCompaction).toBe(true);
  });

  it('fires on aggressive compaction even when refire gap not yet elapsed', () => {
    const { emit } = buildEmitRecorder();
    const result = applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 0,
      hitLimit: false,
      iteration: 6, // only 1 iteration after the last anchor
      lastGoalAnchorIteration: 5,
      aggressiveCompactionThisIteration: true,
      messages: [bigPayload(5000)],
      registry: emptyRegistry(),
      emit
    });
    expect(result.anchored).toBe(true);
  });

  it('post-aggressive anchor includes the CONTEXT JUST COMPACTED preamble', () => {
    const { emit } = buildEmitRecorder();
    const messages: ToolLoopMessage[] = [bigPayload(500)];
    applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 0,
      hitLimit: false,
      iteration: 0,
      lastGoalAnchorIteration: -1,
      aggressiveCompactionThisIteration: true,
      messages,
      registry: emptyRegistry(),
      emit
    });
    expect(messages[1].content).toContain('CONTEXT JUST COMPACTED');
    expect(messages[1].content).toContain('Do NOT fabricate `<tool_result>`');
  });
});

describe('applyGoalAnchorIfNeeded — tool-list block', () => {
  it('does NOT include a tool-list block on a non-aggressive eligibility-floor anchor', () => {
    const { emit } = buildEmitRecorder();
    const messages: ToolLoopMessage[] = [bigPayload(5000)];
    applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 0,
      hitLimit: false,
      iteration: 5,
      lastGoalAnchorIteration: -1,
      aggressiveCompactionThisIteration: false,
      messages,
      registry: registryWith(['read_file', 'write_file']),
      emit
    });
    expect(messages[1].content).not.toContain('TOOLS CURRENTLY AVAILABLE');
  });

  it('includes registered tools (MCP-namespaced first) on aggressive compaction', () => {
    const { emit } = buildEmitRecorder();
    const messages: ToolLoopMessage[] = [bigPayload(500)];
    applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 0,
      hitLimit: false,
      iteration: 0,
      lastGoalAnchorIteration: -1,
      aggressiveCompactionThisIteration: true,
      messages,
      registry: registryWith(['read_file', 'mcp__gmail.list', 'write_file', 'mcp__gmail.send']),
      emit
    });
    const anchor = messages[1].content;
    expect(anchor).toContain('TOOLS CURRENTLY AVAILABLE');
    expect(anchor).toContain('mcp__gmail.list');
    expect(anchor).toContain('mcp__gmail.send');
    expect(anchor).toContain('read_file');
    expect(anchor).toContain('write_file');
    // MCP-namespaced first: their offsets in the rendered block precede
    // the non-MCP ones.
    expect(anchor.indexOf('mcp__gmail.list')).toBeLessThan(anchor.indexOf('read_file'));
  });

  it('caps the tool list at 40 names and reports the overflow count', () => {
    const { emit } = buildEmitRecorder();
    const names = Array.from({ length: 50 }, (_, i) => `tool_${i}`);
    const messages: ToolLoopMessage[] = [bigPayload(500)];
    applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 0,
      hitLimit: false,
      iteration: 0,
      lastGoalAnchorIteration: -1,
      aggressiveCompactionThisIteration: true,
      messages,
      registry: registryWith(names),
      emit
    });
    expect(messages[1].content).toContain('(+10 more)');
  });
});

describe('applyGoalAnchorIfNeeded — multi-turn ignore-earlier suffix', () => {
  it('appends the "earlier prompts" warning when priorUserPromptCount > 0', () => {
    const { emit } = buildEmitRecorder();
    const messages: ToolLoopMessage[] = [bigPayload(5000)];
    applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 2,
      hitLimit: false,
      iteration: 5,
      lastGoalAnchorIteration: -1,
      aggressiveCompactionThisIteration: false,
      messages,
      registry: emptyRegistry(),
      emit
    });
    expect(messages[1].content).toContain('are 2 earlier user prompts');
    expect(messages[1].content).toContain('Do NOT answer them');
  });

  it('singular form when priorUserPromptCount === 1', () => {
    const { emit } = buildEmitRecorder();
    const messages: ToolLoopMessage[] = [bigPayload(5000)];
    applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 1,
      hitLimit: false,
      iteration: 5,
      lastGoalAnchorIteration: -1,
      aggressiveCompactionThisIteration: false,
      messages,
      registry: emptyRegistry(),
      emit
    });
    expect(messages[1].content).toContain('is 1 earlier user prompt');
    expect(messages[1].content).toContain('Do NOT answer it');
  });

  it('does NOT append the warning when priorUserPromptCount === 0', () => {
    const { emit } = buildEmitRecorder();
    const messages: ToolLoopMessage[] = [bigPayload(5000)];
    applyGoalAnchorIfNeeded({
      originalGoal: 'fix the bug',
      priorUserPromptCount: 0,
      hitLimit: false,
      iteration: 5,
      lastGoalAnchorIteration: -1,
      aggressiveCompactionThisIteration: false,
      messages,
      registry: emptyRegistry(),
      emit
    });
    expect(messages[1].content).not.toContain('earlier user prompt');
  });
});

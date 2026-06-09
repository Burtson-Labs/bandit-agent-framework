/**
 * Detector contracts for the gemma-family "won't act / asks in prose" cluster.
 *
 * - tool_loop:announce_intent_nudge — broadened to catch present-progressive
 *   narration ("I am on it", "I'm currently porting…", "I've already
 *   started…", "I'll keep pushing…"), not just "Let me X" / "I'll Y".
 * - tool_loop:ask_user_nudge — model asks the user to choose/approve in prose
 *   ("Shall I proceed?") while the `ask_user` tool is registered, and is about
 *   to exit the turn. Only fires when ask_user is actually available.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import type { AgentTool, ToolResult } from '../src/index';
import { testCtx, buildMockChat, buildEmitRecorder } from './_helpers';

function buildAskUserTool(): AgentTool {
  return {
    name: 'ask_user',
    description: 'Ask the user a question.',
    parameters: [{ name: 'questions', description: 'JSON array.', required: true }],
    async execute(): Promise<ToolResult> {
      return { output: 'answered' };
    }
  };
}

describe('announce-intent nudge — gemma progress narration', () => {
  it('fires on "I am on it / I\'m currently …ing" with no tool call', async () => {
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return "I am on it. I've already started and I'm currently porting the project structure.";
      return 'Standing by.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(new ToolRegistry(), testCtx, { emitEvent: emit, maxIterations: 4 });
    await loop.run('migrate the repo', chat);
    expect(events.filter((e) => e.type === 'tool_loop:announce_intent_nudge').length).toBe(1);
  });

  it('does NOT fire on a casual greeting reply ("I\'m doing well")', async () => {
    // Regression 2026-06-02: on "how are you this evening?" the model
    // replied "I'm doing well, thanks! I'm ready to help with whatever
    // you need. What can I work on for you?" — a perfectly fine
    // conversational answer with NO action announced. The old
    // NARRATE_PROGRESS_RE branch `i(?:'m| am)\s+\w+ing` matched
    // "I'm doing" (since "doing" ends in -ing), nudged the model that
    // it had announced intent without a tool call, and the loop ran
    // straight into the no-tool-call hard cap (5 retries) after 5
    // identical rewrites of the same greeting. The model's own
    // reasoning at iter 3+ literally said "this seems like a false
    // positive." Fix: the gerund branch now requires a syntactic
    // complement (preposition/article/object) after the -ing verb so
    // "doing well" / "feeling fine" / "going home" don't trip it.
    const { chat } = buildMockChat(() => {
      return "I'm doing well, thanks! I'm ready to help with whatever you need. What can I work on for you?";
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(new ToolRegistry(), testCtx, { emitEvent: emit, maxIterations: 4 });
    const result = await loop.run('how are you this evening?', chat);
    expect(events.filter((e) => e.type === 'tool_loop:announce_intent_nudge').length).toBe(0);
    expect(result.iterations).toBe(0);
    expect(result.finalResponse).toContain("doing well");
  });

  it('does NOT fire on other casual-greeting "I\'m [adverb]ing" patterns', async () => {
    // Three more shapes from the same family: present-progressive
    // with no real complement. All of these are reasonable
    // conversational responses that should NOT trip the stall detector.
    const probes = [
      "I'm feeling great today, thanks for asking!",
      "I'm going home now — talk tomorrow.",
      "I am doing fine, how about you?"
    ];
    for (const reply of probes) {
      const { chat } = buildMockChat(() => reply);
      const { events, emit } = buildEmitRecorder();
      const loop = new ToolUseLoop(new ToolRegistry(), testCtx, { emitEvent: emit, maxIterations: 4 });
      await loop.run('hey there', chat);
      expect(
        events.filter((e) => e.type === 'tool_loop:announce_intent_nudge').length,
        `should not nudge: ${reply}`
      ).toBe(0);
    }
  });

  it('STILL fires on real progress narration with a complement ("I\'m currently porting the runtime")', async () => {
    // Pin the still-load-bearing positive: the original captures the
    // detector was built to catch. Without this we'd be deleting the
    // detector by inaction.
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return "I'm currently porting the agent runtime — should be done in a minute.";
      return 'Standing by.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(new ToolRegistry(), testCtx, { emitEvent: emit, maxIterations: 4 });
    await loop.run('port the runtime', chat);
    expect(events.filter((e) => e.type === 'tool_loop:announce_intent_nudge').length).toBe(1);
  });
});

describe('ask_user nudge — prose decision-question while ask_user is available', () => {
  it('fires when the model asks "Shall I proceed?" and ask_user is registered', async () => {
    const registry = new ToolRegistry();
    registry.register(buildAskUserTool());
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return "Here's the plan to rebuild the site. Shall I proceed with the full migration?";
      return 'Standing by.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });
    await loop.run('rebuild the site', chat);
    expect(events.filter((e) => e.type === 'tool_loop:ask_user_nudge').length).toBe(1);
  });

  it('does NOT fire when ask_user is not registered', async () => {
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return "Here's the plan. Shall I proceed with the full migration?";
      return 'Standing by.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(new ToolRegistry(), testCtx, { emitEvent: emit, maxIterations: 4 });
    await loop.run('rebuild the site', chat);
    expect(events.filter((e) => e.type === 'tool_loop:ask_user_nudge').length).toBe(0);
  });
});

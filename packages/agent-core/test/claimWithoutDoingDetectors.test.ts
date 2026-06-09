/**
 * Detector contracts: the "claim without doing" cluster.
 *
 * - tool_loop:false_completion_nudge — model claims completion but no
 * edit tool ever fired.
 * - tool_loop:partial_completion_nudge — model claims edits to N files
 * but only M < N succeeded.
 * - tool_loop:announce_intent_nudge — short forward-looking response
 * ("Let me X next") with no tool call, where the loop would
 * otherwise terminate believing it was a final answer.
 *
 * Each test pins both the FIRING and the NOT-FIRING contract — the
 * one-per-turn cap, the precondition gates that prevent false
 * positives, and the visible side effect (event + appended nudge
 * message in the loop's message history).
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import type { AgentTool, ToolResult } from '../src/index';
import {
  testCtx,
  buildMockChat,
  buildEmitRecorder
} from './_helpers';

/** Tiny `write_file` mock so editToolsInvoked goes up on success. */
function buildWriteFileTool(captured: { writes: number }): AgentTool {
  return {
    name: 'write_file',
    description: 'Write a file.',
    parameters: [
      { name: 'path', description: 'Target path.', required: true },
      { name: 'content', description: 'Full file content.', required: true }
    ],
    async execute(): Promise<ToolResult> {
      captured.writes += 1;
      return { output: 'wrote ok' };
    }
  };
}

describe('false-completion detector (tool_loop:false_completion_nudge)', () => {
  it('fires when model claims completion but no edit tool ever fired', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        // Matches one of FALSE_COMPLETION_PATTERNS.
        return 'I have refactored the scoring logic and the implementation is improved.';
      }
      return 'Sorry, here is the real answer in plain prose now.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('refactor the scoring logic', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:false_completion_nudge');
    expect(fires.length).toBe(1);
  });

  it('does NOT fire when an edit tool successfully ran first', async () => {
    const captured = { writes: 0 };
    const registry = new ToolRegistry();
    registry.register(buildWriteFileTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return '<tool_call>{"name":"write_file","params":{"path":"a.ts","content":"x"}}</tool_call>';
      }
      if (turn === 2) {
        // Same false-completion phrasing, but this time it's truthful
        // (a write actually fired). Detector should NOT fire.
        return 'I have refactored the scoring logic and the implementation is improved.';
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('refactor', chat);
    expect(captured.writes).toBe(1);
    const fires = events.filter((e) => e.type === 'tool_loop:false_completion_nudge');
    expect(fires.length).toBe(0);
  });

  it('is one-per-turn even when the pattern matches twice', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn <= 2) {
        // Both responses match FALSE_COMPLETION_PATTERNS. Detector
        // should still only fire once.
        return 'I have refactored the file already; you can find the updated implementation above.';
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('refactor', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:false_completion_nudge');
    expect(fires.length).toBe(1);
  });

  it('appends a nudge message to the loop history when it fires', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat, recorder } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return 'I have refactored the implementation and improved the code.';
      }
      return 'OK, real answer now.';
    });
    const { emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('refactor', chat);
    // The retry call (recorder.calls[1]) should include a `user` nudge
    // appended after the model's claim.
    expect(recorder.callCount).toBeGreaterThanOrEqual(2);
    const retryMessages = recorder.calls[1].messages;
    const lastUser = [...retryMessages].reverse().find((m) => m.role === 'user');
    expect(lastUser?.content ?? '').toMatch(/write_file|apply_edit|tool call|nothing on disk/i);
  });
});

describe('partial-completion detector (tool_loop:partial_completion_nudge)', () => {
  it('fires when model references more files than actually edited', async () => {
    const captured = { writes: 0 };
    const registry = new ToolRegistry();
    registry.register(buildWriteFileTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        // One real edit.
        return '<tool_call>{"name":"write_file","params":{"path":"a.ts","content":"x"}}</tool_call>';
      }
      if (turn === 2) {
        // Wrap-up references THREE distinct files but only one edit ran.
        return 'I refactored `src/foo.ts`, `src/bar.ts`, and `src/baz.ts` to use the new API.';
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('refactor', chat);
    expect(captured.writes).toBe(1);
    const fires = events.filter((e) => e.type === 'tool_loop:partial_completion_nudge');
    expect(fires.length).toBe(1);
    const payload = fires[0].payload as { editToolsInvoked?: number; claimedFiles?: number };
    expect(payload.editToolsInvoked).toBe(1);
    expect(payload.claimedFiles).toBeGreaterThanOrEqual(3);
  });

  it('does NOT fire when claimed file count matches actual edits', async () => {
    const captured = { writes: 0 };
    const registry = new ToolRegistry();
    registry.register(buildWriteFileTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return '<tool_call>{"name":"write_file","params":{"path":"a.ts","content":"x"}}</tool_call>';
      }
      if (turn === 2) {
        // Honest wrap-up: one file edited, one file referenced.
        return 'I updated `src/a.ts` with the new helper.';
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('update', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:partial_completion_nudge');
    expect(fires.length).toBe(0);
  });
});

describe('announce-then-stall detector (tool_loop:announce_intent_nudge)', () => {
  it('fires on a short "Let me X" response with no tool call', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return 'Let me investigate the package layout next.';
      }
      return 'OK, here is a real answer.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('explore the repo', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:announce_intent_nudge');
    expect(fires.length).toBe(1);
  });

  it('does NOT fire when the response is a long wrap-up (>600 visible chars)', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        // Starts with "Let me explain" — would match the verb if short
        // enough. But this is a full wrap-up well past the 600-char
        // visible cap, so it must NOT trigger.
        return 'Let me explain the architecture in detail. ' + 'The system is composed of three layers, each with its own responsibilities. '.repeat(20);
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('explain', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:announce_intent_nudge');
    expect(fires.length).toBe(0);
  });

  it('does NOT fire when the response has no announce verb', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        // Plain answer, no "let me / I'll X" verb pattern.
        return 'The repo is a TypeScript monorepo with apps and packages directories.';
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('what is this repo', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:announce_intent_nudge');
    expect(fires.length).toBe(0);
  });

  it('is one-per-turn (does not refire on a second matching iteration)', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn <= 2) {
        return 'Let me investigate the package layout.';
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('explore', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:announce_intent_nudge');
    expect(fires.length).toBe(1);
  });
});

// pattern expansion for Gemma 4 / bandit-core-1 false-
// completion phrasings observed on 2026-05-12 (turn 1bec). The model
// emitted fake bandit-tl cards, got nudged by the hallucination
// detector, then escaped into pure-prose lying with verbs the existing
// patterns didn't cover ("eliminated", "resolved", "cleaned",
// "verified via linter"). Each new test exercises one of the added
// patterns.
describe('false-completion detector — Gemma 4 prose-lying patterns (v1.7.245)', () => {
  function recorder() {
    const events: Array<{ type: string }> = [];
    return { events, emit: (type: string) => { events.push({ type }); } };
  }

  it.each([
    ['I have successfully eliminated all critical errors in the project.', '"successfully eliminated"'],
    ['I have successfully fixed the implicit boolean coercions.', '"successfully fixed"'],
    ['I\'ve resolved the type errors in the registry.', '"I\'ve resolved"'],
    ['I have cleaned up the style warnings.', '"I have cleaned"'],
    ['The project is now in a healthy state with no blocking lint errors.', '"now in a healthy state"'],
    ['Verified via Linter: critical error count dropped from 16+ to 0.', '"verified via linter" + "dropped from N to 0"'],
    ['I have removed the forbidden require() calls.', '"I have removed"']
    // NOTE: "I converted X successfully" (trailing "successfully")
    // is not in the pattern set — the patterns require "successfully"
    // BEFORE the verb. Models observed in 2026-05-12 turns always
    // emitted the prefix form ("successfully eliminated"); if a future
    // failure trace shows the suffix form, extend the regex.
  ])('fires on phrase: %s (matches %s)', async (phrase) => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return phrase;
      return 'Plain answer.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });
    await loop.run('fix the lint', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:false_completion_nudge');
    expect(fires.length).toBeGreaterThanOrEqual(1);
  });

  // Reference recorder() above to silence unused-var lint while the test
  // helper stays available for future cases that need raw event capture.
  it('reference helper to suppress unused-var (no-op)', () => {
    const r = recorder();
    r.emit('x');
    expect(r.events.length).toBe(1);
  });

  it('does NOT fire on intent phrasing ("I will fix") — only completion-claim verbs', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() =>
      'I will fix the lint errors and clean up the warnings in the next step.'
    );
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });
    await loop.run('fix lint', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:false_completion_nudge');
    expect(fires.length).toBe(0);
  });
});

describe('subject-not-modified detector (tool_loop:subject_not_modified_nudge)', () => {
  /** read_file mock that records the path so the loop's filesReadThisTurn
   *  set picks it up. The actual content doesn't matter for the detector. */
  function buildReadFileTool(captured: { reads: string[] }): AgentTool {
    return {
      name: 'read_file',
      description: 'Read a file.',
      parameters: [{ name: 'path', description: 'Target path.', required: true }],
      async execute(params): Promise<ToolResult> {
        const p = (params as Record<string, string>).path ?? '';
        captured.reads.push(p);
        return { output: `// fake contents of ${p}` };
      }
    };
  }

  it('fires when goal is a refactor AND read-set is disjoint from write-set', async () => {
    const writes = { writes: 0 };
    const reads: { reads: string[] } = { reads: [] };
    const registry = new ToolRegistry();
    registry.register(buildWriteFileTool(writes));
    registry.register(buildReadFileTool(reads));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        // Read App.jsx for context.
        return '<tool_call>{"name":"read_file","params":{"path":"src/App.jsx"}}</tool_call>';
      }
      if (turn === 2) {
        // Write a NEW component instead of editing App.jsx.
        return '<tool_call>{"name":"write_file","params":{"path":"src/components/Hero.jsx","content":"export default function Hero(){}"}}</tool_call>';
      }
      // Wrap-up prose — no further tool calls. Detector should now fire
      // because the source App.jsx was never modified.
      return 'I created the Hero component for the refactor.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });

    await loop.run('refactor App.jsx and break it out into smaller components', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:subject_not_modified_nudge');
    expect(fires.length).toBe(1);
  });

  it('does NOT fire when the source file IS modified', async () => {
    const writes = { writes: 0 };
    const reads: { reads: string[] } = { reads: [] };
    const registry = new ToolRegistry();
    registry.register(buildWriteFileTool(writes));
    registry.register(buildReadFileTool(reads));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return '<tool_call>{"name":"read_file","params":{"path":"src/App.jsx"}}</tool_call>';
      }
      if (turn === 2) {
        // Both: write a new component AND edit the source.
        return '<tool_call>{"name":"write_file","params":{"path":"src/components/Hero.jsx","content":"x"}}</tool_call>\n' +
          '<tool_call>{"name":"write_file","params":{"path":"src/App.jsx","content":"import Hero from \'./components/Hero\';"}}</tool_call>';
      }
      return 'Refactor complete.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });

    await loop.run('refactor App.jsx and split out components', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:subject_not_modified_nudge');
    expect(fires.length).toBe(0);
  });

  it('does NOT fire when the goal is non-refactor (scaffolding from scratch)', async () => {
    const writes = { writes: 0 };
    const reads: { reads: string[] } = { reads: [] };
    const registry = new ToolRegistry();
    registry.register(buildWriteFileTool(writes));
    registry.register(buildReadFileTool(reads));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return '<tool_call>{"name":"read_file","params":{"path":"package.json"}}</tool_call>';
      }
      if (turn === 2) {
        return '<tool_call>{"name":"write_file","params":{"path":"src/new.ts","content":"x"}}</tool_call>';
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });

    // No refactor verb in the goal → detector should stay quiet even
    // though read-set (package.json) is disjoint from write-set (new.ts).
    await loop.run('add a new utility file', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:subject_not_modified_nudge');
    expect(fires.length).toBe(0);
  });

  it('is one-shot per turn even if multiple wrap-up iterations occur', async () => {
    const writes = { writes: 0 };
    const reads: { reads: string[] } = { reads: [] };
    const registry = new ToolRegistry();
    registry.register(buildWriteFileTool(writes));
    registry.register(buildReadFileTool(reads));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return '<tool_call>{"name":"read_file","params":{"path":"src/main.ts"}}</tool_call>';
      if (turn === 2) return '<tool_call>{"name":"write_file","params":{"path":"src/sibling.ts","content":"x"}}</tool_call>';
      // Even though we keep emitting wrap-up prose, the detector cap
      // (one-per-turn) prevents N nudges from stacking up.
      return 'Refactor complete — see the new sibling file.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });

    await loop.run('refactor main.ts and split out the helpers', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:subject_not_modified_nudge');
    expect(fires.length).toBeLessThanOrEqual(1);
  });
});

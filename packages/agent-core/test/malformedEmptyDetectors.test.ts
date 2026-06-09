/**
 * Detector contracts: the "malformed or empty" cluster.
 *
 *   - tool_loop:empty_retry — model returned an empty response, a
 *     reasoning-only fence, or a "let me X" narrate-no-action shape.
 *     Capped at 2 retries (consecutiveEmptyRetries < 2). Each retry
 *     pushes a corrective nudge.
 *   - tool_loop:thinking_off_recovery — after at least one empty
 *     retry has fired, the loop forces `think: false` for one more
 *     attempt to break out of reasoning-only stalls. One-shot.
 *   - tool_loop:parse_retry — model emitted `<tool_call>` markup but
 *     the inner JSON didn't parse. Capped at PARSE_RETRY_CAP=2; first
 *     retry suggests escape fixes, second suggests switching tools.
 *
 * These three are the loop's "the model output looks broken"
 * recovery sequence — they fire in roughly that order as a stall
 * compounds. Tests pin firing conditions, retry caps, and the side
 * effects (think mode forced, nudge messages appended).
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import {
  testCtx,
  buildMockChat,
  buildEmitRecorder
} from './_helpers';

describe('empty-retry / shouldNudge (tool_loop:empty_retry)', () => {
  it('fires on a completely empty response', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return ''; // empty
      return 'Real answer now.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('do something', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:empty_retry');
    expect(fires.length).toBe(1);
    expect((fires[0].payload as { attempt?: number; reasoningOnly?: boolean; narratedButNoAction?: boolean }).attempt).toBe(1);
  });

  it('fires on a reasoning-only fence', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return '\n```bandit-reasoning\nThinking through the problem.\n```\n';
      return 'Real answer.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('explore', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:empty_retry');
    expect(fires.length).toBe(1);
    expect((fires[0].payload as { reasoningOnly?: boolean }).reasoningOnly).toBe(true);
  });

  it('fires on a narratedButNoAction "let me X" shape', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      // Short forward-looking prose with an investigation verb in the
      // tail, no tool call. Length must be < 240 chars to trip the
      // narratedButNoAction gate.
      if (turn === 1) return 'Let me check the package.json file next.';
      return 'Real answer.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('what is here', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:empty_retry');
    expect(fires.length).toBe(1);
    expect((fires[0].payload as { narratedButNoAction?: boolean }).narratedButNoAction).toBe(true);
  });

  it('caps at 2 CONSECUTIVE retries (counter resets after thinking-off-recovery)', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      // Empty for two passes, then a non-empty/non-stall response to
      // exit cleanly. We're pinning the "cap is 2 CONSECUTIVE" shape:
      // after thinking-off-recovery resets consecutiveEmptyRetries to
      // 0, more empty responses would re-fire the nudge from a clean
      // count. Test inputs here stop the stall before that path.
      if (turn <= 2) return '';
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('do it', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:empty_retry');
    expect(fires.length).toBe(2);
    expect((fires[0].payload as { attempt?: number }).attempt).toBe(1);
    expect((fires[1].payload as { attempt?: number }).attempt).toBe(2);
  });

  it('thinking-off-recovery still resets the consecutive empty counter, but the turn-level hard cap terminates the loop overall (v1.7.297 contract, extended for prefill_recovery)', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => '');
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 7 });

    await loop.run('do it', chat);
    // Trace with hard cap (NO_TOOL_CALL_HARD_CAP=5):
    //   pass 1 (cap=1): consecutive=1, empty_retry fires
    //   pass 2 (cap=2): consecutive=2, empty_retry fires
    //   pass 3 (cap=3): consecutive=2 (cap), thinking_off_recovery fires
    //   pass 4 (cap=4): thinkingOffRecoveryAttempted → prefill_recovery fires
    //   pass 5 (cap=5): HARD CAP fires → stuck answer, loop exits
    // shouldNudge is gated on !thinkingOffRecoveryAttempted so a second
    // empty_retry sequence does NOT fire after thinking-off resets the
    // consecutive counter — the loop walks straight to prefill_recovery.
    const empty = events.filter((e) => e.type === 'tool_loop:empty_retry');
    const thinkOff = events.filter((e) => e.type === 'tool_loop:thinking_off_recovery');
    const prefill = events.filter((e) => e.type === 'tool_loop:prefill_recovery');
    const hardCap = events.filter((e) => e.type === 'tool_loop:no_tool_call_hard_cap');
    expect(empty.length).toBe(2);
    expect(thinkOff.length).toBe(1);
    expect(prefill.length).toBe(1);
    expect(hardCap.length).toBe(1);
  });
});

describe('prefill-recovery (tool_loop:prefill_recovery)', () => {
  it('fires after thinking_off_recovery when the stall persists', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => '\n```bandit-reasoning\nThinking again.\n```\n');
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 7 });

    await loop.run('do it', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:prefill_recovery');
    expect(fires.length).toBe(1);
    expect((fires[0].payload as { prefix?: string }).prefix).toBe('<tool_call>{"name":"');
  });

  it('prepends the prefill prefix to the recovery response so a complete tool_call envelope reaches the parser', async () => {
    const registry = new ToolRegistry();
    // Register a tool the recovery will invoke.
    registry.register({
      name: 'noop',
      description: 'no-op test tool',
      parameters: [],
      async execute() {
        return { output: 'ok' };
      }
    });
    let turn = 0;
    const { chat, recorder } = buildMockChat(() => {
      turn += 1;
      // Turns 1-4 stall as reasoning-only so the loop walks through
      // empty_retry ×2 + thinking_off_recovery and then triggers
      // prefill_recovery after turn 4. Turn 5 is the prefill attempt:
      // the loop has just pushed `<tool_call>{"name":"` as the trailing
      // assistant message, so the mock returns only the completion tail
      // and the loop prepends the prefix before parsing.
      // Turn 6+ returns a clean prose final answer so the loop exits
      // cleanly — without this the loop would walk into a second stall
      // stretch (legitimate behaviour after the budget-reset fix, but
      // out of scope for this test which only validates the prefix glue).
      if (turn === 5) return 'noop","params":{}}</tool_call>';
      if (turn >= 6) return 'Done.';
      return '\n```bandit-reasoning\nThinking.\n```\n';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 7 });

    await loop.run('do it', chat);
    // The event sequence is the proof: prefill_recovery fires, then the
    // very next chat round produces a tool_calls event that executes
    // `noop`. If the prefill push or the prepend was broken, the response
    // would parse as garbled prose and tool_calls wouldn't fire.
    // (Recorder.calls.messages can't be inspected per-call because
    // buildMockChat stores the messages array by reference, so every
    // entry sees the same final state.)
    const prefill = events.filter((e) => e.type === 'tool_loop:prefill_recovery');
    expect(prefill.length).toBe(1);
    const prefillIdx = events.findIndex((e) => e.type === 'tool_loop:prefill_recovery');
    const subsequent = events.slice(prefillIdx);
    const tcIdx = subsequent.findIndex((e) => e.type === 'tool_loop:tool_calls');
    expect(tcIdx).toBeGreaterThan(-1);
    const toolResults = events.filter((e) => e.type === 'tool_loop:tool_result');
    expect(toolResults.some((e) => (e.payload as { name?: string }).name === 'noop')).toBe(true);
  });

  it('fires at most once per uninterrupted stall stretch', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => '\n```bandit-reasoning\nStill stuck.\n```\n');
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 10 });

    await loop.run('do it', chat);
    const prefill = events.filter((e) => e.type === 'tool_loop:prefill_recovery');
    expect(prefill.length).toBe(1);
  });

  it('fires again on a second stall stretch when a successful tool call resets the budget', async () => {
    // Regression from a real run: 26 iterations.
    // First stall stretch was rescued by prefill at iter 25, model
    // resumed, did real work, then stalled again at iter 26 with no
    // recovery left and fell through to the terminal "Bandit stalled"
    // message. The fix resets `prefillRecoveryAttempted` whenever a
    // tool call lands so the second stretch has the same budget as the
    // first. Hard cap on `noToolCallAttemptsThisTurn` (5) prevents an
    // infinite loop.
    const registry = new ToolRegistry();
    registry.register({
      name: 'noop',
      description: 'no-op test tool',
      parameters: [],
      async execute() {
        return { output: 'ok' };
      }
    });
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      // Stretch 1 (turns 1-4): reasoning-only walks the ladder —
      //   turn 1: empty_retry (consec=1)
      //   turn 2: empty_retry (consec=2)
      //   turn 3: thinking_off_recovery (consec reset to 0)
      //   turn 4: prefill_recovery (prefix queued)
      // Turn 5: prefill prefix is on the wire; the mock returns just the
      //   completion tail and the loop prepends the prefix to form a
      //   valid <tool_call> envelope. Tool fires → both
      //   noToolCallAttemptsThisTurn and prefillRecoveryAttempted reset.
      // Stretch 2 (turn 6): another reasoning-only stall. shouldNudge
      //   and thinking_off are gated out (thinking_off was already
      //   attempted earlier in the turn and is never reset), so the
      //   loop walks straight to prefill_recovery #2.
      // Turn 7: prefill #2 completion tail.
      if (turn === 5 || turn === 7) return 'noop","params":{}}</tool_call>';
      // After the second tool call, return a prose final answer so the
      // loop exits cleanly rather than walking into a third stall stretch
      // (which would also fire prefill #3 — valid behaviour but noise
      // for this test).
      if (turn >= 8) return 'Done.';
      return '\n```bandit-reasoning\nStill thinking.\n```\n';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 15 });

    await loop.run('do it', chat);
    const prefill = events.filter((e) => e.type === 'tool_loop:prefill_recovery');
    expect(prefill.length).toBe(2);
    // And both prefills actually produced tool calls (not just empty no-ops).
    const toolResults = events.filter((e) => e.type === 'tool_loop:tool_result');
    expect(toolResults.filter((e) => (e.payload as { name?: string }).name === 'noop').length).toBe(2);
  });
});

describe('thinking-off-recovery (tool_loop:thinking_off_recovery)', () => {
  it('fires after at least one empty_retry when the stall continues', async () => {
    const registry = new ToolRegistry();
    const { chat, recorder } = buildMockChat(() => {
      // Always reasoning-only — the stall sequence is:
      //   pass 1: empty_retry (consecutive=1)
      //   pass 2: empty_retry (consecutive=2)
      //   pass 3: cap exhausted → thinking_off_recovery fires
      return '\n```bandit-reasoning\nReasoning about it.\n```\n';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('do it', chat);
    const recovery = events.filter((e) => e.type === 'tool_loop:thinking_off_recovery');
    expect(recovery.length).toBe(1);
    expect((recovery[0].payload as { reason?: string }).reason).toBe('reasoning_only_cap_exhausted');
    // The recovery call should have think: false in its options.
    // Find the chat call that came AFTER the thinking_off_recovery event
    // was emitted by counting calls — recovery fires between calls so
    // the next call (recorder.calls[3]) is the think:false one.
    expect(recorder.callCount).toBeGreaterThanOrEqual(4);
    expect(recorder.calls[3].options?.think).toBe(false);
  });

  it('is one-shot per turn (does not refire if stall persists)', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => '\n```bandit-reasoning\nstuck.\n```\n');
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 8 });

    await loop.run('do it', chat);
    const recovery = events.filter((e) => e.type === 'tool_loop:thinking_off_recovery');
    expect(recovery.length).toBe(1);
  });

  it('does NOT fire when there has been no prior empty_retry (consecutive must be >= 1)', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      // First response is normal prose — no empty_retry fires.
      // Subsequent are short answers with no stall shape.
      if (turn === 1) return 'The repository is a TypeScript monorepo with apps and packages.';
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('what is this', chat);
    const recovery = events.filter((e) => e.type === 'tool_loop:thinking_off_recovery');
    expect(recovery.length).toBe(0);
  });
});

describe('parse-retry (tool_loop:parse_retry)', () => {
  // Note: parse-retry's precondition is `looksLikeAttemptedToolCall &&
  // !hasToolCalls`. The `hasToolCalls` extractor rejects blocks where
  // the inner JSON is unbalanced OR no `</tool_call>` closer follows.
  // Inputs with balanced inner JSON (even if it fails JSON.parse on
  // strings) are still extracted by findXmlBlocks and reported as
  // having tool calls — they bypass parse-retry. The test inputs
  // below use a truncated `<tool_call>` (no closing tag) so the
  // extractor rejects the block and parse-retry actually fires.
  const truncatedToolCall = '<tool_call>{"name":"write_file","params":{"path":"a.ts"';

  it('fires when response has <tool_call> markup but the block does not extract', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return truncatedToolCall;
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('write the file', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:parse_retry');
    expect(fires.length).toBe(1);
    expect((fires[0].payload as { attempt?: number }).attempt).toBe(1);
  });

  it('caps at PARSE_RETRY_CAP (2) when the model keeps returning malformed markup', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      // Keep returning malformed markup. Cap is 2; third attempt
      // should fall through to the loop's terminal handling.
      if (turn <= 4) return truncatedToolCall;
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('write the file', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:parse_retry');
    expect(fires.length).toBe(2);
    expect((fires[0].payload as { attempt?: number }).attempt).toBe(1);
    expect((fires[1].payload as { attempt?: number }).attempt).toBe(2);
  });

  it('does NOT fire on a clean tool call that parses successfully', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return '<tool_call>{"name":"write_file","params":{"path":"a.ts","content":"export const x = 1;"}}</tool_call>';
      }
      return 'Done.';
    });
    registry.register({
      name: 'write_file',
      description: 'write',
      parameters: [
        { name: 'path', description: 'p', required: true },
        { name: 'content', description: 'c', required: true }
      ],
      async execute() { return { output: 'ok' }; }
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('write the file', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:parse_retry');
    expect(fires.length).toBe(0);
  });

  it('first-retry nudge mentions JSON escaping; second-retry nudge mentions switching tactics', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat, recorder } = buildMockChat(() => {
      turn += 1;
      if (turn <= 3) return truncatedToolCall;
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('write the file', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:parse_retry');
    expect(fires.length).toBe(2);

    // The retry nudges land as user messages between chat calls. The
    // first retry's nudge appears in calls[1].messages, the second
    // retry's nudge appears in calls[2].messages.
    const firstRetryUserMessages = recorder.calls[1].messages.filter((m) => m.role === 'user');
    const lastFirst = firstRetryUserMessages[firstRetryUserMessages.length - 1];
    expect(lastFirst.content).toMatch(/escap/i);

    const secondRetryUserMessages = recorder.calls[2].messages.filter((m) => m.role === 'user');
    const lastSecond = secondRetryUserMessages[secondRetryUserMessages.length - 1];
    // Second retry hints at a tactic switch (write_file vs apply_edit
    // split) — the nudge text mentions one of those alternatives.
    expect(lastSecond.content).toMatch(/write_file|apply_edit|split|switch tactic/i);
  });
});

describe('narrate-but-no-action terminal annotator (loop.run finalResponse)', () => {
  it('appends a stall note when the model ends with "Let me X:" prose but no tool_call AND the inline empty-retry detector is exhausted — Portfolio 2026-05-31 regression', async () => {
    // Reproduces Portfolio 2026-05-31T17-39-53 cleanup turn: after a
    // native→text channel recovery, the model emitted a bandit-
    // reasoning block followed by "Let me revert it:" prose with a
    // dangling colon and NO tool_call. The user read the prose,
    // waited for an action, and got silence — Bandit's chat ended
    // there. The inline empty_retry / narratedButNoAction detector
    // couldn't nudge because consecutiveEmptyRetries was already at
    // its cap from prior iterations. The terminal annotator catches
    // this and appends a stall note so the user knows the turn died
    // mid-action.
    const narrateNoAction =
      '\n```bandit-reasoning\nI see the issue now. The menuRef is attached to a div wrapper, not a button. ' +
      'So the ref type should remain HTMLDivElement. My "fix" was wrong. Let me revert it back.\n```\n' +
      'I see the issue — `menuRef` is attached to a `<div>` wrapper on line 52, so `HTMLDivElement` was correct. ' +
      'My change was wrong. Let me revert it:';

    const registry = new ToolRegistry();
    // Return narrate-no-action repeatedly so consecutiveEmptyRetries
    // saturates and the inline detector stops nudging. By the time
    // maxIterations exhausts, the loop falls through to the terminal
    // return — where the annotator must rescue the response.
    const { chat } = buildMockChat(() => narrateNoAction);
    const { emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 3 });

    const result = await loop.run('revert the bad edit', chat);

    // The model's original prose IS preserved (user still sees what
    // the model was thinking) — the annotator APPENDS, doesn't
    // replace.
    expect(result.finalResponse).toMatch(/Let me revert it:/);
    // And a clear stall note is appended explaining what happened.
    expect(result.finalResponse).toMatch(/announced this action but did not emit the tool call/);
    // The note specifically mentions upstream retries because that's
    // the canonical cause (and lets the user diagnose by checking
    // status messages from the turn).
    expect(result.finalResponse).toMatch(/Upstream hiccup/);
    expect(result.finalResponse).toMatch(/Re-prompt with the same request/);
  });

  it('does NOT annotate a normal final answer that happens to contain "let me know" or other false-positive phrases', async () => {
    // Regression guard: NARRATE_VERB_RE doesn't include "know",
    // "thank", "happy", etc., so a closing "Let me know if you'd
    // like more detail." should NOT get the stall annotation.
    const normalFinalAnswer =
      'Done. I updated the file, ran the tests, and they pass. Let me know if you\'d like me to push the changes.';

    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => normalFinalAnswer);
    const { emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 2 });

    const result = await loop.run('do the thing', chat);

    expect(result.finalResponse).toMatch(/Done\./);
    expect(result.finalResponse).not.toMatch(/announced this action but did not emit/);
  });

  it('appends a stall note when the model ends with "Let me X." prose (period ending) AND an action verb — real-run 2026-06-03 regression', async () => {
    // Reproduces a real-run final-iter
    // failure: after all in-turn recovery paths (empty-retry,
    // thinking-off, prefill) had been spent on earlier stalls, the
    // model emitted reasoning + "Let me fix all three project cards
    // at once." with NO tool_call. Period-terminated, not colon —
    // so the prior annotator (colon-only) didn't trigger and the
    // user saw the narrate prose as the final answer.
    const narrateNoActionPeriod =
      '\n```bandit-reasoning\nI can see the project cards still use class="project-tag" instead of class="tag", ' +
      'and the links aren\'t wrapped in <div class="project-links">. Let me fix these HTML issues now.\n```\n' +
      'I see the HTML still uses `class="project-tag"` and lacks the `.project-links` wrapper. ' +
      'Let me fix all three project cards at once.';

    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => narrateNoActionPeriod);
    const { emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 3 });

    const result = await loop.run('refactor the project cards', chat);

    expect(result.finalResponse).toMatch(/Let me fix all three project cards at once\./);
    expect(result.finalResponse).toMatch(/announced this action but did not emit the tool call/);
  });

  it('does NOT annotate a period-ending response that hits NARRATE_INTENT_RE but lacks an action verb', async () => {
    // Stronger regression guard for the new period path. "Let me
    // know" matches the intent regex but "know" isn't a NARRATE_VERB,
    // so the period gate must SKIP the annotation. Without the verb
    // requirement on the period path, every "Let me know if X."
    // sign-off would get the unhelpful stall suffix.
    const politeSignOff =
      'I refactored the component, extracted the helper, and updated the imports. ' +
      'The tests still pass. Let me know if you\'d like a different name for the helper.';

    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => politeSignOff);
    const { emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 2 });

    const result = await loop.run('refactor the component', chat);

    expect(result.finalResponse).toMatch(/Let me know if you'd like/);
    expect(result.finalResponse).not.toMatch(/announced this action but did not emit/);
  });
});

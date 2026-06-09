/**
 * Module-boundary contract tests for `tryAnnounceIntentNudge` and
 * `tryAskUserNudge` — extracted from ToolUseLoop.runWithMessages
 * (Arc 3 Session 3).
 *
 * The end-to-end behavior is also pinned by `intentNudgeDetectors.test.ts`
 * (which exercises the detectors through `ToolUseLoop.run`). This file
 * pins the function-level contract directly:
 *   - empty `finalResponse` is a hard no-op (no event, no message)
 *   - the reasoning-fence stripper runs BEFORE the regex check
 *   - the 600-char visible-length cap on announce-intent
 *   - the `\?\s*$` end-of-string anchor on ask-user (no false-positive
 *     on a paragraph that contains a `?` mid-text)
 *   - `askUserAvailable: false` is a hard no-op
 */
import { describe, expect, it } from 'vitest';
import { tryAnnounceIntentNudge, tryAskUserNudge } from '../src/tools/loop/finalAnswerNudges';
import { buildEmitRecorder } from './_helpers';

describe('tryAnnounceIntentNudge', () => {
  it('no-op on empty finalResponse', () => {
    const { emit, events } = buildEmitRecorder();
    const result = tryAnnounceIntentNudge({ finalResponse: '', iteration: 0, emit });
    expect(result.fired).toBe(false);
    expect(result.message).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('fires on "Let me investigate the codebase"', () => {
    const { emit, events } = buildEmitRecorder();
    const result = tryAnnounceIntentNudge({
      finalResponse: 'Let me investigate the codebase to find the bug.',
      iteration: 3,
      emit
    });
    expect(result.fired).toBe(true);
    expect(result.message?.role).toBe('user');
    expect(result.message?.content).toContain('Take the action now');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_loop:announce_intent_nudge');
  });

  it('fires on the gerund branch with a complement ("I\'m currently porting the runtime")', () => {
    const { emit } = buildEmitRecorder();
    const result = tryAnnounceIntentNudge({
      finalResponse: "I'm currently porting the agent runtime.",
      iteration: 0,
      emit
    });
    expect(result.fired).toBe(true);
  });

  it('does NOT fire on casual-greeting gerunds without a complement ("I\'m doing well")', () => {
    // Regression 2026-06-02. The gerund branch's complement requirement
    // is what makes this not match.
    const { emit, events } = buildEmitRecorder();
    const result = tryAnnounceIntentNudge({
      finalResponse: "I'm doing well, thanks! I'm ready to help.",
      iteration: 0,
      emit
    });
    expect(result.fired).toBe(false);
    expect(events).toEqual([]);
  });

  it('does NOT fire on long wrap-ups (visible length > 600 chars)', () => {
    const { emit } = buildEmitRecorder();
    const padded = 'Let me explain what I did. ' + 'x'.repeat(700);
    const result = tryAnnounceIntentNudge({ finalResponse: padded, iteration: 0, emit });
    expect(result.fired).toBe(false);
  });

  it('strips reasoning fences before the regex check', () => {
    // Reasoning fence in front of the announce-intent opener — without
    // the strip, the opener wouldn't be visible at position 0.
    const { emit } = buildEmitRecorder();
    const text =
      '```bandit-reasoning\nThinking through approach.\n```\n' +
      "Let me explore the relevant files.";
    const result = tryAnnounceIntentNudge({ finalResponse: text, iteration: 0, emit });
    expect(result.fired).toBe(true);
  });
});

describe('tryAskUserNudge', () => {
  it('no-op when askUserAvailable is false', () => {
    const { emit, events } = buildEmitRecorder();
    const result = tryAskUserNudge({
      finalResponse: 'Shall I proceed with the migration?',
      iteration: 0,
      emit,
      askUserAvailable: false
    });
    expect(result.fired).toBe(false);
    expect(events).toEqual([]);
  });

  it('fires on "Shall I proceed?" when ask_user is available', () => {
    const { emit, events } = buildEmitRecorder();
    const result = tryAskUserNudge({
      finalResponse: "Here's the plan. Shall I proceed with the full migration?",
      iteration: 2,
      emit,
      askUserAvailable: true
    });
    expect(result.fired).toBe(true);
    expect(result.message?.content).toContain('Call the `ask_user` tool now');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_loop:ask_user_nudge');
  });

  it('requires the response to end with a question mark (anchor at end-of-string)', () => {
    // A paragraph that contains "?" mid-text but ends with prose should
    // NOT trip the detector — that's a discussion, not a question.
    const { emit } = buildEmitRecorder();
    const result = tryAskUserNudge({
      finalResponse: "I considered asking 'shall I proceed?' but instead I decided to investigate further.",
      iteration: 0,
      emit,
      askUserAvailable: true
    });
    expect(result.fired).toBe(false);
  });

  it('does NOT fire on a question that lacks a decision phrase ("What did you mean by X?")', () => {
    const { emit } = buildEmitRecorder();
    const result = tryAskUserNudge({
      finalResponse: 'What did you mean by "deploy"?',
      iteration: 0,
      emit,
      askUserAvailable: true
    });
    expect(result.fired).toBe(false);
  });
});

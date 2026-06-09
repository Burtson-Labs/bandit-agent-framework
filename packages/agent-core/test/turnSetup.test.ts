/**
 * Contract tests for `resolveTurnGoal` — the per-turn goal anchor
 * resolver extracted from ToolUseLoop.runWithMessages (Arc 3 Session 1).
 *
 * Pins the continuation-walkback behavior (the 60-iteration linter-fix
 * turn that anchored every iteration on "good lets keep going" because
 * that was the literal last user message). A break here means the goal-
 * anchor block injected before the final-answer iteration will start
 * surfacing the wrong prompt to the model.
 */
import { describe, expect, it } from 'vitest';
import { resolveTurnGoal } from '../src/tools/loop/turnSetup';
import type { ToolLoopMessage } from '../src/index';

function u(content: string): ToolLoopMessage {
  return { role: 'user', content };
}
function a(content: string): ToolLoopMessage {
  return { role: 'assistant', content };
}
function s(content: string): ToolLoopMessage {
  return { role: 'system', content };
}

describe('resolveTurnGoal — basic resolution', () => {
  it('returns the most recent user message as the goal', () => {
    const result = resolveTurnGoal({
      seedMessages: [u('first prompt'), a('reply'), u('second prompt')]
    });
    expect(result.originalGoal).toBe('second prompt');
  });

  it('counts earlier user prompts (everything before the most-recent)', () => {
    const result = resolveTurnGoal({
      seedMessages: [u('one'), a('r1'), u('two'), a('r2'), u('three')]
    });
    expect(result.priorUserPromptCount).toBe(2);
  });

  it('ignores system and assistant messages when counting / resolving', () => {
    const result = resolveTurnGoal({
      seedMessages: [s('sys'), a('r'), s('sys2'), u('real')]
    });
    expect(result.originalGoal).toBe('real');
    expect(result.priorUserPromptCount).toBe(0);
  });

  it('skips empty / whitespace-only user messages', () => {
    const result = resolveTurnGoal({
      seedMessages: [u(''), u('   '), u('real')]
    });
    expect(result.originalGoal).toBe('real');
    expect(result.priorUserPromptCount).toBe(0);
  });

  it('returns empty goal and zero count when the seed has no real user message', () => {
    const result = resolveTurnGoal({ seedMessages: [s('sys'), a('reply')] });
    expect(result.originalGoal).toBe('');
    expect(result.priorUserPromptCount).toBe(0);
  });
});

describe('resolveTurnGoal — continuation-prompt walkback', () => {
  it('walks back past a bare "keep going" to the last substantive prompt', () => {
    // The 60-iteration linter-fix turn regression: anchor on the real
    // goal ("fix the TS errors"), not on the continuation token.
    const result = resolveTurnGoal({
      seedMessages: [
        u('fix the remaining TS errors in src/'),
        a('working on it'),
        u('keep going')
      ]
    });
    expect(result.originalGoal).toBe('fix the remaining TS errors in src/');
  });

  it('walks back through MULTIPLE continuation prompts to find the substantive one', () => {
    const result = resolveTurnGoal({
      seedMessages: [
        u('refactor the auth module'),
        a('done step 1'),
        u('continue'),
        a('done step 2'),
        u('yes'),
        a('done step 3'),
        u('keep going')
      ]
    });
    expect(result.originalGoal).toBe('refactor the auth module');
  });

  it('uses the continuation prompt itself when NO earlier substantive prompt exists', () => {
    // Edge case: a fresh turn where the only user message is "continue"
    // (no prior context to walk back to). Walkback finds nothing and
    // the originalGoal stays as the continuation token. The goal-anchor
    // injector later short-circuits on this via its own length check.
    const result = resolveTurnGoal({ seedMessages: [u('continue')] });
    expect(result.originalGoal).toBe('continue');
  });

  it('does NOT walk back when the most recent prompt is substantive', () => {
    const result = resolveTurnGoal({
      seedMessages: [u('first'), a('r'), u('actually do this thing instead')]
    });
    expect(result.originalGoal).toBe('actually do this thing instead');
  });
});

/**
 * /retry replaces the last attempt rather than stacking on it: drop the trailing
 * user prompt and everything after it, then re-run the same (or edited) prompt.
 * Leaving the failed exchange in context would bias the model toward repeating
 * it — the opposite of a retry.
 */
import { describe, it, expect } from 'vitest';
import { planRetry } from '../src/slashCommands';
import type { ToolLoopMessage } from '@burtson-labs/agent-core';

const convo = (...pairs: Array<[string, string]>): ToolLoopMessage[] =>
  pairs.flatMap(([u, a]) => [
    { role: 'user', content: u } as ToolLoopMessage,
    { role: 'assistant', content: a } as ToolLoopMessage,
  ]);

describe('planRetry', () => {
  it('re-runs the last prompt and drops the exchange it replaces', () => {
    const c = convo(['first', 'ans1'], ['second', 'ans2']);
    const plan = planRetry(c);
    expect(plan?.prompt).toBe('second');
    // Only the first exchange survives; the second user+assistant are gone.
    expect(plan?.trimmedConversation).toEqual(convo(['first', 'ans1']));
  });

  it('uses edited text when provided', () => {
    const c = convo(['make it blue', 'done']);
    const plan = planRetry(c, 'make it green instead');
    expect(plan?.prompt).toBe('make it green instead');
    expect(plan?.trimmedConversation).toEqual([]);
  });

  it('ignores whitespace-only edits and reuses the original', () => {
    const c = convo(['original', 'done']);
    expect(planRetry(c, '   ')?.prompt).toBe('original');
  });

  it('drops trailing assistant turns after the last user prompt', () => {
    const c: ToolLoopMessage[] = [
      { role: 'user', content: 'do X' },
      { role: 'assistant', content: 'step 1' },
      { role: 'assistant', content: 'step 2' },
    ];
    const plan = planRetry(c);
    expect(plan?.prompt).toBe('do X');
    expect(plan?.trimmedConversation).toEqual([]);
  });

  it('returns null when there is nothing to retry', () => {
    expect(planRetry([])).toBeNull();
    expect(planRetry([{ role: 'assistant', content: 'orphan' }])).toBeNull();
  });
});

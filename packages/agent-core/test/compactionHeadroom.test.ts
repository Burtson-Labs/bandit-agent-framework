/**
 * compactToolMessages `targetTokens`: once over the budget, compact down to
 * the target so the next results do not cross the budget again at once.
 * Every compaction rewrites an earlier message, and a provider's prompt
 * cache only covers the unchanged prefix, so each firing re-bills the rest
 * of the conversation uncached (2026-11-14: a 252K-token session on a paid
 * model).
 */
import { describe, expect, it } from 'vitest';
import { compactToolMessages } from '../src/tools/compactMessages';
import type { ToolLoopMessage } from '../src/tools/tool-types';

const result = (i: number, chars = 4000): ToolLoopMessage => ({
  role: 'user',
  content: `<tool_result name="read_file">\nfile${i}.ts\n${'x'.repeat(chars)}\n</tool_result>`
});
const call = (i: number): ToolLoopMessage => ({
  role: 'assistant',
  content: `<tool_call>{"name":"read_file","params":{"path":"file${i}.ts"}}</tool_call>`
});
const tokens = (ms: ToolLoopMessage[]) => ms.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0);

/** A turn that reads one 1K-token file per iteration; returns how many
 *  iterations compacted (each one a prompt-cache miss). */
function simulate(iterations: number, budget: number, targetTokens?: number): number {
  let messages: ToolLoopMessage[] = [
    { role: 'system', content: 'You are Bandit.' },
    { role: 'user', content: 'read everything' }
  ];
  let fires = 0;
  for (let i = 0; i < iterations; i++) {
    messages.push(call(i), result(i));
    const report = compactToolMessages(messages, { tokenBudget: budget, targetTokens });
    if (report.messagesCompacted > 0) fires++;
    messages = report.compacted;
    expect(tokens(messages)).toBeLessThanOrEqual(budget);
  }
  return fires;
}

describe('compactToolMessages targetTokens', () => {
  it('compacts to the target, not just under the budget', () => {
    const messages: ToolLoopMessage[] = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 20; i++) messages.push(call(i), result(i));
    const atBudget = compactToolMessages(messages, { tokenBudget: 12_000 });
    const withTarget = compactToolMessages(messages, { tokenBudget: 12_000, targetTokens: 7_000 });
    expect(atBudget.afterTokens).toBeLessThanOrEqual(12_000);
    expect(atBudget.afterTokens).toBeGreaterThan(10_500);
    expect(withTarget.afterTokens).toBeLessThanOrEqual(7_000);
  });

  it('fires far less often over a long turn', () => {
    const withoutHeadroom = simulate(60, 12_000);
    const withHeadroom = simulate(60, 12_000, 7_200);
    expect(withoutHeadroom).toBeGreaterThan(40); // nearly every iteration
    expect(withHeadroom).toBeLessThan(withoutHeadroom / 3);
  });

  it('does nothing under the budget, whatever the target', () => {
    const messages: ToolLoopMessage[] = [{ role: 'user', content: 'go' }, call(0), result(0)];
    const report = compactToolMessages(messages, { tokenBudget: 12_000, targetTokens: 100 });
    expect(report.messagesCompacted).toBe(0);
    expect(report.compacted).toBe(messages);
  });

  it('never drops whole messages to reach the target, only to fit the budget', () => {
    // Recent tool results are kept in full, so the target cannot be met by
    // eliding; the remainder fits the budget and must survive intact.
    const messages: ToolLoopMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'a'.repeat(8_000) },
      call(1), result(1), call(2), result(2)
    ];
    const report = compactToolMessages(messages, { tokenBudget: 6_000, targetTokens: 1_000 });
    expect(report.compacted.length).toBe(messages.length);
  });

  it('clamps a target above the budget to the budget', () => {
    const messages: ToolLoopMessage[] = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 20; i++) messages.push(call(i), result(i));
    const report = compactToolMessages(messages, { tokenBudget: 12_000, targetTokens: 50_000 });
    expect(report.afterTokens).toBeLessThanOrEqual(12_000);
  });
});

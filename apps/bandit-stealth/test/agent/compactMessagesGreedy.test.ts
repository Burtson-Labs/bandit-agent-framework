import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { compactToolMessages } = require('@burtson-labs/agent-core');

type ToolLoopMessage = { role: 'system' | 'user' | 'assistant'; content: string };

const TR = (name: string, body: string): ToolLoopMessage => ({
  role: 'user',
  content: `<tool_result name="${name}">\n${body}\n</tool_result>`
});

const big = (chars: number) => 'x'.repeat(chars);

describe('compactToolMessages — greedy + keep-recent floor', () => {
  it('summarizes only as many oldest tool results as needed to fit budget', () => {
    // 6 tool results. keepRecent=4 → first 2 are eligible for
    // summarization. Each oldest is 8KB chars (~2000 tokens). Budget
    // = 3000 tokens. Total before ≈ 4250 tokens. Collapsing the single
    // oldest 8KB result alone (saving ~2000 tokens) drops us under
    // budget. Greedy must STOP — must NOT also collapse the second
    // oldest 8KB result.
    const messages: ToolLoopMessage[] = [
      { role: 'user', content: 'do the thing' },
      TR('read_file', big(8000)),   // oldest, big — should be summarized
      TR('read_file', big(8000)),   // big — should SURVIVE
      TR('check_task', big(78)),
      TR('check_task', big(78)),
      TR('check_task', big(78)),
      TR('check_task', big(78))
    ];

    const report = compactToolMessages(messages, { tokenBudget: 3000 });

    expect(report.messagesCompacted).toBe(1);
    expect(report.afterTokens).toBeLessThanOrEqual(3000);
    // Index 2 is the SECOND big read — it must still carry its full body.
    const survivingBig = report.compacted[2].content;
    expect(survivingBig.length).toBeGreaterThan(7000);
  });

  it('preserves the last 4 tool results in full even when over budget', () => {
    // 8 tool results, all 500-char. Budget = 100 tokens (way under).
    // Greedy summarizes oldest 4 (the 4 NOT in keepRecent slice). The
    // last 4 must remain at their original ~500-char body — they are
    // never summarized even when budget can't be met by greedy alone.
    const messages: ToolLoopMessage[] = [
      { role: 'user', content: 'do it' },
      TR('read_file', big(500)),
      TR('read_file', big(500)),
      TR('read_file', big(500)),
      TR('read_file', big(500)),
      TR('read_file', big(500)),
      TR('read_file', big(500)),
      TR('read_file', big(500)),
      TR('read_file', big(500))
    ];

    const report = compactToolMessages(messages, { tokenBudget: 100 });

    // Walk the output: positions of TOOL RESULT messages should be
    // unchanged (the user prompt is index 0). The LAST FOUR tool-result
    // bodies must still be ≥ 500 chars (i.e. carry their original
    // 500-char body wrapped in the tool_result envelope).
    const toolResultMsgs = report.compacted.filter(
      (m) => m.role === 'user' && m.content.startsWith('<tool_result')
    );
    const lastFour = toolResultMsgs.slice(-4);
    for (const msg of lastFour) {
      expect(msg.content.length).toBeGreaterThan(450);
    }
  });

  it('does not over-collapse when the most recent tool results are tiny', () => {
    // The exact bug surfaced 2026-05-06: tiny `check_task` results at
    // the tail caused the OLD algorithm (keep last 2 only, summarize
    // every other) to collapse every meaningful read regardless of
    // budget headroom. With greedy + keepRecent=4, multiple medium
    // reads survive intact and the final size stays close to budget,
    // not 80%+ below it.
    const messages: ToolLoopMessage[] = [
      { role: 'user', content: 'evaluate' },
      TR('read_file', big(5000)),     // oldest — eligible
      TR('read_file', big(5000)),     // eligible
      TR('read_file', big(5000)),     // eligible
      TR('read_file', big(5000)),     // KEEP (last 4)
      TR('read_file', big(5000)),     // KEEP
      TR('check_task', big(78)),      // KEEP
      TR('check_task', big(78))       // KEEP
    ];

    const report = compactToolMessages(messages, { tokenBudget: 4000 });

    // Should land just under budget — not 80% below it. Pre-fix
    // behavior would have collapsed everything except the last 2 tiny
    // check_tasks, dropping under ~200 tokens. Greedy + keepRecent=4
    // keeps the 2 last 5KB reads in full.
    expect(report.afterTokens).toBeLessThanOrEqual(4000);
    expect(report.afterTokens).toBeGreaterThan(2000);
  });
});

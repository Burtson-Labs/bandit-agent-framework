/**
 * The low-novelty guard and the runaway trim in streamAndAggregate.
 *
 * Real failure (2026-10-20 benchmark, gemma4:12b): a visible reply cycled
 * through three sentences for 24k chars / 295 s ("I'll use apply_edit for the
 * block from 34 to 48. / Wait, I'll just do it. / Actually, I'll just do
 * it."), and a second one through ten lines of "If p.WeightGrams is 1001..."
 * for 349 s. Neither tripped the 5-identical-lines check (multi-line cycle)
 * nor the fingerprint (period not aligned with its 800-char stride); only
 * HARD_MAX ended them, and the whole 24k chars went back into history.
 */
import { describe, expect, it } from 'vitest';
import { streamAndAggregate, trimRepeatedTail, NOVELTY_WINDOW } from '../src/tools/loop/llmStream';
import { buildEmitRecorder, yieldChunks } from './_helpers';

function lineChunks(text: string): string[] {
  // Stream line by line, like a model does.
  return text.split(/(?<=\n)/);
}

async function run(text: string) {
  const { emit, events } = buildEmitRecorder();
  const result = await streamAndAggregate({ chat: () => yieldChunks(lineChunks(text)), messages: [], emit, iteration: 5 });
  const abort = events.find((e) => e.type === 'tool_loop:stream_abort');
  return { result, abort: abort?.payload as { reason: string; length: number } | undefined, events };
}

const PREAMBLE = 'I will update `src/cli.ts` to parse the `--currency` flag and use it in the `formatMoney` calls.\n\n';
const CYCLE = "I'll use apply_edit for the block from 34 to 48.\nWait, I'll just do it.\n\nActually, I'll just do it.\n";

describe('low-novelty guard', () => {
  it('stops a three-sentence cycle within a few hundred chars of reaching the window', async () => {
    const text = PREAMBLE + CYCLE.repeat(200); // ~20k chars if left alone
    const { result, abort, events } = await run(text);
    expect(abort?.reason).toBe('low_novelty_loop');
    expect(abort!.length).toBeLessThan(2500);
    // History keeps the preamble and one pass of the cycle, not the runaway.
    expect(result.startsWith(PREAMBLE.trimEnd())).toBe(true);
    expect(result.split("I'll use apply_edit for the block from 34 to 48.").length - 1).toBe(1);
    expect(result).toMatch(/characters of repeated output dropped\]/);
    expect(result.endsWith('[stream aborted: self-contradicting prose loop detected]')).toBe(true);
    expect(events.some((e) => e.type === 'tool_loop:runaway_trimmed')).toBe(true);
  });

  it('stops a ten-line cycle with slight variants (the 349 s reply)', async () => {
    const variants = [
      'If p.WeightGrams is 1001, kilos is 2.',
      'Wait, if p.WeightGrams is 1000, it\'s 1.000 kg.',
      'If p.WeightGrams is 1001, it\'s 1.001 kg.',
      'If p.WeightGrams is 1000, kilos is 1.',
      'Wait, I\'m saying the same thing.',
      'If the rule is "started kilo", then 1.001 kg should be 2.',
      'So 1001 grams should be 2.',
      '39 │ \tkilos := (p.WeightGrams + 999) / 1000',
      'Wait, I\'m looking at the wrong thing.',
      'Let me look at the CalcRate function again.'
    ];
    let text = 'The test `TestCalcRate` has a case for a 1001g parcel in zone 2.\n';
    for (let i = 0; i < 60; i++) {
      // Drop one line now and then so the cycle is not exact.
      text += variants.filter((_, j) => (i + j) % 7 !== 0).join('\n') + '\n';
    }
    const { abort } = await run(text);
    expect(abort?.reason).toBe('low_novelty_loop');
  });

  it('leaves a long, varied reply alone (a 120-line test file written in the content channel)', async () => {
    let text = "import { describe, expect, it } from 'vitest';\nimport { formatMoney } from '../src/money';\n\n";
    for (let i = 0; i < 60; i++) {
      text += `  it('formats ${i} cents in EUR', () => {\n    expect(formatMoney(${i * 101}, 'EUR')).toBe('€${(i * 1.01).toFixed(2)}');\n  });\n`;
    }
    const { abort, result } = await run(text);
    expect(abort).toBeUndefined();
    expect(result).toBe(text);
  });

  it('leaves a table with a repeated status column alone', async () => {
    let text = '| SKU | Name | Status |\n| --- | --- | --- |\n';
    for (let i = 0; i < 80; i++) text += `| SKU-${1000 + i} | Widget ${i} | needs reorder |\n`;
    const { abort } = await run(text);
    expect(abort).toBeUndefined();
  });

  it('leaves one code block shown twice alone', async () => {
    const block = Array.from({ length: 15 }, (_, i) => `    total_cents += line_item_${i}.price * line_item_${i}.qty`).join('\n');
    const text = `Before:\n\`\`\`python\n${block}\n\`\`\`\nAfter:\n\`\`\`python\n${block}\n    return total_cents\n\`\`\`\n`;
    const { abort } = await run(text);
    expect(abort).toBeUndefined();
  });

  it('needs a full window: a short reply that repeats one sentence a few times is not cut', async () => {
    const text = 'Running the tests now to confirm the fix works as expected.\n'.repeat(4) + 'Done.\n';
    const { abort } = await run(text);
    expect(abort).toBeUndefined();
    expect(NOVELTY_WINDOW).toBeGreaterThan(4);
  });
});

describe('trimRepeatedTail', () => {
  it('keeps everything when nothing repeats three times', () => {
    const text = 'first line of prose here\nsecond line of prose here\nfirst line of prose here\n';
    expect(trimRepeatedTail(text)).toEqual({ text, droppedChars: 0 });
  });

  it('cuts at the second occurrence of the first looping line', () => {
    const text = 'Intro line that stays put.\nLoop line number one!\nLoop line number two!\n'.concat('Loop line number one!\nLoop line number two!\n'.repeat(5));
    const cut = trimRepeatedTail(text);
    expect(cut.text).toBe('Intro line that stays put.\nLoop line number one!\nLoop line number two!');
    expect(cut.droppedChars).toBeGreaterThan(100);
  });

  it('with a share threshold, leaves a mostly-varied text alone', () => {
    const varied = Array.from({ length: 50 }, (_, i) => `distinct sentence number ${i} here`).join('\n');
    const text = `${varied}\nreturn result_value;\nreturn result_value;\nreturn result_value;\n`;
    expect(trimRepeatedTail(text, 0.5).droppedChars).toBe(0);
  });
});

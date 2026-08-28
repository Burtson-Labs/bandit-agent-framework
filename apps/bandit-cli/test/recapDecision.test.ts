/**
 * The recap should only appear when it helps — a long prose answer that
 * scrolled. It was showing under a table-heavy email answer, echoing the first
 * sentence right below the full result, which read as "printed twice."
 */
import { describe, it, expect } from 'vitest';
import { shouldShowRecap } from '../src/recapDecision';

const base = { userPrompt: 'summarize the architecture', terminalRows: 40 };

describe('shouldShowRecap', () => {
  it('suppresses for a table (self-documenting)', () => {
    const rawResponse = [
      'Here are the messages I found:',
      '| Date | Subject |',
      '| --- | --- |',
      '| Jul 10 | Newsletter |',
    ].join('\n');
    expect(shouldShowRecap({ ...base, rawResponse, cleanedResponse: 'Here are the messages I found:' })).toBe(false);
  });

  it('suppresses for a fenced code block', () => {
    const rawResponse = 'Here is the fix:\n```ts\nconst x = 1;\n```';
    expect(shouldShowRecap({ ...base, rawResponse, cleanedResponse: 'Here is the fix:' })).toBe(false);
  });

  it('suppresses when the whole answer fits on screen', () => {
    const rawResponse = 'A short three-line\nanswer that fits\ncomfortably on screen.';
    expect(shouldShowRecap({ ...base, rawResponse, cleanedResponse: rawResponse })).toBe(false);
  });

  it('suppresses chit-chat', () => {
    expect(shouldShowRecap({ userPrompt: 'hi', rawResponse: 'Hey!', cleanedResponse: 'Hey!', terminalRows: 40 })).toBe(false);
  });

  it('shows for a long prose answer that scrolled', () => {
    const rawResponse = Array.from({ length: 60 }, (_, i) => `Paragraph line ${i + 1} of a long prose explanation.`).join('\n');
    expect(shouldShowRecap({ ...base, rawResponse, cleanedResponse: rawResponse })).toBe(true);
  });

  it('shows for a long single-paragraph answer past the char budget', () => {
    const rawResponse = 'x'.repeat(1200);
    expect(shouldShowRecap({ ...base, rawResponse, cleanedResponse: rawResponse })).toBe(true);
  });

  it('never shows with an empty prompt or response', () => {
    expect(shouldShowRecap({ userPrompt: '', rawResponse: 'x'.repeat(2000), cleanedResponse: 'x'.repeat(2000), terminalRows: 40 })).toBe(false);
    expect(shouldShowRecap({ ...base, rawResponse: '', cleanedResponse: '' })).toBe(false);
  });

  it('adapts to a short terminal — a small window scrolls sooner', () => {
    const rawResponse = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    // 20 lines fits a 40-row terminal (suppress) but scrolls a 12-row one (show).
    expect(shouldShowRecap({ ...base, rawResponse, cleanedResponse: rawResponse, terminalRows: 40 })).toBe(false);
    expect(shouldShowRecap({ ...base, rawResponse, cleanedResponse: rawResponse, terminalRows: 12 })).toBe(true);
  });
});

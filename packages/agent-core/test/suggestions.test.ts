/**
 * Next-prompt prediction core — the shared "what will you ask next?" logic.
 * Properties: the prompt carries the recent exchange + recent files + a count;
 * parsing survives realistic model output (fenced, bare, prose-wrapped), and
 * junk (questions-to-the-user aside) is filtered to short, deduped imperatives.
 */
import { describe, it, expect } from 'vitest';
import { buildSuggestionsPrompt, parseSuggestions } from '../src/suggestions';

describe('buildSuggestionsPrompt', () => {
  it('includes the recent tail, files, and requested count', () => {
    const p = buildSuggestionsPrompt(
      [
        { role: 'user', content: 'add a clamp function' },
        { role: 'assistant', content: 'Added clamp() to src/utils/clamp.ts' },
      ],
      { count: 2, recentFiles: ['src/utils/clamp.ts'] }
    );
    expect(p).toContain('add a clamp function');
    expect(p).toContain('src/utils/clamp.ts');
    expect(p).toMatch(/2 short/);
    expect(p).toMatch(/JSON array of 2 strings/);
  });

  it('clamps count to 1..5 and only uses the last few turns', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, content: `turn ${i}` }));
    const p = buildSuggestionsPrompt(many, { count: 99 });
    expect(p).toMatch(/JSON array of 5 strings/); // clamped
    expect(p).toContain('turn 19');
    expect(p).not.toContain('turn 15'); // only the tail
  });
});

describe('parseSuggestions', () => {
  it('parses a ```json fence', () => {
    const out = parseSuggestions('Sure:\n```json\n["run the tests", "commit this"]\n```');
    expect(out).toEqual(['run the tests', 'commit this']);
  });

  it('parses a bare array amid prose', () => {
    expect(parseSuggestions('Maybe ["explain the change", "add a test"] next.'))
      .toEqual(['explain the change', 'add a test']);
  });

  it('dedupes (case-insensitive), trims, and caps', () => {
    const out = parseSuggestions('["Run tests", "run tests", "Commit", "Explain", "Refactor", "Deploy"]', 3);
    expect(out).toEqual(['Run tests', 'Commit', 'Explain']);
  });

  it('drops non-strings, empties, and over-long entries', () => {
    const out = parseSuggestions(`["ok", 42, "", "${'x'.repeat(120)}", "  fix the bug  "]`);
    expect(out).toEqual(['ok', 'fix the bug']);
  });

  it('returns [] on junk instead of throwing', () => {
    expect(parseSuggestions('no array here')).toEqual([]);
    expect(parseSuggestions('```json\n{not: an array}\n```')).toEqual([]);
    expect(parseSuggestions('[broken')).toEqual([]);
  });

  it('strips wrapping quotes/backticks the model sometimes adds', () => {
    expect(parseSuggestions('["`run the tests`", "\'commit\'"]')).toEqual(['run the tests', 'commit']);
  });
});

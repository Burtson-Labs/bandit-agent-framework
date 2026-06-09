import { describe, it, expect } from 'vitest';
import { renderAppliedDiff } from '../src/diff';

// Colors are disabled under vitest (non-TTY, no FORCE_COLOR), so these
// assertions match the PLAIN text the renderer emits — gutter numbers,
// +/- markers, header verb/counts — without ANSI noise.

describe('renderAppliedDiff', () => {
  it('returns empty string when there is no change', () => {
    expect(renderAppliedDiff('foo.ts', 'a\nb\n', 'a\nb\n')).toBe('');
  });

  it('renders a two-line header with verb, path, and word counts', () => {
    const out = renderAppliedDiff('src/foo.ts', 'a\nb\nc', 'a\nB\nc', { verb: 'Updated' });
    const [title, counts] = out.split('\n');
    expect(title).toContain('Updated');
    expect(title).toContain('src/foo.ts');
    expect(counts).toContain('Added 1 line');
    expect(counts).toContain('removed 1 line');
  });

  it('marks additions with + and deletions with -, with line-number gutters', () => {
    const out = renderAppliedDiff('f', 'one\ntwo\nthree', 'one\nTWO\nthree');
    // the changed region: line 2 removed (two) + added (TWO), context around it
    expect(out).toMatch(/- *two/);
    expect(out).toMatch(/\+ *TWO/);
    // gutter line numbers present (2 = the changed line)
    expect(out).toMatch(/\b2\b/);
  });

  it('treats a brand-new file (empty before) as a "Created" pure-add block', () => {
    const out = renderAppliedDiff('new.md', '', 'line1\nline2\nline3', { verb: 'Wrote' });
    expect(out.split('\n')[0]).toContain('Created');
    expect(out).toContain('removed 0 lines');
    // every content line is an addition, none deleted
    expect(out).not.toMatch(/^ *\d+ - /m);
    expect((out.match(/\+ /g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('collapses long unchanged runs into a single marker', () => {
    const before = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 25', 'line 25 CHANGED');
    const out = renderAppliedDiff('big.txt', before, after);
    expect(out).toContain('⋯');
    // far-away unchanged lines (e.g. line 2) should NOT be shown
    expect(out).not.toContain('line 2\n');
    // the changed line and its context ARE shown
    expect(out).toContain('line 25 CHANGED');
  });

  it('caps very large diffs with a "more diff lines" note', () => {
    const after = Array.from({ length: 200 }, (_, i) => `added ${i}`).join('\n');
    const out = renderAppliedDiff('huge.txt', '', after, { maxLines: 20 });
    expect(out).toContain('more diff lines');
    // capped — not all 200 lines rendered
    expect(out.split('\n').length).toBeLessThan(40);
  });
});

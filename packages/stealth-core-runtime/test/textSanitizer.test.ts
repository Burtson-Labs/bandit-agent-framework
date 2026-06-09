/**
 * Contract tests for textSanitizer — strips model artifacts (code
 * fences, conversation markers, leaked file headers) from streamed
 * output so they don't land in the chat or in generated source.
 *
 * Why pin: this runs on every chunk of generated code the model
 * produces. A regression here would either leak raw reasoning fences
 * or `<start_of_turn>` markers into the user's editor, OR over-trim
 * legitimate content. Both fail loudly but in opposite ways. The
 * leaked-file-header detector has a particularly subtle boundary
 * (path-like strings only count if they contain a `/` AND look like
 * a real file path) that we want to lock down.
 */
import { describe, expect, it } from 'vitest';
import {
  stripCodeFences,
  sanitizeGeneratedSource,
  CONVERSATION_MARKER_REGEXES
} from '../src/runtime/textSanitizer';

describe('stripCodeFences', () => {
  it('strips a balanced ```lang fenced block and returns the body trimmed', () => {
    const input = '```ts\nconst x = 1;\n```';
    expect(stripCodeFences(input)).toBe('const x = 1;');
  });

  it('strips fences when only the opening marker is present', () => {
    expect(stripCodeFences('```ts\nconst x = 1;\n')).toBe('const x = 1;');
  });

  it('strips a trailing ``` when only the closing marker is present', () => {
    expect(stripCodeFences('const x = 1;\n```')).toBe('const x = 1;');
  });

  it('returns the trimmed input unchanged when there are no fences', () => {
    expect(stripCodeFences('  hello world  ')).toBe('hello world');
  });

  it('handles bare ``` fences without a language tag', () => {
    expect(stripCodeFences('```\nfoo\n```')).toBe('foo');
  });
});

describe('sanitizeGeneratedSource', () => {
  it('returns empty for empty/falsy input', () => {
    expect(sanitizeGeneratedSource('')).toBe('');
  });

  it('normalizes CRLF to LF', () => {
    const r = sanitizeGeneratedSource('line1\r\nline2\r\nline3');
    expect(r).not.toContain('\r');
    expect(r.split('\n')).toEqual(['line1', 'line2', 'line3']);
  });

  it('strips ALL code fences (open and close, multiple blocks)', () => {
    const input = '```ts\ncode1\n```\nbetween\n```\ncode2\n```';
    const r = sanitizeGeneratedSource(input);
    expect(r).not.toContain('```');
    expect(r).toContain('code1');
    expect(r).toContain('code2');
    expect(r).toContain('between');
  });

  it('strips `<start_of_turn>` and `<end_of_turn>` conversation markers (Gemma artifacts)', () => {
    const input = '<start_of_turn>model\nactual code here\n<end_of_turn>';
    const r = sanitizeGeneratedSource(input);
    expect(r).not.toMatch(/start_of_turn|end_of_turn/i);
    expect(r).toContain('actual code here');
  });

  it('handles every flavor of the turn markers (pipe-prefixed, slash-prefixed, mixed case)', () => {
    // The regex set is supposed to be permissive across the variants
    // models actually emit. Pin a sampling.
    const variants = [
      '<start_of_turn>',
      '<|start_of_turn|>',
      '<|start_of_turn>',
      '< start_of_turn >',
      '<END_OF_TURN>',
      '<|end_of_turn|>'
    ];
    for (const marker of variants) {
      const r = sanitizeGeneratedSource(`${marker}\nfoo`);
      expect(r).not.toContain('start_of_turn');
      expect(r).not.toContain('end_of_turn');
      expect(r).toContain('foo');
    }
  });

  it('collapses 3+ consecutive newlines into double-newline (no triple-blank paragraphs)', () => {
    const r = sanitizeGeneratedSource('a\n\n\n\n\nb');
    expect(r).toBe('a\n\nb');
  });

  it('regex set exposes both turn-marker patterns for external use', () => {
    // The regex array is exported because other modules sometimes
    // pre-sanitize on their own; pin the contract that BOTH markers
    // are covered.
    expect(CONVERSATION_MARKER_REGEXES).toHaveLength(2);
    expect('<start_of_turn>'.match(CONVERSATION_MARKER_REGEXES[0])).toBeTruthy();
    expect('<end_of_turn>'.match(CONVERSATION_MARKER_REGEXES[1])).toBeTruthy();
  });
});

describe('sanitizeGeneratedSource — leaked file headers', () => {
  // Models (small Gemmas in particular) sometimes prefix generated
  // source with `File: src/foo.ts` or even a raw `src/foo.ts` line,
  // expecting the agent to file-route it. The sanitizer strips those
  // prefix lines so the model's output is just the file contents.
  // These tests pin the boundary so we don't accidentally strip real
  // top-of-file comments.

  it('strips a `File: <path>` header prefix', () => {
    const r = sanitizeGeneratedSource('File: src/foo.ts\nconst x = 1;');
    expect(r.startsWith('File:')).toBe(false);
    expect(r).toContain('const x = 1;');
  });

  it('strips a ```files` info-line prefix', () => {
    const r = sanitizeGeneratedSource('```files\nconst x = 1;');
    expect(r).toContain('const x = 1;');
    expect(r).not.toContain('```files');
  });

  it('strips a bare path-like first line (must contain `/` and a short extension)', () => {
    const r = sanitizeGeneratedSource('src/foo.ts\nconst x = 1;');
    expect(r.startsWith('src/foo')).toBe(false);
    expect(r).toContain('const x = 1;');
  });

  it('does NOT strip lines that LOOK path-like but lack a `/` (single-segment names)', () => {
    // "package.json" without a leading dir doesn't qualify — could be a
    // legitimate first-line reference inside source.
    const r = sanitizeGeneratedSource('package.json\nthis is content');
    expect(r).toContain('package.json');
  });

  it('does NOT strip JS line comments that happen to look like paths', () => {
    // A comment line is a legit start-of-file form — preserve it.
    const r = sanitizeGeneratedSource('// src/foo.ts\nconst x = 1;');
    expect(r).toContain('// src/foo.ts');
  });

  it('does NOT strip block comments', () => {
    const r = sanitizeGeneratedSource('/* src/foo.ts */\nconst x = 1;');
    expect(r).toContain('/* src/foo.ts */');
  });

  it('does NOT strip lines with weird characters that disqualify them as paths', () => {
    // Spaces/quotes/parens etc. → not a path. Preserve the line.
    const r = sanitizeGeneratedSource('src/foo (modified).ts\nconst x = 1;');
    expect(r).toContain('src/foo (modified).ts');
  });

  it('skips blank prefix lines before checking for the header', () => {
    const r = sanitizeGeneratedSource('\n\nFile: src/foo.ts\nconst x = 1;');
    expect(r.startsWith('File:')).toBe(false);
    expect(r).toContain('const x = 1;');
  });

  it('strips multiple consecutive header-like lines', () => {
    const r = sanitizeGeneratedSource('File: src/foo.ts\nsrc/foo.ts\n```files\nconst x = 1;');
    expect(r).toContain('const x = 1;');
    expect(r.startsWith('File:')).toBe(false);
    expect(r).not.toContain('```files');
  });

  it('leaves the input untouched when the first non-blank line is real code', () => {
    const r = sanitizeGeneratedSource('const x = 1;\n// some comment');
    expect(r).toBe('const x = 1;\n// some comment');
  });
});

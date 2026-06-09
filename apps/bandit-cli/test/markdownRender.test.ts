import { describe, it, expect } from 'vitest';
import {
  applyInlineMarkdown,
  renderMarkdownLine,
  consumeMarkdownInChunk,
  flushMarkdownState
} from '../src/terminal/markdownRender';
import { createStreamStrippingState } from '../src/streaming/streamStripping';

// Color wrappers are no-ops under NO_COLOR / non-TTY (vitest runs that
// way), so these assertions pin the text-level contract — marker shape,
// body preservation, structural prefixes — rather than ANSI bytes.

describe('renderMarkdownLine — ATX headers', () => {
  it('renders headers at all 6 levels with depth-matching marker', () => {
    const state = createStreamStrippingState();
    for (let level = 1; level <= 6; level++) {
      const out = renderMarkdownLine(`${'#'.repeat(level)} Title`, state);
      expect(out).toContain('#'.repeat(level));
      expect(out).toContain('Title');
    }
  });

  it('skips non-header lines that start with a `#` without a space', () => {
    const state = createStreamStrippingState();
    const out = renderMarkdownLine('#nospace', state);
    expect(out).not.toContain('## ');
    expect(out).toContain('#nospace');
  });
});

describe('renderMarkdownLine — fenced code blocks', () => {
  it('opens a code fence on ``` and preserves interior content verbatim', () => {
    const state = createStreamStrippingState();
    const opener = renderMarkdownLine('```', state);
    expect(state.inCodeFence).toBe(true);
    expect(opener).toContain('─');

    const body = renderMarkdownLine('let x = 1;', state);
    expect(body).toContain('let x = 1;');

    const closer = renderMarkdownLine('```', state);
    expect(state.inCodeFence).toBe(false);
    expect(closer).toContain('─');
  });

  it('captures the fence language and labels the opener divider', () => {
    const state = createStreamStrippingState();
    const opener = renderMarkdownLine('```typescript', state);
    expect(state.fenceLang).toBe('typescript');
    expect(opener).toContain('typescript');
  });

  it('inline markdown is NOT applied to lines inside a code fence', () => {
    const state = createStreamStrippingState();
    renderMarkdownLine('```text', state);
    const body = renderMarkdownLine('**stays starred**', state);
    // The asterisks survive — bold transform would have replaced them.
    expect(body).toContain('**stays starred**');
  });
});

describe('renderMarkdownLine — lists and rules', () => {
  it('renders unordered list items with a bullet glyph', () => {
    const state = createStreamStrippingState();
    expect(renderMarkdownLine('- item', state)).toContain('•');
    expect(renderMarkdownLine('* item', state)).toContain('•');
    expect(renderMarkdownLine('+ item', state)).toContain('•');
  });

  it('renders ordered list items with the original N. marker', () => {
    const state = createStreamStrippingState();
    const out = renderMarkdownLine('3. third', state);
    expect(out).toContain('3.');
    expect(out).toContain('third');
  });

  it('preserves indentation for nested list items', () => {
    const state = createStreamStrippingState();
    const out = renderMarkdownLine('  - nested', state);
    expect(out.startsWith('  ')).toBe(true);
  });

  it('renders a horizontal rule for ---, ***, ___', () => {
    const state = createStreamStrippingState();
    expect(renderMarkdownLine('---', state)).toContain('─');
    expect(renderMarkdownLine('***', state)).toContain('─');
    expect(renderMarkdownLine('___', state)).toContain('─');
  });
});

describe('renderMarkdownLine — blockquotes', () => {
  it('replaces > prefix with a rail glyph and italicizes the body', () => {
    const state = createStreamStrippingState();
    const out = renderMarkdownLine('> quoted line', state);
    expect(out).toContain('│');
    expect(out).toContain('quoted line');
  });
});

describe('applyInlineMarkdown', () => {
  it('transforms inline code, bold, and italic spans', () => {
    const out = applyInlineMarkdown('Here is `code` and **bold** and *italic*.');
    expect(out).not.toContain('`code`');
    expect(out).not.toContain('**bold**');
    expect(out).not.toContain('*italic*');
    expect(out).toContain('code');
    expect(out).toContain('bold');
    expect(out).toContain('italic');
  });

  it('preserves both label and URL for [label](url) markdown links under NO_COLOR', () => {
    // Regression: pre-fix the OSC-8 fallback dropped the URL entirely
    // (c.link returned label only when !supportsColor), so a `[docs](https://x)`
    // markdown link silently lost its href in NO_COLOR/non-TTY output.
    // Fix: osc8 now emits `label (url)` when label !== url and colors
    // are off.
    const out = applyInlineMarkdown('see [docs](https://example.com)');
    expect(out).toContain('docs');
    expect(out).toContain('https://example.com');
    expect(out).not.toContain('[docs]');
  });

  it('preserves bare http(s) URLs in prose', () => {
    // c.link passes the URL as both label and url; under no-color it
    // collapses to the URL itself (no OSC-8 wrapper) but the URL
    // text remains visible.
    const out = applyInlineMarkdown('visit https://example.com now');
    expect(out).toContain('https://example.com');
    expect(out).toContain('visit');
    expect(out).toContain('now');
  });
});

describe('consumeMarkdownInChunk / flushMarkdownState', () => {
  it('holds back a partial trailing line until its newline arrives', () => {
    const state = createStreamStrippingState();
    const out1 = consumeMarkdownInChunk(state, '# header-without-newline');
    expect(out1).toBe('');
    expect(state.markdownBuffer).toBe('# header-without-newline');
    const out2 = consumeMarkdownInChunk(state, '\n');
    expect(out2).toContain('header-without-newline');
  });

  it('renders complete lines and stashes any partial tail', () => {
    const state = createStreamStrippingState();
    const out = consumeMarkdownInChunk(state, '# h1\n**bold** prose\npartial-tail');
    expect(out).toContain('h1');
    expect(out).toContain('prose');
    expect(state.markdownBuffer).toBe('partial-tail');
  });

  it('flushMarkdownState renders any pending tail at stream end', () => {
    const state = createStreamStrippingState();
    consumeMarkdownInChunk(state, '## leftover');
    const tail = flushMarkdownState(state);
    expect(tail).toContain('leftover');
    expect(state.markdownBuffer).toBe('');
  });
});

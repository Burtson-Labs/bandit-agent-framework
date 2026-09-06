/**
 * renderMarkdownDocument turns a WHOLE markdown string into rendered terminal
 * output — the fix for graph-routed turns printing raw `#`/`**`/`| … |` markup.
 * We assert the raw markers are transformed and content survives (not the exact
 * ANSI, which is the streaming renderer's contract, covered elsewhere).
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdownDocument } from '../src/terminal/renderDocument';

describe('renderMarkdownDocument', () => {
  it('consumes inline bold markup and transforms the document (not a raw passthrough)', () => {
    const raw = '# Strategic Briefing\n\nSome **bold** point here.';
    const out = renderMarkdownDocument(raw);
    expect(out).not.toContain('**bold**'); // ** markers consumed
    expect(out).not.toBe(raw); // the document was rendered, not printed raw
    expect(out).toContain('bold'); // content survives
    expect(out).toContain('Strategic Briefing'); // header text survives (styled in a TTY)
  });

  it('renders a table instead of printing the raw separator row', () => {
    const out = renderMarkdownDocument('| Initiative | Impact |\n|---|---|\n| Grok 2 | high |');
    expect(out).not.toContain('|---|'); // separator not printed literally
    expect(out).toContain('Initiative');
    expect(out).toContain('Grok 2');
  });

  it('is a no-op-safe passthrough for plain text', () => {
    expect(renderMarkdownDocument('just a plain line')).toContain('just a plain line');
  });
});

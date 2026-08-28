/**
 * Vertical-rhythm + step-marker parity pass. The renderer used to be a pure
 * line-by-line transform, so a model that stacked a header directly on prose
 * directly on a list produced a wall of text (the "dense, hard to follow"
 * report vs other agent CLIs). These pin the two additions:
 *   1. a single blank line is injected at real block boundaries (never inside
 *      a group, never doubling a model-emitted blank);
 *   2. exactly one ● gutter dot leads each step's first prose line.
 */
import { describe, it, expect } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import {
  needsBlankBetween,
  consumeMarkdownInChunk,
  flushMarkdownState,
  STEP_MARKER
} from '../src/terminal/markdownRender';
import { createStreamStrippingState } from '../src/streaming/streamStripping';

/** Render a whole response through the streaming path, then strip ANSI so we
 *  can assert on the plain-text line structure the user actually sees. */
function render(md: string): string[] {
  const state = createStreamStrippingState();
  let out = consumeMarkdownInChunk(state, md);
  out += flushMarkdownState(state);
  return stripVTControlCharacters(out).replace(/\n$/, '').split('\n');
}

describe('needsBlankBetween — block boundaries get one blank, groups stay tight', () => {
  it('never leads the first line or doubles a model blank', () => {
    expect(needsBlankBetween('none', 'text')).toBe(false);
    expect(needsBlankBetween('none', 'header')).toBe(false);
    expect(needsBlankBetween('blank', 'header')).toBe(false);
    expect(needsBlankBetween('text', 'blank')).toBe(false);
  });

  it('keeps prose paragraphs and list/code/quote groups tight', () => {
    expect(needsBlankBetween('text', 'text')).toBe(false);
    expect(needsBlankBetween('ulist', 'ulist')).toBe(false);
    expect(needsBlankBetween('olist', 'ulist')).toBe(false);
    expect(needsBlankBetween('code', 'code')).toBe(false);
    expect(needsBlankBetween('fence', 'code')).toBe(false);
    expect(needsBlankBetween('code', 'fence')).toBe(false);
    expect(needsBlankBetween('quote', 'quote')).toBe(false);
  });

  it('separates real block transitions', () => {
    expect(needsBlankBetween('text', 'header')).toBe(true);   // space above a heading
    expect(needsBlankBetween('header', 'text')).toBe(true);   // space below a heading
    expect(needsBlankBetween('text', 'ulist')).toBe(true);    // space before a list
    expect(needsBlankBetween('ulist', 'text')).toBe(true);    // space after a list
    expect(needsBlankBetween('text', 'fence')).toBe(true);    // space before a code block
    expect(needsBlankBetween('text', 'quote')).toBe(true);
  });
});

describe('streaming render — vertical rhythm', () => {
  it('opens a blank line above and below a heading jammed against prose', () => {
    // What a dense model emits: no blank lines anywhere.
    const lines = render('Intro sentence.\n## Section\nBody sentence.');
    expect(lines.length).toBe(5);
    expect(lines[0]).toContain('Intro sentence.');
    expect(lines[1]).toBe('');
    expect(lines[2]).toContain('Section');
    expect(lines[3]).toBe('');
    expect(lines[4]).toContain('Body sentence.');
  });

  it('separates a list group from surrounding prose but keeps items tight', () => {
    const lines = render('Here are the points:\n- one\n- two\n- three\nWrap-up.');
    expect(lines.length).toBe(7);
    expect(lines[0]).toContain('Here are the points:');
    expect(lines[1]).toBe('');            // blank before the list
    expect(lines[2]).toContain('one');
    expect(lines[3]).toContain('two');    // items stay tight — no blanks between
    expect(lines[4]).toContain('three');
    expect(lines[5]).toBe('');            // blank after the list
    expect(lines[6]).toContain('Wrap-up.');
  });

  it('keeps multi-line prose paragraphs together', () => {
    const lines = render('First line of a paragraph.\nSecond line, same paragraph.');
    expect(lines.length).toBe(2);
    expect(lines[1]).not.toBe('');
  });

  it('does not double a blank line the model already emitted', () => {
    const lines = render('Paragraph one.\n\n## Heading');
    // model blank + our rule must collapse to a SINGLE blank, not two.
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('Paragraph one.');
    expect(lines[1]).toBe('');
    expect(lines[2]).toContain('Heading');
  });

  it('wraps a fenced code block in blank lines but keeps its interior tight', () => {
    const lines = render('Run this:\n```\nnpm test\nnpm build\n```\nDone.');
    // Run this: / '' / fence / npm test / npm build / fence / '' / Done.
    expect(lines[0]).toContain('Run this:');
    expect(lines[1]).toBe('');
    expect(lines[3]).toContain('npm test');
    expect(lines[4]).toContain('npm build');   // interior tight
    expect(lines[lines.length - 1]).toContain('Done.');
    expect(lines[lines.length - 2]).toBe('');
  });
});

describe('streaming render — step marker', () => {
  it('leads the first prose line with exactly one ● and no others', () => {
    const lines = render('First.\nSecond.\n## H\nThird.');
    const marker = stripVTControlCharacters(STEP_MARKER);
    expect(lines[0].startsWith(marker)).toBe(true);
    const markerCount = lines.filter((l) => l.startsWith(marker)).length;
    expect(markerCount).toBe(1);
  });

  it('places the ● on the first REAL line when the step opens with blanks', () => {
    const lines = render('\n\nActual first line.');
    const marker = stripVTControlCharacters(STEP_MARKER);
    const firstReal = lines.find((l) => l.trim().length > 0)!;
    expect(firstReal.startsWith(marker)).toBe(true);
    expect(firstReal).toContain('Actual first line.');
  });

  it('resets per step so each new stream re-marks its opening line', () => {
    const marker = stripVTControlCharacters(STEP_MARKER);
    expect(render('Step A opener.')[0].startsWith(marker)).toBe(true);
    // A brand-new state (as cli.ts creates per llm_start) marks again.
    expect(render('Step B opener.')[0].startsWith(marker)).toBe(true);
  });
});

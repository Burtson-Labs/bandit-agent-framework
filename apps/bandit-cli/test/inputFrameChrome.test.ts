/**
 * The chrome filter must drop live-input-frame lines that leak into scrollback
 * (stray composer boxes) WITHOUT ever eating a real answer line.
 */
import { describe, it, expect } from 'vitest';
import { isInputFrameChrome } from '../src/input/inputFrameChrome';

describe('isInputFrameChrome — drops frame chrome', () => {
  it('drops a rounded composer border', () => {
    expect(isInputFrameChrome('╭──────────────────────────────╮')).toBe(true);
    expect(isInputFrameChrome('╰──────────────────────────────╯')).toBe(true);
    expect(isInputFrameChrome('  ────────────────────  ')).toBe(true);
  });

  it('drops the empty composer prompt line', () => {
    expect(isInputFrameChrome('› ')).toBe(true);
    expect(isInputFrameChrome('│ › │')).toBe(true);
    expect(isInputFrameChrome('❯')).toBe(true);
  });

  it('drops the footer tip line', () => {
    expect(isInputFrameChrome('  ? shortcuts  ·  /doctor setup  ·  @path pin  ·  Ctrl+V image')).toBe(true);
    expect(isInputFrameChrome('? for shortcuts')).toBe(true);
  });

  it('sees through ANSI color codes', () => {
    expect(isInputFrameChrome('\x1b[2m╭────────╮\x1b[0m')).toBe(true);
  });
});

describe('isInputFrameChrome — never eats real content', () => {
  it('keeps a normal answer line', () => {
    expect(isInputFrameChrome('Done! The PDF has been created and saved to your Desktop.')).toBe(false);
  });

  it('keeps a markdown table row (has real content between the pipes)', () => {
    expect(isInputFrameChrome('│ Cover Page │ Title "RWT Follow-Up" with recipient info │')).toBe(false);
  });

  it('keeps the prompt when the user actually typed something', () => {
    expect(isInputFrameChrome('› ok can you create a pdf')).toBe(false);
  });

  it('keeps blank lines (legitimate spacing)', () => {
    expect(isInputFrameChrome('')).toBe(false);
    expect(isInputFrameChrome('   ')).toBe(false);
  });

  it('keeps a horizontal-rule-with-text line', () => {
    expect(isInputFrameChrome('─── Section ───')).toBe(false);
  });
});

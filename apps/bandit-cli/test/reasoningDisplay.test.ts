import { describe, it, expect } from 'vitest';
import {
  renderReasoning,
  isReasoningDisplay,
  COMPACT_REASONING_LINES,
} from '../src/reasoningDisplay';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('isReasoningDisplay', () => {
  it('accepts the three modes only', () => {
    for (const m of ['full', 'compact', 'off']) expect(isReasoningDisplay(m)).toBe(true);
    for (const m of ['', 'verbose', 'FULL', 1, null]) expect(isReasoningDisplay(m)).toBe(false);
  });
});

describe('renderReasoning', () => {
  it('full shows every line, no collapse note', () => {
    const r = renderReasoning(lines(20), 'full');
    expect(r.lines).toHaveLength(20);
    expect(r.collapsedNote).toBe('');
  });

  it('compact caps to the preview and notes how much is hidden', () => {
    const r = renderReasoning(lines(20), 'compact');
    expect(r.lines).toHaveLength(COMPACT_REASONING_LINES);
    expect(r.collapsedNote).toContain(`+${20 - COMPACT_REASONING_LINES} more lines`);
    expect(r.collapsedNote).toContain('/reasoning full');
  });

  it('compact shows everything when it already fits', () => {
    const r = renderReasoning(lines(3), 'compact');
    expect(r.lines).toHaveLength(3);
    expect(r.collapsedNote).toBe('');
  });

  it('off shows no body, just a marker', () => {
    const r = renderReasoning(lines(42), 'off');
    expect(r.lines).toHaveLength(0);
    expect(r.collapsedNote).toContain('thought for 42 lines');
  });

  it('singular/plural agree', () => {
    expect(renderReasoning('one', 'off').collapsedNote).toContain('1 line ');
    expect(renderReasoning(lines(COMPACT_REASONING_LINES + 1), 'compact').collapsedNote).toContain('1 more line ');
  });
});

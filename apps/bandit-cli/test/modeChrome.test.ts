/**
 * The mode chip must be present for EVERY mode (the boundary is always on
 * screen), give plan/auto/dangerous a distinct color from the neutral ask,
 * and spell out plan mode's read-only note.
 */
import { describe, it, expect } from 'vitest';
import { modeChrome } from '../src/input/modeChrome';

describe('modeChrome', () => {
  it('returns a chip for every mode, including the default', () => {
    for (const m of ['plan', 'ask', 'auto', 'dangerous', undefined]) {
      const chip = modeChrome(m as string | undefined);
      expect(chip.label.length, String(m)).toBeGreaterThan(0);
      expect(chip.glyph.length, String(m)).toBeGreaterThan(0);
    }
  });

  it('labels plan as read-only and colors it distinctly', () => {
    const plan = modeChrome('plan');
    expect(plan.label).toBe('plan');
    expect(plan.note).toBe('read-only');
    expect(plan.color).toBe('blue');
  });

  it('ask is the neutral (dim) mode — no color', () => {
    expect(modeChrome('ask').color).toBeUndefined();
    expect(modeChrome(undefined).label).toBe('ask'); // unknown falls back to ask
  });

  it('auto and dangerous read as escalating (green then red)', () => {
    expect(modeChrome('auto').color).toBe('green');
    expect(modeChrome('dangerous').color).toBe('red');
  });
});

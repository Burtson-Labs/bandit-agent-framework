/**
 * Footer chip + border color for the active permission mode.
 *
 * The chip is ALWAYS on screen (even in the default `ask` mode) so the current
 * permission boundary is visible without opening a menu — the "clear boundary"
 * the mode system exists to provide. shift+tab cycles ask → auto → plan; the
 * chip + border recolor the instant it changes.
 *
 * Kept as a pure, ink-free module so it unit-tests without a terminal.
 */
export interface ModeChrome {
  /** Leading glyph for the chip. */
  glyph: string;
  /** Mode name shown in the chip. */
  label: string;
  /** Short parenthetical boundary note ('' when none). */
  note: string;
  /** ink Text/border color; `undefined` renders dim (the neutral `ask`). */
  color: string | undefined;
}

export function modeChrome(mode: string | undefined): ModeChrome {
  switch (mode) {
    case 'plan':      return { glyph: '◆', label: 'plan',      note: 'read-only', color: 'blue' };
    case 'auto':      return { glyph: '▶', label: 'auto',      note: '',          color: 'green' };
    case 'dangerous': return { glyph: '⚠', label: 'dangerous', note: 'no prompts', color: 'red' };
    case 'ask':
    default:          return { glyph: '·', label: 'ask',       note: '',          color: undefined };
  }
}

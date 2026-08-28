/**
 * Detect input-frame chrome so it never gets committed into <Static> scrollback.
 *
 * In turn-view the ink input frame occasionally leaks a render into the stdout
 * capture — a rounded-border box, a bare `›` prompt, or the footer tip line.
 * Those are LIVE UI, not conversation history, so when they land in scrollback
 * they read as "stray composer boxes littered through the chat" (the exact
 * report). Filtering them at the commit boundary is safe: a line that is purely
 * frame chrome carries no conversation content, so dropping it from history can
 * only ever remove noise.
 *
 * Deliberately conservative — it must never eat a real answer. It matches only
 * lines that are ENTIRELY chrome (border glyphs / prompt / the known footer),
 * never a line that also carries prose.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Box-drawing glyphs the ink input frame's border is built from. */
const BORDER_CHARS = '─│╭╮╰╯┌┐└┘├┤┬┴┼';

/** Footer-tip fragments that only ever appear under the live input frame. */
const FOOTER_MARKERS = ['? shortcuts', '/doctor setup', '@path pin', 'Ctrl+V image', '? for shortcuts'];

/**
 * True when a committed line is nothing but input-frame chrome and should be
 * dropped from scrollback.
 */
export function isInputFrameChrome(rawLine: string): boolean {
  const line = rawLine.replace(ANSI, '');
  const trimmed = line.trim();
  if (trimmed.length === 0) {return false;} // blank lines are legitimate spacing

  // The footer tip line (shortcuts hints) is pure UI.
  if (FOOTER_MARKERS.some((m) => trimmed.includes(m))) {return true;}

  // A pure border row: only box-drawing glyphs + whitespace.
  if ([...trimmed].every((ch) => BORDER_CHARS.includes(ch) || ch === ' ')) {return true;}

  // The empty composer: the prompt glyph and box edges with no typed content.
  // e.g. "› " or "│ › │" or "╭───╮" already covered above. Match a line whose
  // only non-border content is the prompt marker.
  const withoutBorder = [...trimmed].filter((ch) => !BORDER_CHARS.includes(ch)).join('').trim();
  if (withoutBorder === '›' || withoutBorder === '❯' || withoutBorder === '>') {return true;}

  return false;
}

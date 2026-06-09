// Phase 0 spike — ink-turn-view plan §4.
// Question this answers: does ink <Static> preserve pre-colored ANSI strings
// (cyan/bold/dim/truecolor/box-drawing) without mangling color or width, while a
// live region renders below it? That risk gates the whole turn-view rewrite.
//
// Run live (in a real terminal) to eyeball it:
//     node apps/bandit-cli/scripts/spike-ink-static.mjs
// Run a programmatic byte-check (non-TTY, asserts ANSI survives):
//     node apps/bandit-cli/scripts/spike-ink-static.mjs --capture
//
// Standalone: imports ink + react directly, no build step.

import React from 'react';
import { render, Static, Box, Text } from 'ink';

const e = React.createElement;

// --- Raw ANSI matching what production cli.ts / spinner.ts / ansi.ts emit ---
const ESC = '\x1b[';
const cyan = (s) => `${ESC}36m${s}${ESC}39m`;
const bold = (s) => `${ESC}1m${s}${ESC}22m`;
const dim = (s) => `${ESC}2m${s}${ESC}22m`;
const green = (s) => `${ESC}32m${s}${ESC}39m`;
const red = (s) => `${ESC}31m${s}${ESC}39m`;
// truecolor glyph — exactly the shape spinner.ts glowGlyph() emits
const rgb = (s, r, g, b) => `${ESC}38;2;${r};${g};${b}m${s}${ESC}39m`;

// Representative production-shaped scrollback lines fed as PRE-COLORED strings.
const LINES = [
  bold(cyan('● bandit')) + dim('  ink <Static> ANSI spike'),
  '',
  cyan('┌─────────────────────────────────────────────┐'),
  cyan('│') + ' ' + bold('Tool') + dim(' · read_file') + '  src/cli.ts'.padEnd(28) + cyan('│'),
  cyan('│') + ' ' + green('+ added line') + '   ' + red('- removed line') + '          ' + cyan('│'),
  cyan('└─────────────────────────────────────────────┘'),
  '',
  // mixed colors on one line — does ink reset between segments?
  cyan('cyan ') + green('green ') + red('red ') + dim('dim ') + bold('bold ') + 'plain',
  // truecolor glow glyph (the spinner breathe)
  rgb('◐◐', 120, 200, 255) + ' ' + rgb('breathing glow', 90, 170, 230),
  // wide / unicode — width-counting check (these are 2-col glyphs)
  'wide unicode: ' + cyan('日本語テスト ✓ ▷ ◆ ●'),
  // a long line to check wrapping/width math (no early wrap expected at 80+ cols)
  dim('a long dim line that should not wrap oddly: ' + 'x'.repeat(40)),
];

function Spike() {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (process.argv.includes('--capture')) return; // no animation in capture mode
    const id = setInterval(() => setTick((t) => t + 1), 120);
    const stopId = setTimeout(() => {
      clearInterval(id);
      // unmount cleanly so the terminal is restored
      process.exit(0);
    }, 2600);
    return () => { clearInterval(id); clearTimeout(stopId); };
  }, []);

  const frames = ['◐◐', '◑◑', '⊖⊖'];
  const glyph = frames[tick % frames.length];
  // breathe brightness without Date.now() (banned) — drive off tick
  const lvl = Math.round(120 + 100 * Math.abs(Math.sin(tick / 3)));
  const glowHex = '#' + [lvl, 200, 255].map((n) => n.toString(16).padStart(2, '0')).join('');

  return e(
    React.Fragment,
    null,
    // committed scrollback — written once each, preserved in real history
    e(Static, { items: LINES }, (line, i) => e(Text, { key: i }, line)),
    // live region below: plan tree + spinner status + composer CTA
    e(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      e(Text, { dimColor: true }, '● plan · 2/3 done'),
      e(Text, { dimColor: true }, '  ✓ spike scaffold'),
      e(Text, { dimColor: true }, '  ✓ ANSI sample lines'),
      e(Text, { dimColor: true }, '  ○ verdict'),
      e(
        Text,
        null,
        e(Text, { color: 'cyan' }, glyph + ' '),
        e(Text, { color: glowHex /* ink truecolor via hex prop */ }, 'streaming'),
        e(Text, { dimColor: true }, '  3.1k tok/s · 0:04'),
      ),
      e(
        Box,
        { borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
        e(Text, null, e(Text, { dimColor: true }, '❯ '), 'type to queue · Enter sends after turn · /btw nudges now · Esc stops'),
      ),
    ),
  );
}

render(e(Spike));

if (process.argv.includes('--capture')) {
  // Give ink one paint, then exit so the parent can inspect captured bytes.
  setTimeout(() => process.exit(0), 250);
}

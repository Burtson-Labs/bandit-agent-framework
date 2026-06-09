#!/usr/bin/env node
/**
 * Generate truecolor Unicode block-art logo for the CLI.
 *
 * Reads apps/bandit-stealth/media/bandit-stealth.png, downsamples to a
 * fixed grid, and emits a JSON file containing the pre-rendered block
 * characters with embedded 24-bit ANSI color codes. The CLI then imports
 * that JSON at build time — zero runtime dep on pngjs.
 *
 * Why block-art: proper terminal image protocols (iTerm2 inline, Kitty
 * graphics) only work in ~15% of terminals. Half-block characters with
 * 24-bit color work in virtually every modern terminal including VS
 * Code's integrated terminal, Windows Terminal, macOS Terminal.app,
 * gnome-terminal, etc. The tradeoff is lower resolution than native
 * images, but for a logo at 40x20 cells it looks crisp.
 *
 * Each output line is 1 character row = 2 source pixel rows. Upper pixel
 * renders as the character foreground, lower pixel as the background,
 * using the '▀' glyph (upper half block). Transparent source pixels
 * translate to ANSI defaults so the logo adopts the terminal's theme
 * instead of forcing a specific background.
 *
 * To regenerate after editing the PNG:
 *   node scripts/gen-logo.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(__dirname, '..', '..', 'bandit-stealth', 'media', 'bandit-stealth.png');
const TARGET = resolve(__dirname, '..', 'src', 'logo.json');

// Output dimensions in character cells. 40×20 is the measured sweet
// spot: big enough to preserve the two eye slits, the round head, and
// the hood-tail on the left without any one feature becoming marginal;
// small enough that the banner takes ~20 lines of terminal instead of
// ~30. Below 36×18 the eye slits start merging into a single dark band
// and the logo loses its signature feature. Ratio N = 2M keeps the
// display roughly square given typical terminal char aspect of ~2:1.
const OUT_COLS = 40;
const OUT_LINES = 20;

// Foreground color for the silhouette. Chosen to match the CLI's accent
// cyan so the banner echoes Burtson Labs branding rather than reading
// as a grey blob. Format: [R, G, B] 8-bit.
const FG_COLOR = [88, 208, 240];

// Threshold below which the source pixel's luminance marks it as part
// of the silhouette. The source PNG is a dark-grey-on-white logo, so a
// mid-range threshold cleanly separates the two. Doing this in the
// generator rather than mapping raw RGB eliminates the rainbow edge
// noise that prior renders had — PNG anti-aliasing smears random chroma
// into near-transparent edge pixels, and a 3×3 sample box averages them
// back into visible greens/reds/blues. Thresholding is cleaner.
const LUMA_THRESHOLD = 200;
// The sampling grid is OUT_COLS wide × OUT_LINES*2 tall because each
// line uses two vertical source pixels for the half-block trick.
const SAMPLE_W = OUT_COLS;
const SAMPLE_H = OUT_LINES * 2;

const png = PNG.sync.read(readFileSync(SOURCE));

/**
 * Nearest-neighbor box sample from (srcX, srcY) using a small window so
 * sharp edges (like the bandit's mask slit) don't alias into single-
 * pixel noise at this aggressive a downscale. For each target pixel we
 * average the 3×3 source pixels around the sample center.
 */
function sampleAt(srcX, srcY) {
  const W = png.width, H = png.height;
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  const halfBoxX = Math.max(1, Math.floor(W / SAMPLE_W / 2));
  const halfBoxY = Math.max(1, Math.floor(H / SAMPLE_H / 2));
  for (let dy = -halfBoxY; dy <= halfBoxY; dy++) {
    for (let dx = -halfBoxX; dx <= halfBoxX; dx++) {
      const x = Math.min(W - 1, Math.max(0, srcX + dx));
      const y = Math.min(H - 1, Math.max(0, srcY + dy));
      const i = (y * W + x) * 4;
      r += png.data[i];
      g += png.data[i + 1];
      b += png.data[i + 2];
      a += png.data[i + 3];
      n++;
    }
  }
  return { r: (r / n) | 0, g: (g / n) | 0, b: (b / n) | 0, a: (a / n) | 0 };
}

/**
 * Treat the source pixel as silhouette-in or silhouette-out. A pixel is
 * "in" when it has meaningful alpha AND its luminance sits below the
 * threshold. Using Rec.601 luma coefficients so mid-range greys classify
 * correctly regardless of hue noise at edges.
 */
function isInSilhouette(pixel) {
  if (pixel.a < 64) return false;
  const luma = 0.299 * pixel.r + 0.587 * pixel.g + 0.114 * pixel.b;
  return luma < LUMA_THRESHOLD;
}

function buildCell(upper, lower) {
  // Each half of the cell is either "on" (brand color) or "off"
  // (transparent, reveals terminal background). Rather than mixing
  // foreground-glyph rendering for the half-block cases with
  // background-color-on-a-space for the filled case, we use ONLY
  // foreground-painted glyphs: ▀ for upper-half, ▄ for lower-half,
  // █ for both halves. Mixing FG + BG triggered a rendering glitch
  // in some terminal fonts where BG-colored spaces rendered as a
  // zero-width blank, producing an outline-only logo on output.
  // Every modern monospace font renders █ at full cell size, so
  // using it for filled cells is bulletproof across terminals.
  const RESET = '\x1b[0m';
  const fgCode = `\x1b[38;2;${FG_COLOR[0]};${FG_COLOR[1]};${FG_COLOR[2]}m`;
  const up = isInSilhouette(upper);
  const lo = isInSilhouette(lower);
  if (!up && !lo) return ' ';
  if (up && lo) return `${fgCode}█${RESET}`;
  if (up) return `${fgCode}▀${RESET}`;
  return `${fgCode}▄${RESET}`;
}

const lines = [];
for (let row = 0; row < OUT_LINES; row++) {
  let line = '';
  for (let col = 0; col < OUT_COLS; col++) {
    const srcX = Math.floor(((col + 0.5) / SAMPLE_W) * png.width);
    const srcYU = Math.floor(((row * 2 + 0.5) / SAMPLE_H) * png.height);
    const srcYL = Math.floor(((row * 2 + 1.5) / SAMPLE_H) * png.height);
    line += buildCell(sampleAt(srcX, srcYU), sampleAt(srcX, srcYL));
  }
  lines.push(line);
}

writeFileSync(
  TARGET,
  JSON.stringify(
    {
      generatedFrom: 'apps/bandit-stealth/media/bandit-stealth.png',
      cols: OUT_COLS,
      lines: OUT_LINES,
      blockArt: lines.join('\n')
    },
    null,
    2
  ) + '\n'
);

process.stdout.write(`wrote ${TARGET} (${OUT_COLS}×${OUT_LINES} cells)\n`);

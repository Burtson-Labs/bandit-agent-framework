#!/usr/bin/env node
/**
 * Print the launch banner (logo + text block) to stdout so we can
 * eyeball changes to the block-art or banner layout in a real
 * terminal before shipping. Reads `src/logo.json` directly so no
 * rebuild is needed — generate the logo with `pnpm gen-logo`, then
 * `pnpm preview-banner` to see the result.
 *
 * The version string here is cosmetic — we intentionally don't load
 * package.json because that would be misleading if you're iterating
 * on the banner BEFORE bumping the version for a release.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logoPath = resolve(__dirname, '..', 'src', 'logo.json');
const { blockArt } = JSON.parse(readFileSync(logoPath, 'utf8'));

const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';

const logo = blockArt.split('\n');
const text = [
  `${BOLD}Bandit${RESET}  ${DIM}v${pkg.version}${RESET}`,
  '',
  `${DIM}local-first coding agent${RESET}`,
  `${DIM}built by ${RESET}${CYAN}Burtson Labs${RESET}`
];

// Vertically center the text block against the logo.
const pad = Math.floor((logo.length - text.length) / 2);
const padded = [
  ...Array(pad).fill(''),
  ...text,
  ...Array(Math.max(0, logo.length - text.length - pad)).fill('')
];

process.stdout.write('\n');
process.stdout.write(
  logo.map((line, i) => `${line}   ${padded[i] ?? ''}`).join('\n')
);
process.stdout.write('\n\n');

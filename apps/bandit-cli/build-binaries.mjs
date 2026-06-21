#!/usr/bin/env node
/**
 * Compile the bundled CLI (dist/cli.js) into standalone, Node-free binaries
 * with `bun build --compile`, one per platform/arch. The binaries embed the
 * Bun runtime, so users can `curl | sh` them without Node installed (Tier 2).
 *
 * Run `node build.mjs` first (or pass --build) to produce dist/cli.js.
 * Requires `bun` on PATH. Cross-compiles every target from a single host.
 *
 *   node build-binaries.mjs            # compile all targets from existing dist/cli.js
 *   node build-binaries.mjs --build    # rebuild dist/cli.js first
 *   node build-binaries.mjs --only darwin-arm64
 *
 * Output: dist/bin/bandit-<os>-<arch>[.exe]
 *
 * Note: pdf-parse is left external in dist/cli.js (it loads its worker via a
 * dynamic require and doesn't bundle cleanly), so PDF text extraction is the
 * one feature unavailable in the standalone binary — everything else works.
 * Users who need it can `npm i -g bandit-stealth-cli` (the installer's fallback).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(here, 'dist', 'cli.js');
const outDir = path.join(here, 'dist', 'bin');

// bun target  ->  release asset name
const TARGETS = [
  { target: 'bun-darwin-arm64', name: 'bandit-darwin-arm64' },
  { target: 'bun-darwin-x64', name: 'bandit-darwin-x64' },
  { target: 'bun-linux-x64', name: 'bandit-linux-x64' },
  { target: 'bun-linux-arm64', name: 'bandit-linux-arm64' },
  { target: 'bun-windows-x64', name: 'bandit-windows-x64.exe' },
];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : null;
// --os <darwin|linux|windows> restricts to one OS family. CI builds each
// family on its own native runner: bun's cross-OS --compile tree-shook the
// createToolUseLoop definition out of darwin/windows binaries when run from a
// Linux host (see the verify step below), shipping a binary that crashed on
// first turn. Native (and same-OS cross-arch) compilation is reliable.
const osIdx = argv.indexOf('--os');
const osFamily = osIdx !== -1 ? argv[osIdx + 1] : null;

// A healthy binary embeds the createToolUseLoop definition plus its export and
// call site. A binary whose definition was tree-shaken away keeps only the call
// site and crashes at runtime with "(0, X.createToolUseLoop) is not a function".
// Scan each output and fail the build before such a binary can ship.
function verifyBinary(file, label) {
  const needle = Buffer.from('createToolUseLoop');
  const buf = fs.readFileSync(file);
  let count = 0;
  let from = 0;
  for (;;) {
    const at = buf.indexOf(needle, from);
    if (at === -1) {break;}
    count++;
    from = at + needle.length;
  }
  if (count < 2) {
    process.stderr.write(`✗ ${label}: createToolUseLoop definition missing (found ${count} reference(s)) — refusing to ship a broken binary.\n`);
    process.exit(1);
  }
  process.stdout.write(`  ✓ ${label}: createToolUseLoop present (${count} references)\n`);
}

if (argv.includes('--build') || !fs.existsSync(distEntry)) {
  process.stdout.write('› building dist/cli.js …\n');
  run(process.execPath, [path.join(here, 'build.mjs')]);
}
if (!fs.existsSync(distEntry)) {
  process.stderr.write(`✗ ${distEntry} not found — run \`node build.mjs\` first.\n`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

let selected = TARGETS;
if (only) {selected = selected.filter(t => t.name.includes(only));}
if (osFamily) {selected = selected.filter(t => t.name.includes(`-${osFamily}-`) || t.name.includes(`-${osFamily}.`));}
if (selected.length === 0) {
  process.stderr.write(`✗ no target matches ${only ? `--only "${only}" ` : ''}${osFamily ? `--os "${osFamily}"` : ''}.\n`);
  process.exit(1);
}

for (const { target, name } of selected) {
  const out = path.join(outDir, name);
  process.stdout.write(`› compiling ${target} → dist/bin/${name}\n`);
  run('bun', ['build', '--compile', `--target=${target}`, distEntry, '--outfile', out]);
  verifyBinary(out, name);
}

process.stdout.write('\n');
for (const { name } of selected) {
  const out = path.join(outDir, name);
  if (fs.existsSync(out)) {
    const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
    process.stdout.write(`✓ dist/bin/${name}  (${mb} MB)\n`);
  } else {
    process.stderr.write(`✗ dist/bin/${name} missing\n`);
    process.exit(1);
  }
}

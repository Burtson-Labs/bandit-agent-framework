#!/usr/bin/env node
/**
 * record.mjs <vidrec|videx>
 *
 * Records a scene script against the live PUBLIC truemarks.ai pages with
 * Playwright chromium (1280x720, dark scheme) and emits, under out/<product>/:
 *
 *   raw.webm        the screen recording
 *   subs.srt        subtitles built from per-step caption/narration lines
 *   steps.tsv       idx <TAB> startMs <TAB> durMs <TAB> narrationAudioRelPath
 *   timeline.json   full step timing metadata (debugging)
 *   narration/*.aiff  per-step narration via macOS `say`
 *
 * Narration uses macOS `say` as the always-available fallback so a cut always
 * renders; if `say` fails (non-macOS), steps fall back to fixed durations and
 * the assemble step produces a silent narration track (subtitles still burn).
 *
 * Step dwell time = max(MIN_STEP_S, narration duration + NARR_PAD_S), so the
 * voice never outruns the picture.
 */
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSrt, buildAss } from './lib/subs.mjs';

const pExecFile = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const MIN_STEP_S = 4.5; // never flash a scene shorter than this
const NARR_PAD_S = 1.4; // breathing room after each narration line
const FALLBACK_STEP_S = 6; // step length when narration synth is unavailable

const product = process.argv[2];
if (!product) {
  console.error('usage: node record.mjs <vidrec|videx>');
  process.exit(1);
}
const scenePath = path.join(HERE, 'scenes', `${product}.mjs`);
if (!existsSync(scenePath)) {
  console.error(`no such scene: ${scenePath}`);
  process.exit(1);
}
const { default: scene } = await import(scenePath);

const OUT = path.join(HERE, 'out', product);
await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, 'narration'), { recursive: true });
await mkdir(path.join(OUT, 'video'), { recursive: true });

// ---------------------------------------------------------------- narration
async function synth(line, file) {
  const args = [];
  if (process.env.SAY_VOICE) args.push('-v', process.env.SAY_VOICE);
  args.push('-o', file, line);
  await pExecFile('say', args);
}

// Prefer PATH ffprobe (or FFPROBE_PATH); fall back to the bundled static build.
let FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
try {
  await pExecFile(FFPROBE, ['-version']);
} catch {
  const { createRequire } = await import('node:module');
  FFPROBE = createRequire(import.meta.url)('ffprobe-static').path;
}

async function audioDurationS(file) {
  const { stdout } = await pExecFile(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    file,
  ]);
  const d = parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`bad duration for ${file}`);
  return d;
}

console.log(`[${scene.title}] synthesizing narration for ${scene.steps.length} steps`);
const steps = [];
for (let i = 0; i < scene.steps.length; i++) {
  const s = scene.steps[i];
  const idx = String(i + 1).padStart(2, '0');
  const aiff = path.join(OUT, 'narration', `step-${idx}.aiff`);
  let narrS = 0;
  let audioRel = '';
  try {
    await synth(s.narration, aiff);
    narrS = await audioDurationS(aiff);
    audioRel = path.join('narration', `step-${idx}.aiff`);
  } catch (err) {
    console.warn(`[warn] step ${idx}: narration synth unavailable (${err.message}); silent fallback`);
  }
  const durS = Math.max(MIN_STEP_S, narrS > 0 ? narrS + NARR_PAD_S : FALLBACK_STEP_S);
  steps.push({ ...s, idx, audioRel, narrS, durS });
  console.log(`  step ${idx}: ${durS.toFixed(1)}s | ${s.narration.slice(0, 64)}…`);
}

// ---------------------------------------------------------------- recording
console.log(`[${scene.title}] recording`);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: path.join(OUT, 'video'), size: { width: 1280, height: 720 } },
  colorScheme: 'dark',
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const t0 = Date.now();
const now = () => Date.now() - t0;

async function runAction(action) {
  if (!action) return;
  if (action.goto) {
    await page.goto(action.goto, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
    await page.waitForTimeout(500); // let fonts/animations settle
    return;
  }
  if (action.scrollToText) {
    try {
      const loc = page.getByText(action.scrollToText, { exact: false }).first();
      await loc.waitFor({ state: 'attached', timeout: 5_000 });
      await loc.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    } catch {
      console.warn(`[warn] scroll target not found: "${action.scrollToText}" — falling back to page scroll`);
      await page.evaluate(() => window.scrollBy({ top: 700, behavior: 'smooth' }));
    }
    return;
  }
  if (action.scrollBy) {
    await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), action.scrollBy);
  }
}

const timeline = [];
for (const s of steps) {
  const startMs = now();
  await runAction(s.action);
  const spentS = (now() - startMs) / 1000;
  const remainS = Math.max(0, s.durS - spentS);
  if (remainS > 0) await page.waitForTimeout(remainS * 1000);
  const endMs = now();
  timeline.push({
    idx: s.idx,
    narration: s.narration,
    caption: s.caption ?? s.narration,
    audioRel: s.audioRel,
    startMs,
    endMs,
    durMs: endMs - startMs,
  });
  console.log(`  step ${s.idx}: ${(startMs / 1000).toFixed(1)}s -> ${(endMs / 1000).toFixed(1)}s`);
}
await page.waitForTimeout(400); // tail so the last frame isn't clipped

const video = page.video();
await context.close();
const rawPath = path.join(OUT, 'raw.webm');
await video.saveAs(rawPath);
await browser.close();

// ---------------------------------------------------------------- artifacts
await writeFile(path.join(OUT, 'subs.srt'), buildSrt(timeline), 'utf8');
await writeFile(path.join(OUT, 'subs.ass'), buildAss(timeline), 'utf8');

const tsv = timeline
  .map((t) => [t.idx, t.startMs, t.durMs, t.audioRel].join('\t'))
  .join('\n');
await writeFile(path.join(OUT, 'steps.tsv'), tsv + '\n', 'utf8');

await writeFile(
  path.join(OUT, 'timeline.json'),
  JSON.stringify({ product: scene.product, title: scene.title, recordedAt: new Date().toISOString(), timeline }, null, 2),
  'utf8',
);

console.log(`[${scene.title}] done -> ${rawPath} (${(timeline.at(-1).endMs / 1000).toFixed(1)}s), subs.srt, subs.ass, steps.tsv`);

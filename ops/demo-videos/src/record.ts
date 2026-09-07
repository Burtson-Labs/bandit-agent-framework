/**
 * Drive a chromium page through a scene with Playwright video recording ON.
 *
 * Emits into out/<scene>/:
 *   video.webm     — the raw recording (context video, viewport-sized)
 *   steps.json     — [{ index, title, narration, startMs, endMs }] video-relative
 *   subtitles.srt  — narration lines timed to when each step ran
 *   narration.txt  — the plain narration script, one line per step
 *
 * Pacing: each step stays on screen at least as long as its narration
 * audio (durations from narrate.ts) plus padding, so assemble.sh can lay
 * each audio file down at its step's start without overlap.
 *
 * Auth: set STORAGE_STATE=/path/to/auth.json to record with a signed-in
 * session (Playwright storage state). Never put credentials in scenes.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import type { NarrationLine } from './narrate.js';
import { resolveScene, type ResolvedScene, type Scene, type SceneStep } from './types.js';

const STEP_PAD_MS = 900; // air after each narration line
const MIN_STEP_MS = 3200; // floor when narration is very short / missing
const OUTRO_MS = 1600; // hold the last frame

export interface StepTiming {
  index: number;
  title: string;
  /** Spoken line (what TTS reads). */
  narration: string;
  /** Burned-in display text (defaults to the spoken line). */
  subtitle: string;
  startMs: number;
  endMs: number;
}

function srtTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const frac = clamped % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(frac, 3)}`;
}

/** Split a narration line onto at most two subtitle rows at a word boundary. */
function wrapSubtitle(text: string, width = 46): string {
  if (text.length <= width) return text;
  const words = text.split(' ');
  let first = '';
  while (words.length > 0 && `${first}${first ? ' ' : ''}${words[0]}`.length <= width) {
    first = `${first}${first ? ' ' : ''}${words.shift()}`;
  }
  return first.length > 0 ? `${first}\n${words.join(' ')}` : text;
}

export function buildSrt(timings: StepTiming[]): string {
  return `${timings
    .map((t, i) => {
      const start = Math.max(t.startMs, 200);
      const end = Math.max(start + 800, t.endMs - 200);
      return `${i + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${wrapSubtitle(t.subtitle)}`;
    })
    .join('\n\n')}\n`;
}

export async function recordScene(
  scene: ResolvedScene,
  outDir: string,
  narration?: NarrationLine[],
): Promise<StepTiming[]> {
  mkdirSync(outDir, { recursive: true });
  const viewport = scene.viewport ?? { width: 1280, height: 720 };

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: outDir, size: viewport },
    storageState: scene.storageStatePath,
  });
  const page = await context.newPage();
  console.log(
    `recording ${viewport.width}x${viewport.height}${scene.storageStatePath ? ` with storage state ${scene.storageStatePath}` : ' (unauthenticated)'}`,
  );

  const t0 = Date.now();
  const timings: StepTiming[] = [];
  for (let i = 0; i < scene.steps.length; i++) {
    const step: SceneStep = scene.steps[i];
    const startMs = Date.now() - t0;
    try {
      await step.action(page);
    } catch (err) {
      console.warn(`step ${i + 1} (${step.title ?? 'untitled'}) action failed — continuing: ${err instanceof Error ? err.message : err}`);
    }
    const audioMs = narration?.[i]?.ms ?? 0;
    const minMs = Math.max(step.minMs ?? 0, audioMs + STEP_PAD_MS, MIN_STEP_MS);
    const elapsed = Date.now() - t0 - startMs;
    if (elapsed < minMs) await page.waitForTimeout(minMs - elapsed);
    const endMs = Date.now() - t0;
    timings.push({
      index: i,
      title: step.title ?? `step-${i + 1}`,
      narration: step.narration.trim(),
      subtitle: (step.subtitle ?? step.narration).trim(),
      startMs,
      endMs,
    });
    console.log(`  step ${i + 1}/${scene.steps.length} ${step.title ?? ''} ${(startMs / 1000).toFixed(1)}s → ${(endMs / 1000).toFixed(1)}s`);
  }
  await page.waitForTimeout(OUTRO_MS);

  const video = page.video();
  await context.close(); // flushes the recording
  await browser.close();
  if (!video) throw new Error('Playwright returned no video for the recording context');
  renameSync(await video.path(), join(outDir, 'video.webm'));

  writeFileSync(join(outDir, 'steps.json'), `${JSON.stringify(timings, null, 2)}\n`);
  writeFileSync(join(outDir, 'subtitles.srt'), buildSrt(timings));
  writeFileSync(join(outDir, 'narration.txt'), `${timings.map((t) => t.narration).join('\n')}\n`);
  console.log(`recorded ${((Date.now() - t0) / 1000).toFixed(1)}s → ${join(outDir, 'video.webm')}`);
  return timings;
}

async function loadSceneModule(name: string): Promise<Scene> {
  const scenePath = resolve(import.meta.dirname, '..', 'scenes', `${name}.ts`);
  if (!existsSync(scenePath)) throw new Error(`No scene at scenes/${name}.ts`);
  const mod = (await import(pathToFileURL(scenePath).href)) as { default?: Scene; scene?: Scene };
  const scene = mod.default ?? mod.scene;
  if (!scene) throw new Error(`scenes/${name}.ts must default-export a Scene`);
  return scene;
}

// Standalone: pnpm record <scene> (uses audio/durations.json for pacing when present)
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const name = process.argv[2];
  if (!name) {
    console.error('usage: pnpm record <scene-name>');
    process.exit(1);
  }
  const scene = resolveScene(await loadSceneModule(name));
  const outDir = resolve(import.meta.dirname, '..', 'out', name);
  const durationsPath = join(outDir, 'audio', 'durations.json');
  const narration = existsSync(durationsPath)
    ? (JSON.parse(readFileSync(durationsPath, 'utf8')) as NarrationLine[])
    : undefined;
  if (!narration) console.warn('no audio/durations.json — pacing with defaults (run `pnpm narrate` first for narration-length steps)');
  await recordScene(scene, outDir, narration);
}

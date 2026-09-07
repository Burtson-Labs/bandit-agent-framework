/**
 * Turn a scene's narration lines into per-line audio files.
 *
 * Primary engine: Bandit cloud TTS — the exact endpoint + payload the
 * Stealth extension uses (apps/bandit-stealth/src/voiceProviders.ts):
 * POST {apiUrl}/api/stealth/tts  { Text, ModelName }  → audio/mpeg bytes,
 * authenticated with the bai_ key from ~/.bandit/config.json.
 * Voices: en_US-brian-premium (default) / en_US-jessica-premium.
 *
 * Fallback: macOS `say` → AIFF → m4a (via ffmpeg), so the pipeline still
 * produces a reviewable cut with no network or key. The engine used per
 * line is recorded in audio/durations.json.
 *
 * Output (out/<scene>/audio/): line-NN.mp3|m4a + durations.json
 * [{ index, file, ms, engine, text }] — record.ts paces steps with the
 * durations; assemble.sh places each file at its step's timestamp.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBanditCreds, ttsEndpoint } from './config.js';
import { ffmpegBin, probeDurationMs } from './ff.js';
import { resolveScene, type ResolvedScene, type Scene } from './types.js';

export type NarrationEngine = 'bandit-tts' | 'macos-say';

export interface NarrationLine {
  index: number;
  /** Filename inside out/<scene>/audio/. */
  file: string;
  ms: number;
  engine: NarrationEngine;
  text: string;
}

export const DEFAULT_VOICE = 'en_US-brian-premium';

async function banditTts(url: string, apiKey: string, text: string, voice: string): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ Text: text, ModelName: voice }),
      signal: AbortSignal.timeout(45_000),
    });
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < 512) throw new Error(`Bandit TTS returned a suspiciously small body (${bytes.byteLength}B)`);
      return bytes;
    }
    const detail = await response.text().catch(() => '');
    const err = `Bandit TTS failed: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 160)}` : ''}`;
    if (response.status >= 500 && attempt === 0) {
      console.warn(`${err} — retrying once`);
      continue;
    }
    throw new Error(err);
  }
  throw new Error('Bandit TTS failed after retry');
}

function macosSay(text: string, aiffPath: string, m4aPath: string): void {
  const preferred = process.env.DEMO_SAY_VOICE ?? 'Samantha';
  try {
    execFileSync('say', ['-v', preferred, '-o', aiffPath, text], { stdio: 'pipe' });
  } catch {
    execFileSync('say', ['-o', aiffPath, text], { stdio: 'pipe' }); // voice not installed — use system default
  }
  execFileSync(ffmpegBin(), ['-y', '-v', 'error', '-i', aiffPath, '-c:a', 'aac', '-b:a', '160k', m4aPath], { stdio: 'pipe' });
  rmSync(aiffPath, { force: true });
}

export async function narrateScene(scene: ResolvedScene, outDir: string): Promise<NarrationLine[]> {
  const audioDir = join(outDir, 'audio');
  mkdirSync(audioDir, { recursive: true });

  const creds = loadBanditCreds();
  const voice = process.env.BANDIT_TTS_VOICE ?? scene.voice ?? DEFAULT_VOICE;
  const url = ttsEndpoint(creds.apiUrl);
  let banditAvailable = Boolean(creds.apiKey);
  if (!banditAvailable) {
    console.warn('No Bandit API key (env or ~/.bandit/config.json) — narrating with macOS `say`.');
  }

  const lines: NarrationLine[] = [];
  for (let i = 0; i < scene.steps.length; i++) {
    const text = scene.steps[i].narration.trim();
    const base = `line-${String(i + 1).padStart(2, '0')}`;
    let file: string | undefined;
    let engine: NarrationEngine = 'bandit-tts';

    if (banditAvailable) {
      try {
        const bytes = await banditTts(url, creds.apiKey!, text, voice);
        file = `${base}.mp3`;
        writeFileSync(join(audioDir, file), bytes);
      } catch (err) {
        console.warn(`${err instanceof Error ? err.message : err} — falling back to macOS \`say\` for the rest of this scene.`);
        banditAvailable = false;
      }
    }
    if (!file) {
      engine = 'macos-say';
      file = `${base}.m4a`;
      macosSay(text, join(audioDir, `${base}.aiff`), join(audioDir, file));
    }

    const ms = probeDurationMs(join(audioDir, file));
    lines.push({ index: i, file, ms, engine, text });
    console.log(`  narration ${i + 1}/${scene.steps.length} [${engine}] ${(ms / 1000).toFixed(1)}s  ${text}`);
  }

  writeFileSync(join(audioDir, 'durations.json'), `${JSON.stringify(lines, null, 2)}\n`);
  return lines;
}

async function loadSceneModule(name: string): Promise<Scene> {
  const scenePath = resolve(import.meta.dirname, '..', 'scenes', `${name}.ts`);
  if (!existsSync(scenePath)) throw new Error(`No scene at scenes/${name}.ts`);
  const mod = (await import(pathToFileURL(scenePath).href)) as { default?: Scene; scene?: Scene };
  const scene = mod.default ?? mod.scene;
  if (!scene) throw new Error(`scenes/${name}.ts must default-export a Scene`);
  return scene;
}

// Standalone: pnpm narrate <scene>
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const name = process.argv[2];
  if (!name) {
    console.error('usage: pnpm narrate <scene-name>');
    process.exit(1);
  }
  const scene = resolveScene(await loadSceneModule(name));
  const outDir = resolve(import.meta.dirname, '..', 'out', name);
  await narrateScene(scene, outDir);
}

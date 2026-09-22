/**
 * Turn a scene's narration lines into per-line audio files.
 *
 * Primary engine: Kokoro 82M, local and free (see kokoro.ts) — narration is
 * re-cut constantly while a scene is being tuned, and every re-cut used to
 * spend TTS quota. Default voice `af_sarah`.
 *
 * Second engine: Bandit cloud TTS — the exact endpoint + payload the
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
import {
  DEFAULT_KOKORO_VOICE,
  kokoroAvailable,
  kokoroDescribe,
  kokoroSpeak,
  kokoroWriteWav,
} from './kokoro.js';
import { resolveScene, type ResolvedScene, type Scene } from './types.js';

export type NarrationEngine = 'kokoro' | 'bandit-tts' | 'macos-say';

export interface NarrationLine {
  index: number;
  /** Filename inside out/<scene>/audio/. */
  file: string;
  ms: number;
  engine: NarrationEngine;
  text: string;
}

export const DEFAULT_VOICE = 'en_US-brian-premium';

/** Kokoro names voices `<lang><gender>_<name>`; Bandit's are `en_US-…`. */
function looksLikeKokoroVoice(v: string): boolean {
  return /^[abefhijpz][fm]_/.test(v);
}

/**
 * Which engine narrates. `DEMO_TTS_ENGINE` forces one (and is honoured even
 * when it cannot run, so a container misconfiguration fails loudly instead of
 * quietly narrating in the wrong voice). Otherwise: Kokoro if a bundle is
 * installed, else cloud TTS if there is a key, else macOS `say`.
 */
function chooseEngine(hasKey: boolean): NarrationEngine {
  const forced = process.env.DEMO_TTS_ENGINE;
  if (forced === 'kokoro') return 'kokoro';
  if (forced === 'bandit') return 'bandit-tts';
  if (forced === 'say') return 'macos-say';
  if (forced) throw new Error(`DEMO_TTS_ENGINE must be kokoro|bandit|say, got "${forced}"`);
  if (kokoroAvailable()) return 'kokoro';
  return hasKey ? 'bandit-tts' : 'macos-say';
}

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
  const url = ttsEndpoint(creds.apiUrl);
  let engineChoice = chooseEngine(Boolean(creds.apiKey));

  const sceneVoice = scene.voice;
  const kokoroVoice =
    process.env.KOKORO_VOICE ??
    (sceneVoice && looksLikeKokoroVoice(sceneVoice) ? sceneVoice : undefined) ??
    DEFAULT_KOKORO_VOICE;
  const banditVoice =
    process.env.BANDIT_TTS_VOICE ??
    (sceneVoice && !looksLikeKokoroVoice(sceneVoice) ? sceneVoice : undefined) ??
    DEFAULT_VOICE;

  if (engineChoice === 'kokoro') console.log(`  ${kokoroDescribe()} — voice ${kokoroVoice}`);
  else if (engineChoice === 'bandit-tts') console.log(`  Bandit cloud TTS — voice ${banditVoice}`);
  else console.warn('  No Kokoro bundle and no Bandit API key — narrating with macOS `say`.');

  let banditAvailable = Boolean(creds.apiKey);

  const lines: NarrationLine[] = [];
  for (let i = 0; i < scene.steps.length; i++) {
    const text = scene.steps[i].narration.trim();
    const base = `line-${String(i + 1).padStart(2, '0')}`;
    let file: string | undefined;
    let engine: NarrationEngine = engineChoice;

    if (engineChoice === 'kokoro') {
      try {
        const speech = await kokoroSpeak(text, kokoroVoice);
        const wav = `${base}.wav`;
        kokoroWriteWav(join(audioDir, wav), speech);
        file = `${base}.mp3`;
        execFileSync(
          ffmpegBin(),
          ['-y', '-v', 'error', '-i', join(audioDir, wav), '-c:a', 'libmp3lame', '-b:a', '160k', join(audioDir, file)],
          { stdio: 'pipe' },
        );
        rmSync(join(audioDir, wav), { force: true });
      } catch (err) {
        // A bad voice name is a mistake to surface, not to paper over with a
        // different voice halfway through a scene.
        if (err instanceof Error && /is not in this bundle/.test(err.message)) throw err;
        console.warn(`${err instanceof Error ? err.message : err} — falling back for the rest of this scene.`);
        engineChoice = banditAvailable ? 'bandit-tts' : 'macos-say';
        engine = engineChoice;
      }
    }

    if (!file && engineChoice === 'bandit-tts' && banditAvailable) {
      try {
        const bytes = await banditTts(url, creds.apiKey!, text, banditVoice);
        file = `${base}.mp3`;
        writeFileSync(join(audioDir, file), bytes);
      } catch (err) {
        console.warn(`${err instanceof Error ? err.message : err} — falling back to macOS \`say\` for the rest of this scene.`);
        banditAvailable = false;
        engineChoice = 'macos-say';
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

/**
 * Kokoro 82M narration — local, CPU-only, offline, free.
 *
 * This is the default narration engine. Model weights (hexgrad/Kokoro-82M) and
 * the sherpa-onnx runtime are both Apache-2.0, it runs on CPU with no GPU and
 * no network, and it costs nothing per line — so re-cutting a demo twenty
 * times does not spend ElevenLabs credits or Bandit TTS quota. It is also what
 * makes the pipeline container-friendly: a render pod needs ffmpeg, a headless
 * browser, and this. No accelerator.
 *
 * Voices are addressed BY NAME (`af_sarah`) and resolved to a speaker id from
 * the model's own ONNX metadata, never from a hardcoded table. Bundles differ —
 * the English-only v0_19 ships 11 voices, multi-lang v1_0 ships 54 — so a
 * baked-in index silently narrates in the wrong voice the day someone swaps
 * the bundle. Reading the model means a swap either works or fails loudly.
 */
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * sherpa-onnx-node is a CommonJS native addon, and Node's ESM interop only
 * surfaces SOME of its named exports (`OnlineRecognizer` arrives, `OfflineTts`
 * does not). require() gets the whole module, so use it rather than chasing
 * `.default` through an interop shim that may change.
 */
const requireCjs = createRequire(import.meta.url);
function sherpa(): any {
  return requireCjs('sherpa-onnx-node');
}

/** Apache-2.0 bundles published by the sherpa-onnx project. */
export const KOKORO_BUNDLE = process.env.KOKORO_BUNDLE ?? 'kokoro-multi-lang-v1_0';
export const KOKORO_BUNDLE_URL =
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${KOKORO_BUNDLE}.tar.bz2`;

/** The voice this pipeline narrates in unless a scene says otherwise. */
export const DEFAULT_KOKORO_VOICE = 'af_sarah';

/**
 * Where the model bundle lives. `models/<bundle>` inside this project is the
 * answer that works in a container; the voice-lab checkout is a convenience
 * for this machine so nobody downloads 326MB twice.
 */
export function kokoroModelDir(): string | null {
  const candidates = [
    process.env.KOKORO_MODEL_DIR,
    resolve(import.meta.dirname, '..', 'models', KOKORO_BUNDLE),
    join(homedir(), 'Documents', 'GitHub', 'voice-lab', 'models', KOKORO_BUNDLE),
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    if (existsSync(join(dir, 'model.onnx')) && existsSync(join(dir, 'voices.bin'))) return dir;
  }
  return null;
}

/**
 * Speaker names, read from the ONNX `speaker_names` metadata entry.
 *
 * The value is a comma-separated string inside a protobuf
 * StringStringEntryProto. It sits past the weights — 326MB in — so this seeks
 * to the tail rather than reading the file, and falls back to the head for
 * bundles that order their metadata the other way.
 */
export function kokoroVoices(modelPath: string): string[] {
  const size = statSync(modelPath).size;
  const fd = openSync(modelPath, 'r');
  try {
    const WINDOW = 2_000_000;
    for (const offset of [Math.max(0, size - WINDOW), 0]) {
      const buf = Buffer.alloc(Math.min(WINDOW, size - offset));
      readSync(fd, buf, 0, buf.length, offset);
      const key = buf.indexOf('speaker_names');
      if (key < 0) continue;
      let p = key + 'speaker_names'.length + 1; // skip the key, then the value's field tag
      let len = 0;
      for (let shift = 0; ; shift += 7) {
        const b = buf[p++];
        len |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
      }
      const names = buf.subarray(p, p + len).toString('utf8').split(',').filter(Boolean);
      if (names.length > 0) return names;
    }
  } finally {
    closeSync(fd);
  }
  return [];
}

export interface KokoroSpeech {
  samples: Float32Array;
  sampleRate: number;
}

/** Loaded once per process — constructing it reads a 326MB model. */
let engine: { tts: unknown; voices: string[]; dir: string } | null = null;

export function kokoroAvailable(): boolean {
  return kokoroModelDir() !== null;
}

async function load(): Promise<{ tts: any; voices: string[]; dir: string }> {
  if (engine) return engine as { tts: any; voices: string[]; dir: string };
  const dir = kokoroModelDir();
  if (!dir) {
    throw new Error(
      `No Kokoro bundle found. Run \`pnpm fetch-voice\` (downloads ${KOKORO_BUNDLE}), ` +
        'or point KOKORO_MODEL_DIR at an existing copy.',
    );
  }
  // Loaded lazily: the native addon should not load for a run that never
  // narrates (record-only, assemble-only).
  const { OfflineTts } = sherpa();
  const tts = new OfflineTts({
    model: {
      kokoro: {
        model: join(dir, 'model.onnx'),
        voices: join(dir, 'voices.bin'),
        tokens: join(dir, 'tokens.txt'),
        dataDir: join(dir, 'espeak-ng-data'),
        ...(existsSync(join(dir, 'lexicon-us-en.txt'))
          ? { lexicon: join(dir, 'lexicon-us-en.txt') }
          : {}),
      },
      numThreads: Number(process.env.KOKORO_THREADS ?? 2),
      provider: 'cpu',
    },
  });
  engine = { tts, voices: kokoroVoices(join(dir, 'model.onnx')), dir };
  return engine as { tts: any; voices: string[]; dir: string };
}

/** Speaker id for a voice name, or a clear error listing what IS available. */
export function speakerId(voices: string[], name: string): number {
  const i = voices.indexOf(name);
  if (i >= 0) return i;
  const english = voices.filter((v) => /^[ab][fm]_/.test(v));
  throw new Error(
    `Kokoro voice "${name}" is not in this bundle (${KOKORO_BUNDLE}). ` +
      `English voices available: ${english.join(', ') || voices.slice(0, 12).join(', ')}`,
  );
}

export async function kokoroSpeak(text: string, voice: string, speed = 1.0): Promise<KokoroSpeech> {
  const { tts, voices } = await load();
  const out = tts.generate({ text, sid: speakerId(voices, voice), speed });
  return { samples: out.samples, sampleRate: out.sampleRate };
}

/** Write a generated clip to disk as a WAV, via the binding's own writer. */
export function kokoroWriteWav(path: string, speech: KokoroSpeech): void {
  sherpa().writeWave(path, { samples: speech.samples, sampleRate: speech.sampleRate });
}

/** Human-readable line for the run log. */
export function kokoroDescribe(): string {
  const dir = kokoroModelDir();
  if (!dir) return 'Kokoro: no bundle installed';
  const voices = kokoroVoices(join(dir, 'model.onnx'));
  return `Kokoro ${KOKORO_BUNDLE} (${voices.length} voices) from ${dir}`;
}

// Standalone smoke test: pnpm tsx src/kokoro.ts "some text" [voice] [out.wav]
if (process.argv[1]?.endsWith('kokoro.ts')) {
  const text = process.argv[2] ?? 'Bandit Stealth runs your coding agent locally.';
  const voice = process.argv[3] ?? DEFAULT_KOKORO_VOICE;
  const out = process.argv[4] ?? 'kokoro-sample.wav';
  console.log(kokoroDescribe());
  const t0 = Date.now();
  const speech = await kokoroSpeak(text, voice);
  kokoroWriteWav(out, speech);
  const seconds = speech.samples.length / speech.sampleRate;
  console.log(
    `  ${voice}: ${seconds.toFixed(1)}s of audio in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`,
  );
}

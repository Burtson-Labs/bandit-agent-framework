import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function which(cmd: string): string | undefined {
  try {
    const out = execFileSync('which', [cmd], { encoding: 'utf8' }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** System ffmpeg first (brew install ffmpeg), ffmpeg-static npm package as fallback. */
export function ffmpegBin(): string {
  const sys = which('ffmpeg');
  if (sys) return sys;
  try {
    const p = require('ffmpeg-static') as string | null;
    if (p) return p;
  } catch {
    /* not installed */
  }
  throw new Error('ffmpeg not found. `brew install ffmpeg`, or `pnpm add -D ffmpeg-static` in ops/demo-videos.');
}

export function ffprobeBin(): string {
  const sys = which('ffprobe');
  if (sys) return sys;
  try {
    const p = require('@ffprobe-static/path') as { path?: string };
    if (p?.path) return p.path;
  } catch {
    /* not installed */
  }
  try {
    const p = require('ffprobe-static') as { path?: string };
    if (p?.path) return p.path;
  } catch {
    /* not installed */
  }
  throw new Error('ffprobe not found. `brew install ffmpeg`, or `pnpm add -D ffprobe-static` in ops/demo-videos.');
}

/** Duration of a media file in whole milliseconds. */
export function probeDurationMs(file: string): number {
  const out = execFileSync(
    ffprobeBin(),
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { encoding: 'utf8' },
  ).trim();
  const seconds = Number.parseFloat(out);
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe returned no duration for ${file}`);
  return Math.round(seconds * 1000);
}

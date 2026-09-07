#!/usr/bin/env node
/**
 * Emit the ffmpeg filtergraph for a scene's final mix (used by assemble.sh).
 *
 *   node buildFilter.mjs <outDir> <musicPathOrEmpty>
 *
 * Reads  <outDir>/steps.json + <outDir>/audio/durations.json.
 * Writes <outDir>/filter.txt (for -filter_complex_script).
 * Prints the ordered audio input files, one per line: narration lines
 * first (input indexes 1..N; index 0 is the video), music last if given.
 *
 * Graph: each narration line is delayed to its step's start timestamp and
 * mixed into [nar]; the music bed is held low and sidechain-ducked under
 * the voice; subtitles.srt is burned into the video (relative path —
 * assemble.sh runs ffmpeg from <outDir>).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, musicPath] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: node buildFilter.mjs <outDir> <musicPathOrEmpty>');
  process.exit(1);
}

const steps = JSON.parse(readFileSync(join(outDir, 'steps.json'), 'utf8'));
const lines = JSON.parse(readFileSync(join(outDir, 'audio', 'durations.json'), 'utf8'));
const hasMusic = Boolean(musicPath) && existsSync(musicPath);

const inputs = lines.map((l) => join(outDir, 'audio', l.file));
const parts = [];

// Video: normalize fps, burn subtitles.
const subStyle = [
  'FontName=Helvetica',
  'FontSize=15',
  'PrimaryColour=&H00FFFFFF',
  'OutlineColour=&H6E000000',
  'BackColour=&H6E000000',
  'BorderStyle=1',
  'Outline=1',
  'Shadow=1',
  'MarginV=26',
].join(',');
parts.push(`[0:v]fps=30,subtitles=filename=subtitles.srt:force_style='${subStyle}'[vout]`);

// Narration lines, each delayed to its step's start.
const narLabels = [];
lines.forEach((l, i) => {
  const delay = Math.max(0, Math.round(steps[i]?.startMs ?? 0));
  parts.push(`[${i + 1}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${delay}:all=1[n${i}]`);
  narLabels.push(`[n${i}]`);
});
if (narLabels.length === 1) {
  parts.push(`[n0]anull[nar]`);
} else {
  parts.push(`${narLabels.join('')}amix=inputs=${narLabels.length}:normalize=0:dropout_transition=0[nar]`);
}

// Music bed: quiet by default, ducked further while narration plays.
if (hasMusic) {
  inputs.push(musicPath);
  const m = lines.length + 1;
  parts.push(`[${m}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=0.22[mus]`);
  parts.push(`[nar]asplit=2[narA][narB]`);
  parts.push(`[mus][narB]sidechaincompress=threshold=0.02:ratio=10:attack=50:release=600[duck]`);
  parts.push(`[narA][duck]amix=inputs=2:normalize=0:dropout_transition=0,volume=4dB[aout]`);
} else {
  parts.push(`[nar]volume=4dB[aout]`);
}

writeFileSync(join(outDir, 'filter.txt'), `${parts.join(';\n')}\n`);
for (const f of inputs) console.log(f);

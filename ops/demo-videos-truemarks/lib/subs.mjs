/**
 * Subtitle builders shared by record.mjs and re-runnable standalone:
 *
 *   node lib/subs.mjs out/<product>   # regenerate subs.srt + subs.ass
 *                                     # from an existing timeline.json
 *
 * We burn the .ass variant (its style header carries font/outline/margins),
 * because ffmpeg 8's filtergraph parser no longer accepts the quoted
 * force_style=... inline form. The .srt stays as a portable deliverable.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function wrapCaption(text, width = 48) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width && line) {
      lines.push(line);
      line = w;
    } else {
      line = (line ? line + ' ' : '') + w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function srtTime(ms) {
  const t = Math.max(0, Math.round(ms));
  return `${pad(Math.floor(t / 3_600_000))}:${pad(Math.floor((t % 3_600_000) / 60_000))}:${pad(Math.floor((t % 60_000) / 1000))},${pad(t % 1000, 3)}`;
}

export function assTime(ms) {
  const t = Math.max(0, Math.round(ms));
  const cs = Math.round((t % 1000) / 10);
  return `${Math.floor(t / 3_600_000)}:${pad(Math.floor((t % 3_600_000) / 60_000))}:${pad(Math.floor((t % 60_000) / 1000))}.${pad(cs)}`;
}

function cueWindow(t) {
  const start = t.startMs + 120;
  const end = Math.max(start + 800, t.endMs - 250);
  return { start, end };
}

export function buildSrt(timeline) {
  return timeline
    .map((t, i) => {
      const { start, end } = cueWindow(t);
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${wrapCaption(t.caption ?? t.narration).join('\n')}\n`;
    })
    .join('\n');
}

export function buildAss(timeline, { width = 1280, height = 720 } = {}) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Demo,Helvetica,26,&H00FFFFFF,&H000000FF,&H00101010,&H98000000,1,0,0,0,100,100,0,0,3,3,0,2,60,60,28,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = timeline
    .map((t) => {
      const { start, end } = cueWindow(t);
      const text = wrapCaption(t.caption ?? t.narration).join('\\N');
      return `Dialogue: 0,${assTime(start)},${assTime(end)},Demo,,0,0,0,,${text}`;
    })
    .join('\n');
  return header + events + '\n';
}

// ---- standalone: regenerate subs from an existing timeline.json
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node lib/subs.mjs out/<product>');
    process.exit(1);
  }
  const { timeline } = JSON.parse(await readFile(path.join(dir, 'timeline.json'), 'utf8'));
  await writeFile(path.join(dir, 'subs.srt'), buildSrt(timeline), 'utf8');
  await writeFile(path.join(dir, 'subs.ass'), buildAss(timeline), 'utf8');
  console.log(`regenerated ${dir}/subs.srt and ${dir}/subs.ass (${timeline.length} cues)`);
}

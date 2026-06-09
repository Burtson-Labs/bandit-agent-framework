import { c, supportsTrueColor, supportsBlockArt, downsampleTruecolorTo256 } from './ansi';
import { detectLang, highlightCode, type LangSpec } from './syntaxHighlight';

// Diff line backgrounds — GitHub/Claude-style highlight bands. Subtle dark
// truecolor tint when the terminal supports it (so it reads as a highlight,
// not a neon block), falling back to the 16-color bg pair on basic
// terminals, and to plain text when color is disabled (NO_COLOR / non-TTY).
// `colorsOn` is probed off the theme helper so we honor the same gating.
const COLORS_ON = c.red('x') !== 'x';
const TRUECOLOR_BG = supportsTrueColor();
// macOS Terminal.app et al.: 256-color capable but not 24-bit. Build the SAME
// truecolor band + syntax, then downsample fg/bg to the 256 palette (each a
// single SGR code → no Apple-Terminal bleed) so diffs still highlight there.
const COLOR256 = !TRUECOLOR_BG && supportsBlockArt();

// Truecolor band escapes. On 24-bit terminals the bg is a subtle dark tint
// and the base fg is the soft add/remove color; identifiers/punctuation keep
// that base while IDE-style syntax colors are woven over the top. Syntax
// highlighting is gated on TRUECOLOR_BG: on 16-color terminals the band is a
// bright `\x1b[42m`/`\x1b[41m` block where colored foregrounds would be
// illegible, so those keep the flat look.
const ADD_BG = '\x1b[48;2;18;48;28m';
const ADD_FG = '\x1b[38;2;152;234;164m';
const DEL_BG = '\x1b[48;2;58;26;30m';
const DEL_FG = '\x1b[38;2;255;160;160m';

/**
 * Render one diff row's highlight band. `prefix` (gutter + marker) is drawn in
 * the band's base color; `code` is syntax-highlighted on truecolor terminals
 * when a language is known. `bandW > 0` pads the visible row out to that width
 * (full-width bands); `bandW === 0` leaves the band content-width. Padding is
 * sized from the VISIBLE text length so the injected color escapes never throw
 * the width off.
 */
function band(kind: 'add' | 'del', prefix: string, code: string, bandW: number, lang: LangSpec | null): string {
  const visibleLen = prefix.length + code.length;
  const fill = bandW > 0 && visibleLen < bandW ? ' '.repeat(bandW - visibleLen) : '';
  if (!COLORS_ON) return `${prefix}${code}${fill}`;
  if (TRUECOLOR_BG || COLOR256) {
    const baseFg = kind === 'add' ? ADD_FG : DEL_FG;
    const bg = kind === 'add' ? ADD_BG : DEL_BG;
    const body = lang ? highlightCode(code, lang, baseFg) : code;
    const seq = `${bg}${baseFg}${prefix}${body}${fill}\x1b[39m\x1b[49m`;
    return COLOR256 ? downsampleTruecolorTo256(seq) : seq;
  }
  const bg16 = kind === 'add' ? '\x1b[42m' : '\x1b[41m';
  return `${bg16}\x1b[30m${prefix}${code}${fill}\x1b[39m\x1b[49m`;
}

/**
 * Minimal unified-diff renderer — no external deps. Uses Myers-like LCS to find
 * the longest common subsequence, then walks both sequences emitting +/- lines.
 * For the approval gate we just need human-readable output, not a patch file.
 */
export function renderDiff(before: string, after: string, maxLines = 60, relPath?: string): string {
  if (before === after) {
    return c.dim('(no change — content identical)');
  }

  const lang = relPath ? detectLang(relPath) : null;
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const lcs = computeLcs(beforeLines, afterLines);
  const ops = buildOps(beforeLines, afterLines, lcs);
  const previewOps = compactOps(ops, 3);
  const plusCount = ops.filter((op) => op.kind === 'add').length;
  const minusCount = ops.filter((op) => op.kind === 'del').length;

  // Line-number gutter (new-file numbering; deletions show their old-file
  // number). Width sized to the larger file, min 2.
  const maxNo = Math.max(beforeLines.length, afterLines.length);
  const gw = Math.max(2, String(maxNo).length);
  const pad = (n: number | string): string => String(n).padStart(gw);
  const blank = ' '.repeat(gw);

  const out: string[] = [];
  let shown = 0;
  let oldNo = 1;
  let newNo = 1;

  for (const op of previewOps) {
    if (shown >= maxLines) {
      out.push(c.dim(`${blank}   … (${previewOps.length - shown} preview lines hidden)`));
      break;
    }
    if (op.kind === 'skip') {
      oldNo += op.count;
      newNo += op.count;
      out.push(c.dim(`${blank}   … (${op.count} unchanged lines)`));
      shown++;
      continue;
    }
    switch (op.kind) {
      case 'equal':
        out.push(c.dim(`${pad(newNo)}   ${op.line}`));
        oldNo++; newNo++; shown++;
        break;
      case 'add':
        out.push(`${c.dim(pad(newNo))} ${band('add', '+ ', op.line, 0, lang)}`);
        newNo++; shown++;
        break;
      case 'del':
        out.push(`${c.dim(pad(oldNo))} ${band('del', '- ', op.line, 0, lang)}`);
        oldNo++; shown++;
        break;
    }
  }

  const summary = c.dim(`${blank}   (${c.green('+' + plusCount)} ${c.red('-' + minusCount)})`);
  return out.join('\n') + '\n' + summary;
}

/**
 * Claude-style "applied diff" — rendered AFTER an edit lands, as the
 * durable record of what actually changed (vs. renderDiff, which is the
 * pre-approval preview). Differences from renderDiff:
 *   - a header line: `● Updated <path>   +N -M`
 *   - a line-number gutter on every row (new-file numbering; deletions
 *     show their old-file number)
 *   - collapsed unchanged runs render as a single `⋯`
 *   - additions are green, deletions red, context dim — markers aligned
 *
 * A brand-new file (before === '') renders as a pure-add "Created" block.
 * Returns '' when there's no change so callers can skip cleanly.
 */
export function renderAppliedDiff(
  relPath: string,
  before: string,
  after: string,
  opts: { maxLines?: number; verb?: string } = {}
): string {
  if (before === after) return '';
  const maxLines = opts.maxLines ?? 80;
  const isNew = before === '';
  const verb = isNew ? 'Created' : (opts.verb ?? 'Updated');

  const lang = detectLang(relPath);
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // Gutter width from the larger file's line count, min 2.
  const maxNo = Math.max(beforeLines.length, afterLines.length);
  const gw = Math.max(2, String(maxNo).length);
  const pad = (n: number | string): string => String(n).padStart(gw);
  const blank = ' '.repeat(gw);

  // Full-width highlight bands (GitHub/Claude look): each changed row's
  // visible text is padded out to (terminal width − indent − 1) so the
  // green/red band spans the whole row. The −1 dodges the cursor-wrap quirk
  // on lines exactly the terminal width. Code is syntax-highlighted over the
  // band on truecolor terminals (see `band`).
  const indent = '  ';
  const cols = process.stdout.columns || 100;
  const bandW = Math.max(24, cols - indent.length - 1);
  const addRow = (no: number, line: string): string => indent + band('add', `${pad(no)} + `, line, bandW, lang);
  const delRow = (no: number, line: string): string => indent + band('del', `${pad(no)} - `, line, bandW, lang);
  const ctxRow = (no: number, line: string): string => `${indent}${c.dim(pad(no))}   ${c.dim(line)}`;
  const counts = (p: number, m: number): string =>
    c.dim(`    Added ${p} line${p === 1 ? '' : 's'}, removed ${m} line${m === 1 ? '' : 's'}`);
  const head = (v: string): string => `  ${c.accent('●')} ${c.bold(v)} ${c.cyan(relPath)}`;

  // Brand-new file: pure-add block, no LCS (diffing against a single empty
  // "" line would otherwise emit a phantom deletion).
  if (isNew) {
    const rows: string[] = [head('Created'), counts(afterLines.length, 0)];
    let shownNew = 0;
    for (let i = 0; i < afterLines.length; i++) {
      if (shownNew >= maxLines) {
        rows.push(`${indent}${c.dim(blank)}   ${c.dim(`… ${afterLines.length - shownNew} more diff lines`)}`);
        break;
      }
      rows.push(addRow(i + 1, afterLines[i]));
      shownNew++;
    }
    return rows.join('\n');
  }

  const lcs = computeLcs(beforeLines, afterLines);
  const ops = buildOps(beforeLines, afterLines, lcs);
  const plus = ops.filter((op) => op.kind === 'add').length;
  const minus = ops.filter((op) => op.kind === 'del').length;
  const previewOps = compactOps(ops, 3);

  const out: string[] = [head(verb), counts(plus, minus)];
  let oldNo = 1;
  let newNo = 1;
  let shown = 0;

  for (const op of previewOps) {
    if (shown >= maxLines) {
      out.push(`${indent}${c.dim(blank)}   ${c.dim(`… ${previewOps.length - shown} more diff lines`)}`);
      break;
    }
    if (op.kind === 'skip') {
      // A run of unchanged lines collapsed — advance both counters so the
      // numbers after the gap stay correct.
      oldNo += op.count;
      newNo += op.count;
      out.push(`${indent}${c.dim(blank)} ${c.dim('⋯')}`);
      shown++;
      continue;
    }
    if (op.kind === 'equal') {
      out.push(ctxRow(newNo, op.line));
      oldNo++; newNo++; shown++;
      continue;
    }
    if (op.kind === 'del') {
      out.push(delRow(oldNo, op.line));
      oldNo++; shown++;
      continue;
    }
    out.push(addRow(newNo, op.line));
    newNo++; shown++;
  }

  return out.join('\n');
}

type Op = { kind: 'equal' | 'add' | 'del'; line: string };
type PreviewOp = Op | { kind: 'skip'; count: number };

function compactOps(ops: Op[], contextLines: number): PreviewOp[] {
  const changed = ops
    .map((op, index) => op.kind === 'equal' ? -1 : index)
    .filter((index) => index >= 0);

  if (changed.length === 0) return ops;

  const keep = new Set<number>();
  for (const index of changed) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(ops.length - 1, index + contextLines);
    for (let i = start; i <= end; i++) keep.add(i);
  }

  const out: PreviewOp[] = [];
  let skipped = 0;
  for (let i = 0; i < ops.length; i++) {
    if (!keep.has(i)) {
      skipped++;
      continue;
    }
    if (skipped > 0) {
      out.push({ kind: 'skip', count: skipped });
      skipped = 0;
    }
    out.push(ops[i]);
  }
  if (skipped > 0) out.push({ kind: 'skip', count: skipped });
  return out;
}

function buildOps(a: string[], b: string[], lcs: number[][]): Op[] {
  const ops: Op[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: 'equal', line: a[i - 1] });
      i--; j--;
    } else if (lcs[i][j - 1] >= lcs[i - 1][j]) {
      ops.push({ kind: 'add', line: b[j - 1] });
      j--;
    } else {
      ops.push({ kind: 'del', line: a[i - 1] });
      i--;
    }
  }
  while (i > 0) { ops.push({ kind: 'del', line: a[i - 1] }); i--; }
  while (j > 0) { ops.push({ kind: 'add', line: b[j - 1] }); j--; }
  return ops.reverse();
}

function computeLcs(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
  }
  return table;
}

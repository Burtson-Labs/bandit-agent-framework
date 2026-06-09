/**
 * Pure formatting helpers extracted from extension.ts to reduce its size.
 *
 * Every function here is self-contained: no `this`, no closure over IDE
 * provider state, no VS Code API calls. Safe to import from anywhere
 * (the activate() entry, the BanditStealthViewProvider class, slash
 * command modules, etc.) and equally safe to unit test in isolation.
 *
 * Why this file exists separately:
 * extension.ts crossed 9k lines and bandit's own self-evaluation flagged
 * it as "monolithic — hard to navigate." This is the first cohesive
 * extraction: pure helpers with zero dependencies on the
 * BanditStealthViewProvider closure. ~280 lines off the top with no
 * behavior change. Future extractions (slash commands, agent event
 * handler, diff preview) need more care because they touch class state.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Read a file's UTF-8 contents synchronously, returning empty string on
 * any error. Used in fast-path scenarios where the absence of a file
 * (workspace not yet indexed, deleted between scan and read, etc.) is
 * not exceptional and should fall through silently.
 */
export function readFileSafe(absolutePath: string): string {
  try {
    return fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Compact a tool's `primary` display value for the inline `→ tool path`
 * activity marker. Absolute paths get rewritten to workspace-relative
 * form; anything still longer than 60 chars is trimmed with a leading
 * ellipsis so the filename stays visible. Non-path primaries (patterns,
 * shell commands, URLs) are just length-clamped.
 */
export function compactToolDisplayParam(raw: string, workspaceRoot: string): string {
  if (!raw) {return '';}
  let out = raw;
  // "." / "./" mean "the workspace root" — rendering `ls .` in the
  // timeline is visual noise and reads worse than just `ls`. Same for
  // an absolute path that resolves back to the workspace root itself.
  if (out === '.' || out === './') {return '';}
  if (path.isAbsolute(raw) && workspaceRoot) {
    const rel = path.relative(workspaceRoot, raw);
    if (!rel || rel === '.') {return '';}
    if (!rel.startsWith('..')) {
      out = rel;
    }
  }
  // Strip a leading `./` on relative paths so the row reads
  // `ls src/` instead of `ls ./src/`.
  if (out.startsWith('./')) {out = out.slice(2);}
  const MAX = 60;
  if (out.length > MAX) {
    out = '…' + out.slice(out.length - (MAX - 1));
  }
  return out;
}

/**
 * Wraps compactToolDisplayParam with per-tool extras so the timeline
 * row shows the *useful* shape of the call rather than just the path.
 * Today: read_file gets a `(lines X-Y)` suffix when paginated, matching
 * the Claude-Code pattern of "Read README.md (lines 2-61)" so a long
 * file that gets paginated across N tool calls renders as N visibly
 * distinct rows instead of N copies of the same line.
 */
export function formatToolPrimaryDisplay(
  toolName: string,
  params: Record<string, string> | undefined,
  workspaceRoot: string
): string {
  // added `goal` to the fallback chain so the `task` tool
  // (whose primary input is `goal`, not path/pattern/cmd/url/query)
  // surfaces real content in the timeline row. Pre-fix, every task
  // call's primary collapsed to '' and the repeat detector at
  // extension.ts:4087 saw N back-to-back `→ task ` rows as identical
  // and stamped each one with "ALREADY RUN" — even when the goals
  // were six entirely different fan-out investigations. With `goal`
  // in the fallback, each task row shows its goal text and the
  // repeat detector compares real semantic content.
  const rawPrimary = params?.path || params?.pattern || params?.cmd || params?.url || params?.query || params?.goal || '';
  const primary = compactToolDisplayParam(rawPrimary, workspaceRoot);
  if (toolName === 'read_file' && primary) {
    const offsetN = parseInt(params?.offset ?? '', 10);
    const limitN = parseInt(params?.limit ?? '', 10);
    if (Number.isFinite(offsetN) && offsetN > 0) {
      const start = offsetN;
      const end = Number.isFinite(limitN) && limitN > 0 ? offsetN + limitN - 1 : null;
      return end ? `${primary} (lines ${start}-${end})` : `${primary} (from line ${start})`;
    }
    if (Number.isFinite(limitN) && limitN > 0) {
      return `${primary} (lines 1-${limitN})`;
    }
  }
  if (toolName === 'replace_range' && primary) {
    const start = params?.start_line;
    const end = params?.end_line ?? start;
    return start ? `${primary} (lines ${start}-${end})` : primary;
  }
  // task goals can be 200+ chars (subagent dispatch prompts). Truncate
  // so the timeline row stays compact — repeat detection still works
  // because two distinct truncated goals start with different prefixes.
  if (toolName === 'task' && primary) {
    const compact = primary.replace(/\s+/g, ' ').trim();
    return compact.length > 80 ? `${compact.slice(0, 80)}…` : compact;
  }
  return primary;
}

/**
 * Build the fence-info header for a unified diff block. The webview's
 * diff-card parses path/plus/minus from this so the rendered card can
 * display the file name + change stats in its summary instead of a
 * generic "diff" label.
 */
export function buildDiffFenceInfo(meta?: { relPath?: string; plus?: number; minus?: number }): string {
  if (!meta || !meta.relPath) {return 'diff';}
  const encodedPath = meta.relPath.replace(/ /g, '%20');
  const parts = ['diff', `path=${encodedPath}`];
  if (typeof meta.plus === 'number') {parts.push(`plus=${meta.plus}`);}
  if (typeof meta.minus === 'number') {parts.push(`minus=${meta.minus}`);}
  return parts.join(' ');
}

/**
 * Build a compact unified diff block (fenced as `diff` so markdown
 * renderers highlight it). Uses Myers-style LCS for files up to ~2000
 * lines (4M cells, ~32MB peak heap, ~150ms upper bound), falls back to
 * a hash-set diff for larger files. Either way the block stays under
 * `maxLines` lines so the timeline doesn't get overwhelmed by a big
 * file rewrite.
 */
export function buildCompactDiffBlock(
  before: string,
  after: string,
  maxLines = 60,
  meta?: { relPath?: string; plus?: number; minus?: number }
): string {
  if (before === after) {return '';}
  const a = before.split('\n');
  const b = after.split('\n');
  const fenceInfo = buildDiffFenceInfo(meta);
  // Hash-set fallback for huge files. Loses "line moved" vs "line
  // changed" distinction (produces wrong +/- counts on shifted blocks)
  // but at least preserves the card. 4M cell threshold ≈ ~2000 lines
  // square; that smaller threshold dropped diff
  // cards on 700+ line files where the LCS would have completed fine.
  if (a.length * b.length > 4_000_000) {
    const beforeSet = new Set(a);
    const afterSet = new Set(b);
    const added: string[] = [];
    const removed: string[] = [];
    for (const line of b) {
      if (!beforeSet.has(line)) {added.push(line);}
    }
    for (const line of a) {
      if (!afterSet.has(line)) {removed.push(line);}
    }
    const shown: string[] = [];
    const half = Math.floor(maxLines / 2);
    for (const line of removed.slice(0, half)) {shown.push('- ' + line);}
    for (const line of added.slice(0, maxLines - shown.length)) {shown.push('+ ' + line);}
    if (shown.length === 0) {return '';}
    const truncated = added.length + removed.length > shown.length;
    const suffix = truncated ? '\n… (truncated; file too large for full diff)' : '';
    return '```' + fenceInfo + '\n' + shown.join('\n') + suffix + '\n```\n';
  }
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  const ops: Array<{ kind: 'eq' | 'add' | 'del'; line: string }> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { ops.unshift({ kind: 'eq', line: a[i - 1] }); i--; j--; }
    else if (table[i][j - 1] >= table[i - 1][j]) { ops.unshift({ kind: 'add', line: b[j - 1] }); j--; }
    else { ops.unshift({ kind: 'del', line: a[i - 1] }); i--; }
  }
  while (i > 0) { ops.unshift({ kind: 'del', line: a[i - 1] }); i--; }
  while (j > 0) { ops.unshift({ kind: 'add', line: b[j - 1] }); j--; }

  const lines: string[] = [];
  let shown = 0;
  for (let k = 0; k < ops.length && shown < maxLines; k++) {
    const op = ops[k];
    if (op.kind === 'eq') {
      const prev = ops[k - 1];
      const next = ops[k + 1];
      if ((prev && prev.kind !== 'eq') || (next && next.kind !== 'eq')) {
        lines.push(' ' + op.line);
        shown++;
      }
      continue;
    }
    lines.push((op.kind === 'add' ? '+' : '-') + ' ' + op.line);
    shown++;
  }
  if (lines.length === 0) {return '';}
  const truncated = ops.filter(o => o.kind !== 'eq').length > maxLines;
  const suffix = truncated ? '\n… (truncated)' : '';
  return '```' + fenceInfo + '\n' + lines.join('\n') + suffix + '\n```\n';
}

/**
 * Count added and removed lines between before/after. Simple
 * line-level diff based on longest-common-subsequence; tight budget
 * since we only need totals for the summary marker, not the actual
 * diff lines.
 */
export function lineDiffCounts(before: string, after: string): { plus: number; minus: number } {
  if (before === after) {return { plus: 0, minus: 0 };}
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  let i = m;
  let j = n;
  let plus = 0;
  let minus = 0;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { i--; j--; }
    else if (table[i][j - 1] >= table[i - 1][j]) { plus++; j--; }
    else { minus++; i--; }
  }
  plus += j;
  minus += i;
  return { plus, minus };
}

/**
 * Short human-readable description of a tool invocation, shown in the
 * permission prompt. Keeps the message tight so the modal stays
 * scannable.
 */
export function describeToolForPrompt(
  name: string,
  primary: string,
  params: Record<string, string>
): string {
  if (name === 'write_file') {
    const bytes = params.content ? params.content.length : undefined;
    const sizeHint = bytes !== undefined ? ` (${bytes} bytes)` : '';
    return `write_file ${primary || '(path unknown)'}${sizeHint}`;
  }
  if (name === 'replace_range') {
    const range = params.start_line
      ? `${params.start_line}-${params.end_line ?? params.start_line}`
      : 'range unknown';
    return `replace_range ${primary || '(path unknown)'}:${range}`;
  }
  if (name === 'run_command') {
    const args = params.args ? ` ${params.args}` : '';
    return `run_command ${primary || '(cmd unknown)'}${args}`.trim();
  }
  if (name === 'git_commit') {
    return `git commit: ${params.message ? params.message.slice(0, 80) : '(no message)'}`;
  }
  if (primary) {return `${name} ${primary}`;}
  return name;
}

/**
 * Generate a 16-char alphanumeric nonce for the webview Content-Security-Policy.
 * Used to ensure inline scripts in the webview HTML are only executable when
 * they bear the matching nonce attribute.
 */
export function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 16; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/** Truncate a string to `max` characters with a trailing ellipsis. */
export function truncate(value: string, max = 120): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

/** Cap a unified-diff at `maxLines` lines and append a marker so the reader knows it was clipped. */
export function truncateDiff(diff: string, maxLines = 200): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) {
    return diff;
  }
  const head = lines.slice(0, maxLines);
  head.push('... diff truncated ...');
  return head.join('\n');
}

/**
 * Trim a file content snippet to fit the chat preview budget. Caps
 * at `maxLines` lines AND `maxLength` chars — whichever bites first
 * — and appends an ellipsis marker so the user knows it was clipped.
 * Distinct from `truncate`: this preserves line structure (line-wise
 * cap) where `truncate` is a flat character cap.
 */
export function truncateContextAttachment(content: string, maxLines = 120, maxLength = 6000): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const selected = lines.slice(0, maxLines);
  let joined = selected.join('\n');
  if (lines.length > maxLines) {
    joined += '\n…';
  }
  if (joined.length > maxLength) {
    joined = `${joined.slice(0, maxLength - 1)}…`;
  }
  return joined;
}

/**
 * Cheap binary-content sniff: scan the first 1 KB for a NUL byte.
 * Anything with a NUL is treated as binary and skipped from text-only
 * preview pipelines (read_file truncation, context attachment, etc).
 * Not a perfect heuristic but consistent with how most editors decide
 * whether to render a file as text.
 */
export function isLikelyBinary(buffer: Uint8Array): boolean {
  const sampleLength = Math.min(buffer.length, 1024);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

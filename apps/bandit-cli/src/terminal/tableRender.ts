/**
 * Markdown-table → ANSI box-drawing renderer for the streamed CLI
 * output. Models love to emit `|col|col|` tables but the raw markdown
 * looks ugly in a terminal — column widths don't align, the `|---|`
 * separator row reads as noise, and the user can't tell at a glance
 * which row is the header.
 *
 * Approach: a per-stream state machine that detects a table opening
 * (any line matching `/^\s*\|.*\|\s*$/` whose follow-up line matches
 * the `|:?---:?|` separator pattern), buffers every subsequent
 * `|...|` line until a non-table line OR a blank line OR the stream
 * closes, then renders the buffered rows with column widths sized to
 * the widest cell and emits box-drawing chars (┌─┬─┐ │ │ ├─┼─┤ └─┴─┘).
 *
 * Tradeoff: rendering pauses on the table — the user sees the prose
 * stream live, then the table pops in once complete. Streaming column
 * widths is impossible without seeing every row first. Same approach
 * Claude Code uses for tables in its terminal renderer.
 *
 * Strictly CLI-only — the VS Code extension renders via its webview's
 * markdown-it/highlight.js pipeline and never goes through this code
 * path, so changes here can't tangle the extension.
 */
import { c } from '../ansi';
import type { StreamStrippingState } from '../streaming/streamStripping';

export const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
export const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

export interface ParsedTable {
  align: ('left' | 'center' | 'right')[];
  rows: string[][]; // header is rows[0]; body is rows[1..]
}

export function parseTableSeparator(line: string): ('left' | 'center' | 'right')[] | null {
  if (!TABLE_SEPARATOR_RE.test(line)) return null;
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  return cells.map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

export function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

export function visibleLength(s: string): number {
  // Strip ANSI escape codes when measuring column width.
  // eslint-disable-next-line no-control-regex
  let stripped = s.replace(/\[[0-9;]*m/g, '');
  // Belt-and-suspenders: also strip a bareword form in case ESC was
  // already consumed upstream and only the CSI tail remains.
  stripped = stripped.replace(/\[[0-9;]*m/g, '');
  // strip markdown FORMATTING markup before measuring.
  // Table parsing runs BEFORE markdown-to-ANSI conversion
  // (consumeTablesInChunk → consumeMarkdownInChunk in the pipeline),
  // so a cell containing `` `"3"` `` reaches us as 5 characters of
  // raw markdown. visibleLength was counting all 5, then the
  // downstream markdown pass replaced the backticks with ANSI color
  // codes and the visible width became 3 — but the padding was
  // already locked in at 5. Real a row
  // with two inline-code cells (`"3"` / `"1"`) over-padded ~2 chars
  // each, drifting the column dividers and pushing the last cell
  // visually into the wrong column. Stripping the markup here
  // matches what the renderer will actually emit. The replacements
  // are bounded so legitimate punctuation in prose isn't eaten.
  stripped = stripped.replace(/`([^`]+)`/g, '$1');
  stripped = stripped.replace(/\*\*([^*]+)\*\*/g, '$1');
  stripped = stripped.replace(/(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, '$1');
  stripped = stripped.replace(/(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '$1');
  // Count display columns, not UTF-16 code units. Wide chars (emoji,
  // CJK, fullwidth punctuation) render two terminal columns; iterating
  // codepoints (`for...of`) avoids surrogate-pair miscounts. The bug
  // this fixes: a `# emoji Code Review` header used `.length` and missed
  // the emoji extra column, so column-aware code (table padding,
  // dividers) drifted by one and ate the next char.
  //
  // added U+2600..U+27BF (misc symbols, dingbats) and
  // U+2B50..U+2BFF (stars) which are the base codepoints for emoji
  // rendered with variation selector U+FE0F (e.g. ☸️ 🌡️ ⚠️ 🕐 ⭐).
  // Without these ranges, the variation selector was skipped (correct)
  // but the base symbol was counted as width 1 (wrong), causing table
  // column drift when emoji with variation selectors appeared in cells.
  let width = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xFE0F || cp === 0x200D) continue;
    if (
      cp >= 0x1100 &&
      (
        cp <= 0x115F ||
        cp === 0x2329 || cp === 0x232A ||
        (cp >= 0x2600 && cp <= 0x27BF) ||
        (cp >= 0x2B50 && cp <= 0x2BFF) ||
        (cp >= 0x2E80 && cp <= 0x303E) ||
        (cp >= 0x3041 && cp <= 0x33FF) ||
        (cp >= 0x3400 && cp <= 0x4DBF) ||
        (cp >= 0x4E00 && cp <= 0x9FFF) ||
        (cp >= 0xA000 && cp <= 0xA4CF) ||
        (cp >= 0xAC00 && cp <= 0xD7A3) ||
        (cp >= 0xF900 && cp <= 0xFAFF) ||
        (cp >= 0xFE30 && cp <= 0xFE4F) ||
        (cp >= 0xFF00 && cp <= 0xFF60) ||
        (cp >= 0xFFE0 && cp <= 0xFFE6) ||
        (cp >= 0x1F000 && cp <= 0x1FFFF) ||
        (cp >= 0x20000 && cp <= 0x3FFFD)
      )
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function padCell(text: string, width: number, align: 'left' | 'center' | 'right'): string {
  const visible = visibleLength(text);
  const pad = Math.max(0, width - visible);
  if (align === 'right') return ' '.repeat(pad) + text;
  if (align === 'center') {
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + text + ' '.repeat(pad - l);
  }
  return text + ' '.repeat(pad);
}

export function renderTable(parsed: ParsedTable): string {
  if (parsed.rows.length === 0) return '';
  const colCount = Math.max(...parsed.rows.map((r) => r.length));
  // Pad short rows so every row has the same number of cells. Models
  // sometimes emit a header with N cells and a body row with N-1.
  for (const row of parsed.rows) while (row.length < colCount) row.push('');
  const align: ('left' | 'center' | 'right')[] = [];
  for (let i = 0; i < colCount; i++) align.push(parsed.align[i] ?? 'left');
  const widths: number[] = [];
  for (let i = 0; i < colCount; i++) {
    widths.push(Math.max(...parsed.rows.map((r) => visibleLength(r[i]))));
  }
  // terminal-aware width gate. The original renderer computed
  // column widths from the widest cell with no upper bound, so a single
  // 200-char cell produced a row that vastly exceeded the terminal's
  // columns. The terminal then wrapped mid-cell, breaking alignment and
  // making the table read worse than the raw markdown. Real symptom
  // on a turn with paragraph-length cells. When the
  // computed table width would overflow the terminal, fall back to a
  // definition-list rendering: one labeled field per line, blank line
  // between rows. Reads cleanly at any width, no fake alignment.
  const overhead = 4 + (colCount - 1) * 3; // `│ ` + ` │ ` separators + ` │`
  const totalWidth = widths.reduce((sum, w) => sum + w, 0) + overhead;
  const termWidth = Math.max(40, process.stdout.columns ?? 100);
  if (totalWidth > termWidth) {
    return renderTableAsDefinitionList(parsed.rows, colCount);
  }
  const drawRow = (cells: string[]) =>
    '│ ' + cells.map((cell, i) => padCell(cell, widths[i], align[i])).join(' │ ') + ' │';
  const drawDivider = (left: string, mid: string, right: string) =>
    left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right;
  const lines: string[] = [];
  lines.push(c.dim(drawDivider('┌', '┬', '┐')));
  lines.push(c.bold(drawRow(parsed.rows[0])));
  lines.push(c.dim(drawDivider('├', '┼', '┤')));
  for (let i = 1; i < parsed.rows.length; i++) lines.push(drawRow(parsed.rows[i]));
  lines.push(c.dim(drawDivider('└', '┴', '┘')));
  return lines.join('\n') + '\n';
}

/**
 * fallback renderer for tables that don't fit the terminal.
 * Emits each body row as a labeled block: the header value becomes the
 * field label (bold), the body cell becomes the value. Rows separated
 * by a blank line. Reads as a clean record list, no fake column
 * alignment that breaks on wrap.
 *
 * Headers row is rows[0]; each subsequent row is one record.
 */
export function renderTableAsDefinitionList(rows: string[][], colCount: number): string {
  if (rows.length < 2) {
    // Header-only or empty — just emit the header row inline so the
    // user still sees what the model intended. Definition-list shape
    // doesn't help when there are no body rows.
    const header = rows[0] ?? [];
    return header.map((h) => c.bold(h)).join('  ·  ') + '\n';
  }
  const headers = rows[0];
  const out: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    for (let j = 0; j < colCount; j++) {
      const label = headers[j] ?? `col ${j + 1}`;
      const value = row[j] ?? '';
      out.push(c.bold(label) + c.dim(': ') + value);
    }
    if (i < rows.length - 1) out.push('');
  }
  return out.join('\n') + '\n';
}

/**
 * Pass `consumeStreamChunk`'s output through the table state machine.
 * Returns text safe to emit to stdout. When the state machine is
 * mid-table, returns "" (table is being buffered) and emits the
 * rendered table on the line that closes it. Stream closure should
 * call `flushTableState(state)` to drain any unfinished buffer.
 */
export function consumeTablesInChunk(state: StreamStrippingState, clean: string): string {
  if (clean.length === 0) return '';
  let out = '';
  // Work on whole lines — buffer any partial trailing line back into
  // tableBuffer so we don't half-recognize a row that's still arriving.
  const combined = state.tableBuffer + clean;
  const lastNl = combined.lastIndexOf('\n');
  if (lastNl === -1) {
    // No complete line yet. If we're inside a code fence, pass through
    // — the markdown renderer downstream will colour it. Otherwise the
    // existing rule applies: if the partial doesn't look like a
    // pipe-row, emit it live; only buffer when it might be one.
    if (state.tableInCodeFence) {
      state.tableBuffer = '';
      return clean;
    }
    if (!state.inTable && !combined.trimStart().startsWith('|')) {
      state.tableBuffer = '';
      return clean;
    }
    state.tableBuffer = combined;
    return '';
  }
  const completeChunk = combined.slice(0, lastNl + 1);
  state.tableBuffer = combined.slice(lastNl + 1);
  const lines = completeChunk.split('\n');
  // The split leaves an empty final element from the trailing \n; drop it.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  // Pending-table accumulator — once we see a header row we hold it
  // until either the separator confirms a table OR the next line
  // disproves it (in which case we emit the pending header as plain
  // text and move on).
  // We piggyback on tableBuffer's role for in-flight chars; rows are
  // tracked via a closure-local since they live one consumeTables call
  // at most when state.inTable is false.
  const pending: string[] = [];
  const pushPending = () => {
    if (pending.length) {
      out += pending.join('\n') + '\n';
      pending.length = 0;
    }
  };
  // Rows already confirmed as part of the current table.
  // Stored on state when state.inTable is true.
  let tableLines: string[] = state.inTable
    ? state.tableBuffer.length === 0 && (state as unknown as { _tlines?: string[] })._tlines
      ? ((state as unknown as { _tlines?: string[] })._tlines as string[])
      : []
    : [];
  // Simpler approach: keep a local list and stash on state when we leave the loop
  if (state.inTable) {
    const stashed = (state as unknown as { _tlines?: string[] })._tlines;
    tableLines = Array.isArray(stashed) ? stashed : [];
  }

  // Code-fence awareness. A markdown table inside a ```markdown / ```md
  // fence is the model demonstrating *source*, not asking us to render
  // a box. Without this guard the table renderer eagerly consumes those
  // pipe-rows and the user sees an ASCII box where they expected raw
  // markdown. Toggle a local fence flag on every ```/~~~ line so the
  // table parser bails out while we're inside source. This mirrors the
  // markdown renderer's `state.inCodeFence`, but tracked separately
  // because the table consumer runs *before* the markdown consumer in
  // the pipeline and can't read its state mid-stream. Observed
  // 2026-05-01 when the user asked for a "markdown table example" and
  // got the example rendered as a box instead of as the source it was
  // meant to be.
  const FENCE_LINE_RE = /^\s*(?:```|~~~)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_LINE_RE.test(line)) {
      // Bail out of any in-flight table — a fence inside a table is
      // either malformed input or the model closing the table block
      // and starting source, in which case rendering what we have so
      // far is the right call.
      if (state.inTable) {
        out += renderBufferedTable(tableLines);
        tableLines = [];
        state.inTable = false;
      }
      state.tableInCodeFence = !state.tableInCodeFence;
      pushPending();
      out += line + '\n';
      continue;
    }
    if (state.tableInCodeFence) {
      // Pass source lines through verbatim — they're for the markdown
      // renderer to colour as code, not for us to box.
      pushPending();
      out += line + '\n';
      continue;
    }
    const isRow = TABLE_ROW_RE.test(line);
    if (state.inTable) {
      if (isRow) {
        tableLines.push(line);
        continue;
      }
      // Table closes on the first non-row (blank, prose, fence, etc).
      out += renderBufferedTable(tableLines);
      tableLines = [];
      state.inTable = false;
      // The closing line itself isn't part of the table — emit it as
      // normal output (could be a blank line; that's fine).
      out += line + '\n';
      continue;
    }
    // Not in a table yet. A potential opener is a row whose NEXT line
    // is a separator. If this row is the LAST line of the chunk, the
    // separator is still in flight in the next chunk — defer the row
    // by stashing it back into tableBuffer (with its newline) so the
    // next call sees `header\nseparator\n` and recognises the opener.
    // Without this, header rows that arrive a chunk before their
    // separator leak through as raw markdown and the whole table
    // misses its box-drawing render.
    if (isRow && i === lines.length - 1) {
      state.tableBuffer = line + '\n' + state.tableBuffer;
      pushPending();
      (state as unknown as { _tlines?: string[] })._tlines = state.inTable ? tableLines : undefined;
      return out;
    }
    if (isRow && i + 1 < lines.length && parseTableSeparator(lines[i + 1])) {
      pushPending();
      tableLines = [line, lines[i + 1]];
      state.inTable = true;
      i++; // skip the separator (already consumed)
      continue;
    }
    // A row line whose follow-up isn't a separator → not a table.
    // Could also be that the follow-up line hasn't arrived yet — but
    // since we're working on lines that ALREADY had a trailing \n, the
    // separator (if it existed) is in our current chunk. So treat
    // unmatched `|...|` as plain prose and emit.
    pending.push(line);
  }
  pushPending();
  // Stash table lines if we're still mid-table when we finish this chunk.
  (state as unknown as { _tlines?: string[] })._tlines = state.inTable ? tableLines : undefined;
  return out;
}

export function renderBufferedTable(tableLines: string[]): string {
  if (tableLines.length < 2) {
    // Not enough to be a table after all — emit verbatim.
    return tableLines.length ? tableLines.join('\n') + '\n' : '';
  }
  const align = parseTableSeparator(tableLines[1]);
  if (!align) {
    return tableLines.join('\n') + '\n';
  }
  const header = splitTableRow(tableLines[0]);
  const body = tableLines.slice(2).map(splitTableRow);
  return '\n' + renderTable({ align, rows: [header, ...body] }) + '\n';
}

export function flushTableState(state: StreamStrippingState): string {
  let out = '';
  if (state.inTable) {
    const stashed = (state as unknown as { _tlines?: string[] })._tlines;
    if (Array.isArray(stashed) && stashed.length) {
      out += renderBufferedTable(stashed);
    }
    state.inTable = false;
    (state as unknown as { _tlines?: string[] })._tlines = undefined;
  }
  if (state.tableBuffer.length) {
    out += state.tableBuffer;
    state.tableBuffer = '';
  }
  return out;
}

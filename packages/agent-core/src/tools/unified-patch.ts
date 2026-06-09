/**
 * Minimal unified-diff parser + applier.
 *
 * Models trained on github code have seen far more unified-diff format
 * than they have seen our `apply_edit` find/replace shape, and patches
 * carry built-in context lines that double as preview-friendly diffs
 * for approval UIs. This module powers the `apply_patch` tool —
 * deliberately small, no external deps, just enough to handle the
 * common cases (one or more hunks per file, ~3 lines of context, no
 * binary patches, no rename headers).
 *
 * Format reminder:
 *
 *   @@ -10,5 +10,7 @@
 *    unchanged line
 *    another unchanged
 *   -removed line
 *   +added line
 *   +another added
 *    unchanged line
 *
 * What we DO support:
 *   - Multiple hunks per patch
 *   - File header lines (`--- a/…` / `+++ b/…`) — parsed and ignored;
 *     the caller owns the path
 *   - Trailing-newline absence on the final hunk
 *   - Small context drift (find the hunk by content even if the
 *     line numbers are off by a few)
 *
 * What we DON'T support (yet):
 *   - Binary patches
 *   - Rename / mode-change headers
 *   - `git diff --no-index` style headers
 *   - Whitespace-only matches across mixed-indent context
 */

export interface PatchHunk {
  /** 1-based starting line in the original file (per @@ header). */
  oldStart: number;
  /** Lines of the original this hunk modifies (per @@ header). */
  oldCount: number;
  /** 1-based starting line in the new file. */
  newStart: number;
  /** Lines of the new file produced by this hunk. */
  newCount: number;
  /** Raw body lines including the leading marker (` ` / `-` / `+`). */
  bodyLines: string[];
}

export interface ParsedPatch {
  /** Whatever path appeared on the `--- a/…` line, if present. The
   *  caller should still pass an explicit `path` argument to the tool;
   *  this is informational only. */
  oldPath?: string;
  /** Whatever path appeared on the `+++ b/…` line, if present. */
  newPath?: string;
  hunks: PatchHunk[];
}

/**
 * Parse a unified-diff string into hunks. Returns null when the input
 * doesn't look like a unified diff (no `@@` header found).
 */
export function parseUnifiedPatch(patch: string): ParsedPatch | null {
  const lines = patch.split('\n');
  let i = 0;
  let oldPath: string | undefined;
  let newPath: string | undefined;
  // Optional file headers — strip them off if present so we land on
  // the first @@ hunk header.
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('--- ')) {
      oldPath = line.slice(4).trim();
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      newPath = line.slice(4).trim();
      i++;
      continue;
    }
    if (line.startsWith('diff ') || line.startsWith('index ')) {
      i++;
      continue;
    }
    break;
  }
  const hunks: PatchHunk[] = [];
  while (i < lines.length) {
    const header = lines[i];
    const headerMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!headerMatch) {
      // Skip blank lines or trailing junk between hunks; bail if we
      // hit something that isn't a header AND isn't whitespace.
      if (header.trim() === '') { i++; continue; }
      if (hunks.length === 0) {return null;}
      break;
    }
    const oldStart = parseInt(headerMatch[1], 10);
    const oldCount = headerMatch[2] !== undefined ? parseInt(headerMatch[2], 10) : 1;
    const newStart = parseInt(headerMatch[3], 10);
    const newCount = headerMatch[4] !== undefined ? parseInt(headerMatch[4], 10) : 1;
    i++;
    const bodyLines: string[] = [];
    let oldSeen = 0;
    let newSeen = 0;
    while (i < lines.length && (oldSeen < oldCount || newSeen < newCount)) {
      const line = lines[i];
      if (line.startsWith('@@')) {break;}
      if (line.startsWith(' ')) { oldSeen++; newSeen++; }
      else if (line.startsWith('-')) { oldSeen++; }
      else if (line.startsWith('+')) { newSeen++; }
      else if (line.startsWith('\\')) { /* "\ No newline at end of file" — ignore */ }
      else if (line === '') {
        // Empty line in the body — treat as a blank context line.
        // Some diff tools omit the leading space on empty context.
        oldSeen++;
        newSeen++;
        bodyLines.push(' ');
        i++;
        continue;
      } else {
        // Anything else is junk; bail on this hunk.
        break;
      }
      bodyLines.push(line);
      i++;
    }
    hunks.push({ oldStart, oldCount, newStart, newCount, bodyLines });
  }
  if (hunks.length === 0) {return null;}
  return { oldPath, newPath, hunks };
}

export interface ApplyResult {
  ok: true;
  next: string;
}

export interface ApplyError {
  ok: false;
  hunkIndex: number;
  reason: string;
  /** Lines of the file near where the hunk was expected — included in
   *  the error so the model can see what's actually there and adjust
   *  the patch on retry. */
  contextSnippet?: string;
}

/**
 * Apply a parsed patch to a string. Tolerates small line-number drift
 * (the @@ header says "line 42" but the actual matching context is at
 * line 39) by searching forward + backward up to FUZZ lines.
 *
 * Lines in the source preserve their original line endings via the
 * caller (we operate on `\n`-split arrays and re-join at the end).
 * Files with `\r\n` should be normalised by the caller before parsing
 * the patch — keeping that detail outside this module avoids having
 * to thread a "preserve CRLF" flag through every code path.
 */
export function applyParsedPatch(source: string, patch: ParsedPatch): ApplyResult | ApplyError {
  const FUZZ = 5;
  const lines = source.split('\n');
  // Track the running line offset induced by prior hunks so the next
  // hunk can search relative to its position in the modified file.
  let runningDelta = 0;
  for (let h = 0; h < patch.hunks.length; h++) {
    const hunk = patch.hunks[h];
    // Build the "original" context (every body line that's a delete
    // or context, in order) so we can find the actual position of the
    // hunk in `lines` even when line numbers have drifted.
    const originalContext: string[] = [];
    const newBody: string[] = [];
    for (const raw of hunk.bodyLines) {
      const marker = raw[0] ?? ' ';
      const body = raw.slice(1);
      if (marker === ' ') { originalContext.push(body); newBody.push(body); }
      else if (marker === '-') { originalContext.push(body); }
      else if (marker === '+') { newBody.push(body); }
    }
    // Find the original-context block in `lines`. Start by checking
    // the header-claimed position (adjusted for prior hunk deltas);
    // if that doesn't match, scan a small window forward and back.
    const expected = (hunk.oldStart - 1) + runningDelta;
    const matchIndex = findContextIndex(lines, originalContext, expected, FUZZ);
    if (matchIndex < 0) {
      const sample = lines.slice(Math.max(0, expected - 2), expected + 5).join('\n');
      return {
        ok: false,
        hunkIndex: h,
        reason: `hunk ${h + 1} did not apply at or near line ${hunk.oldStart}: the - / context lines don't match the file. Re-read the file with read_file and regenerate the patch with current line content.`,
        contextSnippet: sample
      };
    }
    // Splice in the new body in place of the original-context block.
    lines.splice(matchIndex, originalContext.length, ...newBody);
    runningDelta += newBody.length - originalContext.length;
  }
  return { ok: true, next: lines.join('\n') };
}

/**
 * Locate the run of `context` inside `lines`, preferring a position
 * close to `expected`. Returns -1 when no match within `fuzz` lines on
 * either side.
 */
function findContextIndex(lines: string[], context: string[], expected: number, fuzz: number): number {
  if (context.length === 0) {
    // Pure-insert hunk (no - or context lines) — use the expected
    // position directly. Clamp to bounds.
    return Math.max(0, Math.min(expected, lines.length));
  }
  const matches = (start: number): boolean => {
    if (start < 0 || start + context.length > lines.length) {return false;}
    for (let i = 0; i < context.length; i++) {
      if (lines[start + i] !== context[i]) {return false;}
    }
    return true;
  };
  if (matches(expected)) {return expected;}
  for (let d = 1; d <= fuzz; d++) {
    if (matches(expected - d)) {return expected - d;}
    if (matches(expected + d)) {return expected + d;}
  }
  return -1;
}

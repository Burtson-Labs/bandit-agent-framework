/**
 * @-mention file picker for the CLI REPL.
 *
 * When the user types `@` at the end of their prompt, we take over
 * stdin in raw mode, render a floating list of matching files BELOW
 * the readline prompt (cursor is save/restored via `\x1b[s` / `\x1b[u`),
 * and handle arrow-key navigation + Enter/Tab selection.
 *
 * Why not readline's `completer`: Tab-completion fires only on Tab,
 * doesn't show choices as you type, and can't do arrow-key nav.
 * Users of Cursor / Claude Code / Cline expect a live picker. This
 * module provides that UX while coexisting with the main readline
 * interface — we pause readline for the duration of the picker so
 * we don't fight it for bytes.
 *
 * Keys:
 *   - type/backspace → filter suggestions
 *   - ↑ / ↓         → move selection
 *   - Tab / Enter   → commit selection (replace "@query" with "@path")
 *   - Esc           → dismiss (keep the user's typed "@query" text as-is)
 *   - any other     → commit current selection AND forward the key to
 *                     readline so normal typing resumes seamlessly
 */
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { c } from './ansi';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo',
  'coverage', 'target', '__pycache__', '.venv', 'venv', '.bandit',
  'obj', 'bin', '.gradle', '.vs', '.idea'
]);
const MAX_WALK = 5000;
const MAX_RESULTS = 8;

interface Match {
  path: string;
  isDir: boolean;
}

/**
 * Walk the workspace synchronously and return up to `MAX_RESULTS`
 * entries matching the query (case-insensitive substring + prefix
 * boost + shorter-path preference). Includes both files and dirs —
 * dirs render with a trailing `/` so the user can tell them apart.
 */
function findMatches(cwd: string, query: string): Match[] {
  const lowerQuery = query.toLowerCase();
  const results: Match[] = [];
  let walked = 0;
  const walk = (dir: string, rel: string): void => {
    if (walked >= MAX_WALK) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (walked >= MAX_WALK) return;
      walked++;
      if (entry.name.startsWith('.')) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const lower = childRel.toLowerCase();
      if (!lowerQuery || lower.includes(lowerQuery)) {
        if (entry.isDirectory()) {
          results.push({ path: `${childRel}/`, isDir: true });
        } else if (entry.isFile()) {
          results.push({ path: childRel, isDir: false });
        }
      }
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), childRel);
      }
    }
  };
  walk(cwd, '');
  // Sort: prefix match > shorter path > alphabetical.
  results.sort((a, b) => {
    const aStarts = a.path.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
    const bStarts = b.path.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  });
  return results.slice(0, MAX_RESULTS);
}

interface PickerResult {
  /** Text to insert into readline's line buffer, replacing the `@query`
   *  portion. Empty if the user dismissed without picking. */
  insertion: string;
  /** A character the user typed that should still land in the input
   *  after the insertion. E.g. if they picked a match by typing space,
   *  the space should follow the inserted path. Empty if nothing to
   *  forward. */
  trailingChar: string;
  /** True if the user dismissed with Esc (caller keeps the raw @query
   *  text instead of replacing it). */
  dismissed: boolean;
}

/**
 * Open the picker. The REPL is responsible for calling this AFTER the
 * user has typed `@` and readline has paused. `initialQuery` is the
 * text already typed after the @ (usually empty when triggered on `@`
 * keypress, but callers can pre-populate if desired).
 *
 * Caller promise resolves once the user has picked / dismissed. The
 * caller then resumes readline and applies the insertion to the line
 * buffer via `rl.write()`.
 */
export function openFilePicker(
  cwd: string,
  initialQuery: string
): Promise<PickerResult> {
  return new Promise<PickerResult>((resolve) => {
    if (!process.stdout.isTTY) {
      // No TTY — can't render a picker. Resolve immediately as dismissed
      // so the caller falls back to plain readline typing.
      resolve({ insertion: '', trailingChar: '', dismissed: true });
      return;
    }

    let query = initialQuery;
    let selected = 0;
    let lastDrawnLines = 0;
    let matches: Match[] = findMatches(cwd, query);

    const wasRaw = process.stdin.isRaw === true;
    process.stdin.setRawMode?.(true);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();
    // Hide cursor while the picker is open — avoids flicker as we
    // redraw. Restored in cleanup().
    process.stdout.write('\x1b[?25l');

    // Erase whatever we drew on the previous frame. We don't use
    // \x1b[s/\x1b[u (save/restore cursor) because those anchor to
    // absolute viewport rows — once the picker grows tall enough to
    // scroll the terminal, the saved anchor drifts and each redraw
    // leaves a fresh ghost copy below the real one (observed bug:
    // arrow-key navigation stacked N copies of the picker, one per
    // keystroke). Instead we track the exact line count we wrote and
    // walk the cursor back up that many lines with explicit CSI
    // sequences, erasing each.
    const eraseLastRender = () => {
      if (lastDrawnLines <= 0) return;
      // \r  → col 0  ·  \x1b[2K  → erase current line
      // \x1b[A → move cursor up one line
      // First \r + erase handles the current line the cursor is on;
      // then loop up and erase each previously-drawn line.
      process.stdout.write('\r\x1b[2K');
      for (let i = 1; i < lastDrawnLines; i++) {
        process.stdout.write('\x1b[A\x1b[2K');
      }
      lastDrawnLines = 0;
    };

    const render = () => {
      eraseLastRender();
      // Leading newline moves us off the prompt line so the prompt
      // itself stays intact. That newline counts as one drawn line.
      process.stdout.write('\n');
      let lineCount = 1;
      if (matches.length === 0) {
        process.stdout.write(c.dim('  (no matches)'));
        lineCount += 1;
      } else {
        const lines: string[] = [];
        for (let i = 0; i < matches.length; i++) {
          const m = matches[i];
          const icon = m.isDir ? c.dim('▸ ') : '  ';
          const label = m.isDir ? c.cyan(m.path) : m.path;
          if (i === selected) {
            lines.push(`${c.accent('▸')} ${icon}${c.bold(label)}`);
          } else {
            lines.push(`  ${icon}${c.dim(label)}`);
          }
        }
        lines.push(c.dim(`  ↑↓ · tab/enter to pick · esc to cancel · @${query || ''}_`));
        process.stdout.write(lines.join('\n'));
        lineCount += lines.length;
      }
      lastDrawnLines = lineCount;
    };

    const cleanup = () => {
      // Clear the picker region fully; the prompt line is the one
      // above whatever the cursor currently sits on, so walking up
      // `lastDrawnLines` rows and erasing them returns the terminal
      // to its pre-picker state without disturbing the prompt.
      eraseLastRender();
      process.stdout.write('\x1b[?25h');              // show cursor
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode?.(wasRaw);
    };

    const onKey = (str: string | undefined, key: readline.Key | undefined) => {
      if (!key) return;
      // Esc → dismiss. Caller keeps the user's typed @query text.
      if (key.name === 'escape') {
        cleanup();
        resolve({ insertion: '', trailingChar: '', dismissed: true });
        return;
      }
      // Up / Down → navigate selection.
      if (key.name === 'up') {
        if (matches.length > 0) {
          selected = (selected - 1 + matches.length) % matches.length;
          render();
        }
        return;
      }
      if (key.name === 'down') {
        if (matches.length > 0) {
          selected = (selected + 1) % matches.length;
          render();
        }
        return;
      }
      // Tab / Enter → commit current selection.
      if (key.name === 'tab' || key.name === 'return') {
        if (matches.length > 0) {
          cleanup();
          resolve({
            insertion: `@${matches[selected].path}`,
            trailingChar: '',
            dismissed: false
          });
          return;
        }
        // No matches; treat Tab/Enter as dismiss.
        cleanup();
        resolve({ insertion: '', trailingChar: '', dismissed: true });
        return;
      }
      // Backspace → shrink query. If query is empty, pop the '@' and
      // dismiss (the user is erasing the mention).
      if (key.name === 'backspace') {
        if (query.length === 0) {
          cleanup();
          // Return an insertion that backspaces the '@' from readline's
          // buffer by being empty AND signaling dismissal. Caller just
          // treats as dismissed — readline already processed the
          // backspace before the picker saw the prior keystroke.
          resolve({ insertion: '', trailingChar: '\b', dismissed: true });
          return;
        }
        query = query.slice(0, -1);
        matches = findMatches(cwd, query);
        selected = 0;
        render();
        return;
      }
      // Space or any other printable char that terminates a typical
      // file path → commit current match AND forward the character
      // back into readline so the next typing resumes naturally.
      if (str && str.length === 1 && /[\s,;]/.test(str)) {
        if (matches.length > 0) {
          cleanup();
          resolve({
            insertion: `@${matches[selected].path}`,
            trailingChar: str,
            dismissed: false
          });
          return;
        }
        cleanup();
        resolve({ insertion: '', trailingChar: str, dismissed: true });
        return;
      }
      // Ctrl+C → treat as dismiss + re-emit SIGINT so the outer REPL
      // handles it (cancel current prompt).
      if (key.ctrl && key.name === 'c') {
        cleanup();
        resolve({ insertion: '', trailingChar: '', dismissed: true });
        process.kill(process.pid, 'SIGINT');
        return;
      }
      // Printable character → extend query and re-filter.
      if (str && str.length === 1 && !key.ctrl && !key.meta) {
        query += str;
        matches = findMatches(cwd, query);
        selected = 0;
        render();
        return;
      }
    };

    process.stdin.on('keypress', onKey);
    render();
  });
}

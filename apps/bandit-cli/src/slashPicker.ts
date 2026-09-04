/**
 * Slash-command picker for the CLI REPL.
 *
 * When the user types `/` as the first character of an empty prompt, we take
 * over stdin in raw mode and render a live, filterable list of slash commands
 * BELOW the prompt — arrow-key nav, Enter/Tab to fill, description shown for
 * each. This is the discoverability layer people expect from Cursor / Claude
 * Code: "what can I type after /?" answered as you type, instead of a bare
 * text field.
 *
 * Mirrors filePicker.ts (@-mention) exactly — same raw-mode + redraw-by-line
 * bookkeeping — so it coexists with the main readline interface (we pause
 * readline for the picker's lifetime rather than fighting it for bytes) and
 * doesn't touch the fragile ANSI input frame.
 *
 * Keys:
 *   - type / backspace → filter (backspace past empty pops the `/` and dismisses)
 *   - ↑ / ↓            → move selection
 *   - Tab / Enter / Space → fill `/name ` into the prompt (space also commits)
 *   - Esc              → dismiss, keeping whatever `/query` the user typed
 */
import * as readline from 'node:readline';
import { c } from './ansi';

const MAX_RESULTS = 8;

export interface SlashPickerCommand {
  name: string;
  description: string;
}

export interface SlashPickerResult {
  /** Full replacement for the `/` trigger — the caller strips the leading `/`
   *  from readline's buffer and writes this. On commit it's `/name `; on
   *  dismiss it's `/` + whatever the user had typed (so nothing is lost);
   *  empty when the user backspaced the `/` away. */
  insertion: string;
  /** A trailing char to forward into readline after the insertion. */
  trailingChar: string;
  /** True when the user dismissed rather than picked a command. */
  dismissed: boolean;
}

/**
 * Filter + rank commands for `query` (the text after `/`). Case-insensitive
 * substring match, ranked: name-prefix hit first, then shorter name, then
 * alphabetical. Pure + exported so the ranking is unit-tested without a TTY.
 */
export function matchSlashCommands(commands: SlashPickerCommand[], query: string): SlashPickerCommand[] {
  const q = query.toLowerCase();
  const hits = commands.filter((cmd) => !q || cmd.name.toLowerCase().includes(q));
  hits.sort((a, b) => {
    const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name.localeCompare(b.name);
  });
  return hits.slice(0, MAX_RESULTS);
}

/**
 * Open the picker. The REPL calls this AFTER the user typed `/` on an empty
 * line and readline has paused. Resolves once the user picks or dismisses; the
 * caller strips the `/` from readline's buffer and writes `result.insertion`.
 */
export function openSlashPicker(
  commands: SlashPickerCommand[],
  initialQuery: string
): Promise<SlashPickerResult> {
  return new Promise<SlashPickerResult>((resolve) => {
    if (!process.stdout.isTTY) {
      resolve({ insertion: `/${initialQuery}`, trailingChar: '', dismissed: true });
      return;
    }

    let query = initialQuery;
    let selected = 0;
    let lastDrawnLines = 0;
    let matches = matchSlashCommands(commands, query);

    const wasRaw = process.stdin.isRaw === true;
    process.stdin.setRawMode?.(true);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();
    process.stdout.write('\x1b[?25l'); // hide cursor while the picker redraws

    // Erase the previous frame by walking the cursor up the exact line count
    // we wrote (same approach as filePicker — save/restore cursor drifts once
    // the picker scrolls the viewport).
    const eraseLastRender = () => {
      if (lastDrawnLines <= 0) return;
      process.stdout.write('\r\x1b[2K');
      for (let i = 1; i < lastDrawnLines; i++) {
        process.stdout.write('\x1b[A\x1b[2K');
      }
      lastDrawnLines = 0;
    };

    const render = () => {
      eraseLastRender();
      process.stdout.write('\n'); // move off the prompt line; counts as one line
      let lineCount = 1;
      const cols = process.stdout.columns || 80;
      if (matches.length === 0) {
        process.stdout.write(c.dim(`  (no command matches /${query})`));
        lineCount += 1;
      } else {
        const lines: string[] = [];
        // Width budget for the description column: total minus the name column.
        const nameWidth = Math.min(14, Math.max(...matches.map((m) => m.name.length)) + 1);
        for (let i = 0; i < matches.length; i++) {
          const m = matches[i];
          const name = `/${m.name}`.padEnd(nameWidth + 1);
          const descBudget = Math.max(10, cols - nameWidth - 8);
          const desc = m.description.length > descBudget ? m.description.slice(0, descBudget - 1) + '…' : m.description;
          if (i === selected) {
            lines.push(`${c.accent('▸')} ${c.bold(name)}${c.dim(desc)}`);
          } else {
            lines.push(`  ${c.cyan(name)}${c.dim(desc)}`);
          }
        }
        lines.push(c.dim(`  ↑↓ · tab/enter to pick · esc to cancel · /${query || ''}_`));
        process.stdout.write(lines.join('\n'));
        lineCount += lines.length;
      }
      lastDrawnLines = lineCount;
    };

    const cleanup = () => {
      eraseLastRender();
      process.stdout.write('\x1b[?25h'); // show cursor
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode?.(wasRaw);
    };

    const commit = (): SlashPickerResult => ({
      insertion: `/${matches[selected].name} `,
      trailingChar: '',
      dismissed: false
    });

    const onKey = (str: string | undefined, key: readline.Key | undefined) => {
      if (!key) return;
      if (key.name === 'escape') {
        cleanup();
        // Keep whatever the user typed after `/` so nothing is lost.
        resolve({ insertion: `/${query}`, trailingChar: '', dismissed: true });
        return;
      }
      if (key.name === 'up') {
        if (matches.length > 0) { selected = (selected - 1 + matches.length) % matches.length; render(); }
        return;
      }
      if (key.name === 'down') {
        if (matches.length > 0) { selected = (selected + 1) % matches.length; render(); }
        return;
      }
      // Tab / Enter / Space → fill the selected command (space also commits).
      if (key.name === 'tab' || key.name === 'return' || (str === ' ')) {
        if (matches.length > 0) { cleanup(); resolve(commit()); return; }
        // No match — keep the raw text so they can submit it (REPL will report
        // "unknown command") or keep editing.
        cleanup();
        resolve({ insertion: `/${query}${str === ' ' ? ' ' : ''}`, trailingChar: '', dismissed: true });
        return;
      }
      if (key.name === 'backspace') {
        if (query.length === 0) {
          // Backspaced the `/` itself — remove it entirely.
          cleanup();
          resolve({ insertion: '', trailingChar: '', dismissed: true });
          return;
        }
        query = query.slice(0, -1);
        matches = matchSlashCommands(commands, query);
        selected = 0;
        render();
        return;
      }
      if (key.ctrl && key.name === 'c') {
        cleanup();
        resolve({ insertion: '', trailingChar: '', dismissed: true });
        process.kill(process.pid, 'SIGINT');
        return;
      }
      // Printable → extend query and re-filter.
      if (str && str.length === 1 && !key.ctrl && !key.meta) {
        query += str;
        matches = matchSlashCommands(commands, query);
        selected = 0;
        render();
        return;
      }
    };

    process.stdin.on('keypress', onKey);
    render();
  });
}

/**
 * Interactive session picker for `bandit --resume` with no id.
 *
 * Resuming used to require the exact session id — you had to run `/session
 * list`, copy a timestamp-slug, and pass it back. This shows the recent
 * sessions with a recognizable preview and lets the user arrow-select, so
 * "pick up where I left off" is one keystroke instead of a scavenger hunt.
 *
 * The formatting helpers are pure and exported for tests; the interactive part
 * mirrors the theme picker's raw-mode arrow loop.
 */
import * as readline from 'readline';
import { c, glyph } from './ansi';
import type { SessionSummary } from './session';

/**
 * Human-readable age from a last-modified time. Pure, so it's testable with a
 * fixed `now` instead of the wall clock.
 */
export function relativeTime(mtimeMs: number, nowMs: number): string {
  if (!mtimeMs) {return 'unknown';}
  const secs = Math.max(0, Math.round((nowMs - mtimeMs) / 1000));
  if (secs < 60) {return 'just now';}
  const mins = Math.round(secs / 60);
  if (mins < 60) {return `${mins}m ago`;}
  const hours = Math.round(mins / 60);
  if (hours < 24) {return `${hours}h ago`;}
  const days = Math.round(hours / 24);
  if (days < 30) {return `${days}d ago`;}
  const months = Math.round(days / 30);
  if (months < 12) {return `${months}mo ago`;}
  return `${Math.round(months / 12)}y ago`;
}

/**
 * Render one session row into fixed columns: age, turn count, preview. Pure and
 * width-aware so the interactive loop stays about key handling only.
 */
export function formatSessionRow(s: SessionSummary, nowMs: number, width: number): string {
  const age = relativeTime(s.mtime, nowMs).padEnd(9);
  // messageCount counts stored lines (user + assistant); halving approximates
  // exchanges, which is the number a user actually reasons about.
  const turns = Math.max(1, Math.round(s.messageCount / 2));
  const meta = `${age} ${String(turns).padStart(3)} turn${turns === 1 ? ' ' : 's'}`;
  const previewWidth = Math.max(12, width - meta.length - 6);
  const preview = s.preview || '(no prompt yet)';
  const clipped = preview.length > previewWidth ? preview.slice(0, previewWidth - 1) + '…' : preview;
  return `${meta}  ${clipped}`;
}

export interface SessionPickerDeps {
  sessions: SessionSummary[];
  now: number;
  /** Injected for tests; defaults to process.stdout. */
  out?: { write: (s: string) => void; columns?: number };
}

/**
 * Show the picker and resolve to the chosen session id, or null on cancel
 * (Esc / Ctrl+C) or when there are no sessions. Falls back to a plain numbered
 * list when stdin isn't a TTY.
 */
export async function pickSession(deps: SessionPickerDeps): Promise<string | null> {
  const { sessions, now } = deps;
  const out = deps.out ?? { write: (s: string) => process.stdout.write(s), columns: process.stdout.columns };
  if (sessions.length === 0) {
    out.write(c.dim('  No previous sessions to resume.\n'));
    return null;
  }
  const width = out.columns || 80;

  if (!process.stdin.isTTY) {
    // Non-interactive: print the list so a scripted caller can see the ids, but
    // don't guess — resuming a specific session needs an explicit id.
    out.write(c.dim('Recent sessions (pass one to --resume):\n'));
    sessions.forEach((s) => out.write(`  ${s.id}  ${formatSessionRow(s, now, width)}\n`));
    return null;
  }

  return new Promise<string | null>((resolve) => {
    let selected = 0;
    let firstDraw = true;
    const rows = sessions.length;

    const render = (): void => {
      if (!firstDraw) {
        // Move back up over the previously-drawn rows + header, clear down.
        out.write(`\r\x1b[${rows + 1}A\x1b[0J`);
      }
      firstDraw = false;
      out.write(c.bold('  Resume a session') + c.dim('  ↑↓ choose · enter resume · esc cancel') + '\n');
      sessions.forEach((s, i) => {
        const row = formatSessionRow(s, now, width - 4);
        out.write(i === selected ? c.accent('  ▸ ') + c.bold(row) + '\n' : '    ' + c.dim(row) + '\n');
      });
    };

    const wasRaw = process.stdin.isRaw === true;
    process.stdin.setRawMode?.(true);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();
    render();

    const cleanup = (): void => {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode?.(wasRaw);
      out.write('\n');
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean } | undefined): void => {
      if (!key) {return;}
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        cleanup();
        resolve(null);
        return;
      }
      if (key.name === 'up' || key.name === 'k') {
        selected = (selected - 1 + rows) % rows;
        render();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        selected = (selected + 1) % rows;
        render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        out.write(c.green(`  ${glyph.check} resuming ${sessions[selected].id}\n`));
        resolve(sessions[selected].id);
      }
    };

    process.stdin.on('keypress', onKey);
  });
}

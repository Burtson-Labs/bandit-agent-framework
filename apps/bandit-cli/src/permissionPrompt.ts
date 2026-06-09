/**
 * Interactive permission picker for the CLI.
 *
 * Replaces the legacy "type 1/2/3/4 and hit enter" prompt with an
 * arrow-key menu that highlights the currently-selected option and
 * lets the user press Tab on `deny` to add follow-up instructions.
 * Those follow-up instructions ride back to the model as part of the
 * denial reason so the agent can revise its approach instead of just
 * seeing "blocked by user."
 *
 * Falls back cleanly to the original digit-entry flow when stdin
 * isn't a TTY (CI logs, piped input, `bandit < script.txt`).
 */

import * as readline from 'readline';
import { c } from './ansi';

export type PermissionChoice = 'once' | 'session' | 'always' | 'deny';

export interface PermissionPromptResult {
  choice: PermissionChoice;
  /** Populated when the user denied AND provided a follow-up note —
   * either via Tab on `deny` OR by picking the explicit `deny + note`
   * option (which opens the follow-up prompt directly). Empty string
   * means the prompt was opened but the user hit Enter without typing
   * — treat that as plain deny. */
  notes?: string;
}

interface MenuOption {
  key: PermissionChoice;
  label: string;
  digit: string;
  /** When true, picking this option (Enter or digit) immediately opens
   * the follow-up prompt instead of resolving as a bare deny. */
  promptForNotes?: boolean;
}

// added explicit "deny + note" option. The Tab-on-deny
// shortcut existed but was buried (the hint that advertised it only
// rendered when deny was already highlighted, and the running spinner
// often overlapped it). With a 5th item the steer-the-agent path is
// visible at first glance.
const OPTIONS: readonly MenuOption[] = [
  { key: 'once',    label: 'allow once',        digit: '1' },
  { key: 'session', label: 'allow session',     digit: '2' },
  { key: 'always',  label: 'always for target', digit: '3' },
  { key: 'deny',    label: 'deny',              digit: '4' },
  { key: 'deny',    label: 'deny + note',       digit: '5', promptForNotes: true }
] as const;

export interface PermissionPromptDeps {
  /**
   * Existing readline interface the REPL uses for normal prompts. We
   * pause it while the picker owns stdin (raw mode) and resume after.
   * Omit in one-shot mode — we manage stdin directly.
   */
  rl?: readline.Interface;
  /**
   * Reads a single line via whatever mechanism the caller normally
   * uses. Used for:
   * 1. Non-TTY fallback (the whole prompt reduces to `read a digit`).
   * 2. The Tab-on-deny follow-up prompt (we exit raw mode and read
   * a regular line so the user can type, edit, paste, etc).
   *
   * `opts.bypassQueue` (added 2026-05-26): when set, the reader must
   * wait for FRESH user input — do not consume any mid-turn-queued
   * messages. Used for the deny+follow-up read so a stale queued
   * "fix the test" doesn't become the denial reason.
   */
  readLine?: (opts?: { bypassQueue?: boolean }) => Promise<string>;
}

/**
 * Entry point. Renders the picker and resolves when the user confirms.
 * Rejects on Ctrl+C so callers can treat that as "treat like deny"
 * (current behaviour on the legacy prompt is also to deny when input
 * is anything other than 1/2/3).
 */
export async function promptPermission(deps: PermissionPromptDeps = {}): Promise<PermissionPromptResult> {
  // Non-TTY → fall back to the digit-entry flow we used before. Works
  // in CI, piped input, `bandit < file`, etc. without requiring any
  // terminal capabilities.
  if (!process.stdin.isTTY) {
    return promptLegacy(deps.readLine);
  }
  return promptInteractive(deps);
}

async function promptLegacy(readLine?: () => Promise<string>): Promise<PermissionPromptResult> {
  process.stdout.write(c.accent('│ ') + c.dim('1) allow once   2) allow session   3) always for target   4) deny   5) deny + note') + '\n');
  process.stdout.write(c.accent('╰── choice [1/2/3/4/5]: '));
  if (!readLine) {
    // No reader plumbed — default to deny rather than hanging forever.
    process.stdout.write('\n');
    return { choice: 'deny' };
  }
  const raw = (await readLine()).trim();
  if (raw === '2') return { choice: 'session' };
  if (raw === '3') return { choice: 'always' };
  if (raw === '4') return { choice: 'deny' };
  if (raw === '5') {
    // deny + note — prompt for the follow-up message.
    process.stdout.write(c.accent('╰── ') + c.red('deny + follow-up: '));
    const notes = (await readLine()).trim();
    return { choice: 'deny', notes: notes || undefined };
  }
  // '1' or anything unknown → safe default is `once` (matches legacy
  // behaviour which required explicit 2/3/4 to change meaning).
  return { choice: 'once' };
}

async function promptInteractive(deps: PermissionPromptDeps): Promise<PermissionPromptResult> {
  const { rl, readLine } = deps;

  // Snapshot whether rl was already paused BEFORE we touched it. With
  // the ink input layer, permission picks during a turn run with rl
  // already paused (cli.ts unmounts the live frame for the turn).
  // Calling rl.resume() in the picker's cleanup would then mount a
  // fresh ink instance mid-turn — which fights the agent's ongoing
  // stdout writes (spinner, model tokens, tool banners) and the
  // process crashed.
  const wasPaused = (rl as { isPaused?: () => boolean } | undefined)?.isPaused?.() ?? false;
  if (!wasPaused) {
    // Pause the REPL's readline so we're not fighting it for bytes.
    // It stays open; we just stop receiving 'line' events from it
    // for the duration of the picker.
    rl?.pause();
  }
  // Only re-resume if WE paused it. If it was already paused (ink
  // turn-in-progress), leave it paused — cli.ts's finally block
  // will resume after the turn completes.
  const restoreRl = (): void => {
    if (!wasPaused) rl?.resume();
  };

  const wasRaw = process.stdin.isRaw === true;
  process.stdin.setRawMode?.(true);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.resume();

  // Default highlight on `once` — matches muscle memory from the old
  // prompt where the common case was typing `1<enter>` to acknowledge.
  let selected = 0;
  let firstDraw = true;

  const MENU_LINES = 2; // the menu row + the hint row

  const render = () => {
    if (!firstDraw) {
      // Cursor is at end of the hint line (no trailing newline), which
      // is already the LAST of the MENU_LINES rendered rows — so to
      // reach the FIRST row we go up MENU_LINES - 1, not MENU_LINES.
      // The off-by-one we had before caused every arrow-key redraw to
      // wipe the line ABOVE the menu (last line of the diff card).
      // `\x1b[0J` erases cursor-to-end-of-screen.
      process.stdout.write('\r\x1b[' + (MENU_LINES - 1) + 'A\x1b[0J');
    }
    firstDraw = false;
    // Show the digit on EVERY option (1 allow once · 2 allow session ·
    // 3 always · 4 deny · 5 deny + note) so the 1–5 mapping is unambiguous
    // and nothing looks skipped — the old hint only called out 2/3/5,
    // which made `4 deny` read like a gap.
    const labels = OPTIONS.map((o, i) => {
      const text = `${o.digit} ${o.label}`;
      if (i === selected) {
        return c.accent('▸ ') + c.bold(text);
      }
      return '  ' + c.dim(text);
    });
    process.stdout.write(c.accent('│ ') + labels.join('    ') + '\n');
    const hint = '↑↓←→ or 1–5 to choose · enter confirms · esc cancels';
    process.stdout.write(c.accent('╰── ') + c.dim(hint));
  };

  render();

  return new Promise<PermissionPromptResult>((resolve, reject) => {
    // Collect the cleanup into a single function so Ctrl+C, resolve,
    // and the Tab branch all restore the terminal identically. Without
    // this the terminal can end up in raw mode if an error path skips
    // a reset, which makes the whole shell unusable until the user
    // types `stty sane`.
    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode?.(wasRaw);
      // Advance past the hint line so the caller's next write starts
      // on a fresh row instead of overwriting our menu.
      process.stdout.write('\n');
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
      if (!key) return;

      if (key.ctrl && key.name === 'c') {
        cleanup();
        restoreRl();
        reject(new Error('cancelled'));
        return;
      }

      if (key.name === 'up' || key.name === 'left') {
        selected = (selected - 1 + OPTIONS.length) % OPTIONS.length;
        render();
        return;
      }
      if (key.name === 'down' || key.name === 'right') {
        selected = (selected + 1) % OPTIONS.length;
        render();
        return;
      }
      // Direct digit jump — preserves muscle memory. The user can still
      // arrow-adjust before pressing Enter; we don't auto-confirm on
      // digit because that would be jarring for muscle memory of
      // `4<enter>` expecting a two-step confirmation.
      // accept 1-5 now that the deny+note option lives at 5.
      if (key.name && /^[1-5]$/.test(key.name)) {
        selected = parseInt(key.name, 10) - 1;
        render();
        return;
      }

      // Single helper to open the follow-up prompt — used by both
      // Enter-on-deny+note (the new explicit option) and Tab-on-deny
      // (the original shortcut). Keeps the two paths from drifting.
      const openFollowUp = () => {
        cleanup();
        // In the turn-view, the note is typed in ink's composer box (which
        // renders on its own lines after resume), so the prompt label must
        // END WITH A NEWLINE — otherwise the composer's top border lands on
        // the same line as "deny + follow-up:" and reads as a janky rule.
        // The readline path keeps it inline (no newline) so the typed reply
        // follows the label on the same row.
        const inTurnView = (rl as unknown as { isTurnMode?: () => boolean } | undefined)?.isTurnMode?.() === true;
        process.stdout.write(c.accent('╰── ') + c.red('deny + follow-up:') + (inTurnView ? '\n' : ' '));
        // If ink was paused for the turn, temporarily resume so the
        // user can SEE what they're typing for the note, then re-pause
        // once we've captured it. Without the resume, readLine() waits
        // on a 'line' event from a frame that no longer exists.
        if (wasPaused) rl?.resume(); else restoreRl();
        const gather = readLine ?? ((_opts?: { bypassQueue?: boolean }) => new Promise<string>((r) => {
          // Fallback: throwaway readline, one-shot scenarios only.
          // _opts is unused here — one-shot mode has no queue to bypass.
          const temp = readline.createInterface({ input: process.stdin, output: process.stdout });
          temp.once('line', (line) => { temp.close(); r(line); });
        }));
        // bypassQueue:true so a stale mid-turn message in the REPL
        // lineQueue doesn't get consumed as the denial reason. See
        // GetLineFn docs in cli.ts for the captured failure trace.
        gather({ bypassQueue: true }).then((notes) => {
          if (wasPaused) rl?.pause();
          resolve({ choice: 'deny', notes: notes.trim() || undefined });
        }).catch((err) => {
          if (wasPaused) rl?.pause();
          reject(err);
        });
      };

      if (key.name === 'return' || key.name === 'enter') {
        // when the selected option has promptForNotes, Enter
        // opens the follow-up prompt directly (no Tab needed). That's
        // what makes the new "deny + note" 5th item useful — picking it
        // gives the same UX as the older Tab-on-deny path without
        // requiring the user to know about the Tab shortcut.
        if (OPTIONS[selected].promptForNotes) {
          openFollowUp();
          return;
        }
        cleanup();
        restoreRl();
        resolve({ choice: OPTIONS[selected].key });
        return;
      }

      if (key.name === 'tab' && OPTIONS[selected].key === 'deny') {
        openFollowUp();
        return;
      }
    };

    process.stdin.on('keypress', onKey);
  });
}

/**
 * Format the denial reason passed back to the model's tool-result
 * stream so the LLM reads the user's follow-up as actionable guidance
 * rather than a generic block. Kept in this module so the CLI and
 * extension agree on the exact string — callers should use this
 * helper rather than hand-rolling the format.
 */
export function formatDenialReason(result: PermissionPromptResult, toolName: string, primary: string): string {
  if (result.choice !== 'deny') {
    // Shouldn't be called for non-deny paths; return a generic message
    // defensively so the tool loop never receives undefined.
    return `permission ${result.choice}`;
  }
  const target = primary ? `${toolName} ${primary}` : toolName;
  if (result.notes) {
    return `User denied \`${target}\` and asked you to revise your approach: "${result.notes}". Do not retry this tool call with the same arguments — adjust your plan based on the user's guidance.`;
  }
  return `User denied \`${target}\`. Do not retry this tool call with the same arguments.`;
}

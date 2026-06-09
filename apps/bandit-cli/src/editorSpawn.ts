/**
 * Editor resolver + spawn helper for "edit this file then come back" flows
 * (the `/memory migrate` wizard is the first caller; others will follow).
 *
 * Resolution order — match what a Unix user expects, with sensible Windows
 * defaults and a VS Code preference when we know the user is sitting in
 * an integrated terminal:
 *
 *   1. $VISUAL              — power users explicitly set this; respect it
 *   2. $EDITOR              — standard Unix env var
 *   3. TERM_PROGRAM=vscode  — user is in a VS Code integrated terminal:
 *                             prefer `code --wait <file>` (native IDE tab,
 *                             same window, best UX) on any platform
 *   4. macOS / Linux         → `nano <file>` (ships by default ~everywhere)
 *   5. Windows               → `notepad <file>` (always present)
 *   6. null                  → caller prints a "set $EDITOR" hint and bails
 *
 * The spawn helper is intentionally synchronous-feeling for the caller:
 * pause ink (or readline), force stdin to cooked mode, hand the TTY over
 * to the child with `stdio: 'inherit'`, wait for the child's exit, then
 * restore. This is the same pattern cli.ts's `!bash` shortcut uses; the
 * helper exists so other flows don't have to re-implement it.
 */
import { spawnSync, spawn as spawnAsync } from 'child_process';
import * as path from 'path';

export interface ResolvedEditor {
  /** Display label used in user-facing messages ("$EDITOR (vim)", "code --wait", "nano", "notepad"). */
  label: string;
  /** Argv0 the helper will execute. */
  cmd: string;
  /** Static args BEFORE the file path. e.g. `['--wait']` for VS Code. */
  args: string[];
}

/**
 * Resolve which editor to spawn. Pure function — no spawning, no side
 * effects. The caller decides what to do when this returns null (the
 * `/memory migrate` wizard prints a "set EDITOR=..." message and asks
 * the user to retry; other callers may pick a different fallback).
 */
export function resolveEditor(env: NodeJS.ProcessEnv = process.env): ResolvedEditor | null {
  // $VISUAL wins over $EDITOR — that's the convention (visual = full-
  // screen editor, editor = line-mode fallback). vim users set both,
  // mutt-era users set only EDITOR.
  const visual = (env.VISUAL ?? '').trim();
  if (visual.length > 0) {
    const { cmd, args } = splitEditorEnv(visual);
    return { label: `$VISUAL (${cmd})`, cmd, args };
  }
  const editorEnv = (env.EDITOR ?? '').trim();
  if (editorEnv.length > 0) {
    const { cmd, args } = splitEditorEnv(editorEnv);
    return { label: `$EDITOR (${cmd})`, cmd, args };
  }
  // VS Code integrated terminal — best UX is `code --wait <file>`, opens
  // a real editor tab in the same window. Works on every OS the user
  // could be running VS Code on. `code` is on PATH whenever the user
  // installed VS Code via the installer (Windows) or accepted the
  // "Install code in PATH" prompt (macOS / Linux).
  if (env.TERM_PROGRAM === 'vscode' && commandExists('code', env)) {
    return { label: 'code --wait (VS Code tab)', cmd: 'code', args: ['--wait'] };
  }
  // Platform defaults — nano on Unix, notepad on Windows. Both ship by
  // default on every OS we target so neither is going to fail at the
  // existence check the way `code` could.
  if (process.platform === 'win32') {
    return { label: 'notepad', cmd: 'notepad.exe', args: [] };
  }
  // macOS, Linux, BSDs — nano is the easy modeless editor everyone
  // recognizes. Vim users have $EDITOR set so they never hit this branch.
  if (commandExists('nano', env)) {
    return { label: 'nano', cmd: 'nano', args: [] };
  }
  return null;
}

/**
 * Spawn the resolved editor on a file, returning a Promise that resolves
 * when the child exits (0 = saved, non-zero = error). Caller is
 * responsible for pausing whatever owns stdin (ink, readline) BEFORE
 * calling, and resuming AFTER — this helper doesn't know about the
 * caller's UI layer.
 *
 * `stdio: 'inherit'` hands the TTY fully to the child so cooked-mode
 * editors (notepad, code --wait) and raw-mode editors (nano, vim) both
 * work without the parent re-rendering over them.
 */
export async function spawnEditorOnFile(
  editor: ResolvedEditor,
  filePath: string
): Promise<{ exitCode: number }> {
  const absPath = path.resolve(filePath);
  return new Promise((resolve) => {
    const child = spawnAsync(editor.cmd, [...editor.args, absPath], {
      stdio: 'inherit',
      shell: false
    });
    child.on('exit', (code, signal) => {
      resolve({ exitCode: typeof code === 'number' ? code : signal ? 130 : 1 });
    });
    child.on('error', () => resolve({ exitCode: 1 }));
  });
}

/**
 * Split an EDITOR-style env value into command + args. `EDITOR=vim` →
 * `{cmd:'vim', args:[]}`; `EDITOR="code --wait"` → `{cmd:'code', args:['--wait']}`.
 * Doesn't handle quoted args with spaces — env vars containing those
 * are vanishingly rare in this context (the user picks a single
 * editor binary, not a shell pipeline). If we ever need it, swap in
 * a real shell-style tokenizer.
 */
function splitEditorEnv(value: string): { cmd: string; args: string[] } {
  const parts = value.split(/\s+/).filter(Boolean);
  return { cmd: parts[0] ?? '', args: parts.slice(1) };
}

/**
 * Is `name` on PATH? Uses `which` on Unix and `where` on Windows
 * (synchronous so the resolver stays a simple non-async function — this
 * runs once at the start of an edit step, not in a hot path).
 */
function commandExists(name: string, env: NodeJS.ProcessEnv): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [name], { stdio: 'ignore', env });
  return result.status === 0;
}

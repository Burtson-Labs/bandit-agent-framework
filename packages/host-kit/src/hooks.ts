/**
 * Hooks — shell commands triggered at specific points in the agent lifecycle.
 *
 * Config format (.bandit/settings.json):
 * {
 *   "hooks": {
 *     "PreToolUse":  [{ "match": "write_file", "command": "./scripts/guard.sh {{name}}" }],
 *     "PostToolUse": [{ "match": ".*",         "command": "echo ${name} took ${duration}ms" }],
 *     "Stop":        [{ "command": "./scripts/notify-done.sh" }]
 *   }
 * }
 *
 * - `match` is a regex applied against the tool name. Omit to match all.
 * - `{{placeholder}}` tokens in `command` are substituted at runtime.
 *   PreToolUse / PostToolUse provide: name, primary (first param value), duration (ms, Post only).
 * - A non-zero exit code from a PreToolUse hook aborts the tool call.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SecurityGuardSettings } from './securityGuard';
import { mkdirInProjectBandit } from './projectDir';
import { isWorkspaceTrusted, loadUserGrants, rememberUserGrant } from './workspaceTrust';

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop';

export interface HookRule {
  match?: string;
  command: string;
  timeout?: number;
}

export interface PermissionsBlock {
  allow?: string[];
  deny?: string[];
  ask?: string[];
  /** `ask` (default) | `auto` | `dangerous` — see permissionMode.ts. Invalid
   *  values fall back to `ask` with a warning rather than failing the load. */
  mode?: string;
}

/** A setting an untrusted workspace tried to widen, and where it came from. */
export interface IgnoredUntrustedSetting {
  /** Absolute path of the settings file. */
  file: string;
  /** Setting keys that were dropped: `hooks`, `permissions.allow`,
   *  `permissions.mode`, `security.guard.enabled`. */
  keys: string[];
  /** How many hook rules were dropped, when `keys` includes `hooks` — for
   *  a host's "3 hooks, permissions.mode" notice. */
  hookCount?: number;
}

export interface HookSettings {
  hooks?: Partial<Record<HookEvent, HookRule[]>>;
  permissions?: PermissionsBlock;
  /** Built-in pre-tool security guard (opt-in, off by default). Read under
   *  `security.guard`. See securityGuard.ts. */
  security?: { guard?: SecurityGuardSettings };
  /** Offline mode (see offline.ts). Any settings file that sets it to true
   *  turns it on; a later file cannot turn it back off. */
  offline?: boolean;
  /** Whether the workspace's own settings files were honoured in full
   *  (see workspaceTrust.ts). Absent on a settings object a host built by
   *  hand. */
  workspaceTrusted?: boolean;
  /** What the workspace's files tried to widen while untrusted. Empty or
   *  absent when nothing was dropped. Hosts show this once, with how to
   *  trust the folder. */
  ignoredUntrusted?: IgnoredUntrustedSetting[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Narrow → wide. An untrusted workspace may move the mode left, never right. */
const MODE_RANK: Record<string, number> = { plan: 0, ask: 1, auto: 2, dangerous: 3 };

export interface LoadHookSettingsOptions {
  /** Overrides the global `~/.bandit` location (tests). */
  homeDir?: string;
  /** Decide trust here instead of consulting the trust store — a host that
   *  already asked the user passes its answer. */
  trusted?: boolean;
  /** Process env. Injectable for tests. */
  env?: Record<string, string | undefined>;
}

export async function loadHookSettings(cwd: string, opts?: LoadHookSettingsOptions): Promise<HookSettings> {
  // Global (~/.bandit) first, then workspace, then workspace .local — later
  // files extend the earlier ones (hook/permission arrays concatenate; the
  // security guard's scalar fields take the last value defined). This is what
  // makes a user's GLOBAL hooks + guard apply to every repo, with per-project
  // overrides on top. `opts.homeDir` overrides the global location (tests).
  //
  // The workspace files belong to whoever wrote the repository, not
  // necessarily to the user. Until the user trusts the folder they may only
  // NARROW what Bandit does: hooks (host-executed shell), allow rules and a
  // wider mode are dropped and reported in `ignoredUntrusted`. The user's own
  // "always allow" choices are remembered under ~/.bandit and still apply —
  // see workspaceTrust.ts for why that split exists.
  const trusted = opts?.trusted ?? await isWorkspaceTrusted(cwd, { homeDir: opts?.homeDir, env: opts?.env });
  const candidates: Array<{ file: string; workspace: boolean }> = [
    { file: path.join(opts?.homeDir ?? os.homedir(), '.bandit', 'settings.json'), workspace: false },
    { file: path.resolve(cwd, '.bandit/settings.json'), workspace: true },
    { file: path.resolve(cwd, '.bandit/settings.local.json'), workspace: true }
  ];
  const userGrants = trusted ? [] : await loadUserGrants(cwd, { homeDir: opts?.homeDir }).catch(() => [] as string[]);
  const merged: HookSettings = {
    hooks: {},
    permissions: { allow: [], deny: [], ask: [] },
    workspaceTrusted: trusted,
    ignoredUntrusted: []
  };
  for (const { file, workspace } of candidates) {
    const restricted = workspace && !trusted;
    const dropped: string[] = [];
    let droppedHooks = 0;
    try {
      const raw = await fs.promises.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw) as HookSettings;
      if (parsed.hooks) {
        const events = (Object.keys(parsed.hooks) as HookEvent[]).filter((ev) => (parsed.hooks?.[ev] ?? []).length > 0);
        if (restricted) {
          if (events.length > 0) {
            dropped.push('hooks');
            droppedHooks = events.reduce((n, ev) => n + (parsed.hooks?.[ev]?.length ?? 0), 0);
          }
        } else {
          for (const ev of events) {
            merged.hooks![ev] = [...(merged.hooks![ev] ?? []), ...(parsed.hooks[ev] ?? [])];
          }
        }
      }
      if (parsed.permissions) {
        const allow = parsed.permissions.allow ?? [];
        if (restricted) {
          // Only the rules the user persisted from a card survive; anything
          // else in the repository's allow list is the repository's wish.
          const own = allow.filter((rule) => userGrants.includes(rule));
          if (own.length < allow.length) dropped.push('permissions.allow');
          merged.permissions!.allow = [...(merged.permissions!.allow ?? []), ...own];
        } else {
          merged.permissions!.allow = [...(merged.permissions!.allow ?? []), ...allow];
        }
        merged.permissions!.deny = [...(merged.permissions!.deny ?? []), ...(parsed.permissions.deny ?? [])];
        merged.permissions!.ask = [...(merged.permissions!.ask ?? []), ...(parsed.permissions.ask ?? [])];
        // Scalar, so last file wins — workspace overrides global, .local
        // overrides workspace. Matches how the guard's scalars merge. An
        // untrusted workspace can only move it towards plan.
        if (parsed.permissions.mode) {
          const next = parsed.permissions.mode.trim().toLowerCase();
          const current = merged.permissions!.mode?.trim().toLowerCase() ?? 'ask';
          const widens = (MODE_RANK[next] ?? MODE_RANK.ask) > (MODE_RANK[current] ?? MODE_RANK.ask);
          if (restricted && widens) dropped.push('permissions.mode');
          else merged.permissions!.mode = parsed.permissions.mode;
        }
      }
      if (parsed.offline === true) merged.offline = true;
      if (parsed.security?.guard) {
        const g = parsed.security.guard;
        const cur = merged.security?.guard ?? {};
        let enabled = g.enabled ?? cur.enabled;
        if (restricted && g.enabled === false) {
          // A repository does not get to switch the guard off — neither the
          // user's global setting nor a host's on-by-default.
          dropped.push('security.guard.enabled');
          enabled = cur.enabled;
        }
        merged.security = {
          guard: {
            enabled,
            blockCommands: [...(cur.blockCommands ?? []), ...(g.blockCommands ?? [])],
            protectPaths: [...(cur.protectPaths ?? []), ...(g.protectPaths ?? [])]
          }
        };
      }
    } catch {
      // Missing / invalid — skip silently.
    }
    if (dropped.length > 0) {
      merged.ignoredUntrusted!.push({ file, keys: dropped, ...(droppedHooks > 0 ? { hookCount: droppedHooks } : {}) });
    }
  }
  return merged;
}

/**
 * Persist an entry in the workspace settings.json permissions.allow list.
 * Called when the user picks "Always allow" in a permission prompt and wants
 * the choice to survive restarts. Creates .bandit/settings.json if missing.
 *
 * The rule is also remembered under `~/.bandit` (workspaceTrust.ts) so it
 * keeps applying while the workspace itself is not trusted: the user chose
 * it, the repository did not.
 */
export async function persistAllowEntry(cwd: string, entry: string, opts?: { homeDir?: string }): Promise<void> {
  const dir = path.resolve(cwd, '.bandit');
  const file = path.resolve(dir, 'settings.json');
  await mkdirInProjectBandit(cwd, dir);
  let existing: HookSettings = {};
  try {
    const raw = await fs.promises.readFile(file, 'utf-8');
    existing = JSON.parse(raw) as HookSettings;
  } catch {
    // File didn't exist or was invalid — start fresh.
  }
  existing.permissions = existing.permissions ?? {};
  existing.permissions.allow = existing.permissions.allow ?? [];
  if (!existing.permissions.allow.includes(entry)) {
    existing.permissions.allow.push(entry);
  }
  await fs.promises.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  await rememberUserGrant(cwd, entry, { homeDir: opts?.homeDir }).catch(() => undefined);
}

export interface HookContext {
  toolName?: string;
  primary?: string;
  durationMs?: number;
}

export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runHooks(
  event: HookEvent,
  settings: HookSettings,
  ctx: HookContext,
  cwd: string
): Promise<HookResult[]> {
  const rules = settings.hooks?.[event] ?? [];
  if (rules.length === 0) return [];
  const results: HookResult[] = [];
  for (const rule of rules) {
    if (rule.match && ctx.toolName && !new RegExp(rule.match).test(ctx.toolName)) {
      continue;
    }
    const cmd = expand(rule.command, ctx);
    results.push(await runShell(cmd, cwd, rule.timeout ?? DEFAULT_TIMEOUT_MS));
  }
  return results;
}

function expand(template: string, ctx: HookContext): string {
  return template
    .replace(/\{\{\s*name\s*\}\}/g, shellEscape(ctx.toolName ?? ''))
    .replace(/\{\{\s*primary\s*\}\}/g, shellEscape(ctx.primary ?? ''))
    .replace(/\{\{\s*duration\s*\}\}/g, String(ctx.durationMs ?? ''));
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<HookResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    // detached (POSIX): make the shell a process-group leader so the timeout can
    // kill the WHOLE tree. `proc.kill()` alone signals only the sh wrapper — its
    // children survive holding the stdio pipes, so 'close' (which waits on
    // streams) never fires until they exit naturally and the "timeout" is a
    // no-op for any hook that spawns children (caught by CI on Linux: a
    // 200ms-timeout `sleep 5` hook ran the full 5s).
    const proc = cp.spawn(command, { cwd, shell: true, env: { ...process.env }, detached: process.platform !== 'win32' });
    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, signal);
        else proc.kill(signal);
      } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      killTree('SIGTERM');
      // Grace period, then hard-kill anything ignoring SIGTERM.
      const escalate = setTimeout(() => killTree('SIGKILL'), 1500);
      escalate.unref?.();
    }, timeoutMs);
    proc.stdout?.on('data', d => { stdout += d.toString(); });
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout: '', stderr: err.message });
    });
  });
}

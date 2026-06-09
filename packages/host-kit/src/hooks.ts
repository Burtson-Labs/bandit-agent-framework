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
}

export interface HookSettings {
  hooks?: Partial<Record<HookEvent, HookRule[]>>;
  permissions?: PermissionsBlock;
  /** Built-in pre-tool security guard (opt-in, off by default). Read under
   *  `security.guard`. See securityGuard.ts. */
  security?: { guard?: SecurityGuardSettings };
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function loadHookSettings(cwd: string, opts?: { homeDir?: string }): Promise<HookSettings> {
  // Global (~/.bandit) first, then workspace, then workspace .local — later
  // files extend the earlier ones (hook/permission arrays concatenate; the
  // security guard's scalar fields take the last value defined). This is what
  // makes a user's GLOBAL hooks + guard apply to every repo, with per-project
  // overrides on top. `opts.homeDir` overrides the global location (tests).
  const candidates = [
    path.join(opts?.homeDir ?? os.homedir(), '.bandit', 'settings.json'),
    path.resolve(cwd, '.bandit/settings.json'),
    path.resolve(cwd, '.bandit/settings.local.json')
  ];
  const merged: HookSettings = { hooks: {}, permissions: { allow: [], deny: [], ask: [] } };
  for (const p of candidates) {
    try {
      const raw = await fs.promises.readFile(p, 'utf-8');
      const parsed = JSON.parse(raw) as HookSettings;
      if (parsed.hooks) {
        for (const ev of Object.keys(parsed.hooks) as HookEvent[]) {
          merged.hooks![ev] = [...(merged.hooks![ev] ?? []), ...(parsed.hooks[ev] ?? [])];
        }
      }
      if (parsed.permissions) {
        merged.permissions!.allow = [...(merged.permissions!.allow ?? []), ...(parsed.permissions.allow ?? [])];
        merged.permissions!.deny = [...(merged.permissions!.deny ?? []), ...(parsed.permissions.deny ?? [])];
        merged.permissions!.ask = [...(merged.permissions!.ask ?? []), ...(parsed.permissions.ask ?? [])];
      }
      if (parsed.security?.guard) {
        const g = parsed.security.guard;
        const cur = merged.security?.guard ?? {};
        merged.security = {
          guard: {
            enabled: g.enabled ?? cur.enabled,
            blockCommands: [...(cur.blockCommands ?? []), ...(g.blockCommands ?? [])],
            protectPaths: [...(cur.protectPaths ?? []), ...(g.protectPaths ?? [])]
          }
        };
      }
    } catch {
      // Missing / invalid — skip silently.
    }
  }
  return merged;
}

/**
 * Persist an entry in the workspace settings.json permissions.allow list.
 * Called when the user picks "Always allow" in a permission prompt and wants
 * the choice to survive restarts. Creates .bandit/settings.json if missing.
 */
export async function persistAllowEntry(cwd: string, entry: string): Promise<void> {
  const dir = path.resolve(cwd, '.bandit');
  const file = path.resolve(dir, 'settings.json');
  await fs.promises.mkdir(dir, { recursive: true });
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
    const proc = cp.spawn(command, { cwd, shell: true, env: { ...process.env } });
    const timer = setTimeout(() => { proc.kill('SIGTERM'); }, timeoutMs);
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

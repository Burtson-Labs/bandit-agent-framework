/**
 * Workspace trust — whether a project's own `.bandit/` configuration may
 * widen what Bandit does on this machine.
 *
 * `.bandit/settings.json` travels with the repository. It can define `hooks`
 * (shell commands the host runs around every tool call), `permissions.allow`
 * (calls that skip the prompt) and `permissions.mode` (`auto`, `dangerous`).
 * Before 2026-10-31 all three took effect the moment Bandit started in the
 * folder: cloning a repository and asking Bandit to read one file was enough
 * to run a command the repository's author chose, with the user's own
 * privileges. That is the same outcome as the trojanized-extension incident of
 * 2026-10-29 (an SSH key added to `authorized_keys`, a LaunchAgent for
 * persistence), reachable with nothing more than a `git clone`.
 *
 * A workspace is now UNTRUSTED until the user says otherwise. An untrusted
 * workspace's settings files may only narrow Bandit — deny and ask rules, a
 * narrower permission mode, offline mode, extra security-guard rules. Hooks,
 * allow rules and a wider mode are ignored, and `loadHookSettings` reports what
 * it ignored so the host can tell the user how to trust the folder.
 *
 * Trust is per folder (a trusted folder covers its subfolders) and remembered
 * in `~/.bandit/trusted-workspaces.json`, written 0600 and only by an explicit
 * user action in a host. `BANDIT_TRUST_PROJECT_SETTINGS=1` trusts the current
 * workspace for one process — for CI, where there is no prompt and the checkout
 * is the job's own. The global `~/.bandit/settings.json` is the user's own file
 * and is always honoured.
 *
 * The same file also records the allow rules a user persisted from a
 * permission card ("always allow"). Those are written to the workspace's
 * `.bandit/settings.json` for the team to see, and remembered here so they
 * keep working in a workspace that is not trusted: a rule the user chose is
 * not a rule the repository chose, and the repository cannot forge an entry
 * in a file under `~/.bandit`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const TRUST_PROJECT_SETTINGS_ENV = 'BANDIT_TRUST_PROJECT_SETTINGS';

interface TrustFile {
  /** Folders whose `.bandit/` settings are honoured in full. */
  trusted: string[];
  /** Allow rules the user persisted from a permission card, per folder. */
  grants?: Record<string, string[]>;
}

export interface WorkspaceTrustOptions {
  /** Overrides `os.homedir()` (tests). */
  homeDir?: string;
  /** Process env. Injectable for tests. */
  env?: Record<string, string | undefined>;
}

/** Path of the trust file for the given (or the real) home directory. */
export function trustedWorkspacesPath(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), '.bandit', 'trusted-workspaces.json');
}

/**
 * One spelling per folder: absolute, symlinks resolved when the folder
 * exists, no trailing separator. `/work/proj/` and `/work/./proj` are the
 * same trust decision.
 */
export function normalizeWorkspaceRoot(root: string): string {
  const resolved = path.resolve(root);
  let real = resolved;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    // Not on disk (yet) — the resolved spelling is the best we have.
  }
  const trimmed = real.length > 1 ? real.replace(/[\\/]+$/, '') : real;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function isSameOrInside(candidate: string, parent: string): boolean {
  if (candidate === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return candidate.startsWith(withSep);
}

async function readTrustFile(homeDir?: string): Promise<TrustFile> {
  try {
    const raw = await fs.promises.readFile(trustedWorkspacesPath(homeDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TrustFile>;
    const trusted = Array.isArray(parsed.trusted)
      ? parsed.trusted.filter((s): s is string => typeof s === 'string')
      : [];
    const grants: Record<string, string[]> = {};
    if (parsed.grants && typeof parsed.grants === 'object') {
      for (const [root, rules] of Object.entries(parsed.grants)) {
        if (Array.isArray(rules)) grants[root] = rules.filter((r): r is string => typeof r === 'string');
      }
    }
    return { trusted, grants };
  } catch {
    // Missing or malformed: nothing is trusted. Trust is opt-in.
    return { trusted: [], grants: {} };
  }
}

async function writeTrustFile(file: TrustFile, homeDir?: string): Promise<void> {
  const target = trustedWorkspacesPath(homeDir);
  try { await fs.promises.mkdir(path.dirname(target), { recursive: true }); } catch { /* exists */ }
  await fs.promises.writeFile(target, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

/** True when the environment trusts the current workspace for this process. */
export function envTrustsProjectSettings(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env[TRUST_PROJECT_SETTINGS_ENV] ?? '').trim());
}

/** Folders the user has trusted, normalized. */
export async function loadTrustedWorkspaces(opts: WorkspaceTrustOptions = {}): Promise<string[]> {
  const file = await readTrustFile(opts.homeDir);
  return file.trusted.map(normalizeWorkspaceRoot);
}

/**
 * Is this workspace trusted? True when the env says so, or when the folder
 * (or one of its parents) is in the trust file.
 */
export async function isWorkspaceTrusted(root: string, opts: WorkspaceTrustOptions = {}): Promise<boolean> {
  if (envTrustsProjectSettings(opts.env ?? process.env)) return true;
  const target = normalizeWorkspaceRoot(root);
  const trusted = await loadTrustedWorkspaces(opts);
  return trusted.some((t) => isSameOrInside(target, t));
}

/** Remember a folder as trusted. Idempotent. */
export async function trustWorkspace(root: string, opts: WorkspaceTrustOptions = {}): Promise<string> {
  const target = normalizeWorkspaceRoot(root);
  const file = await readTrustFile(opts.homeDir);
  if (!file.trusted.map(normalizeWorkspaceRoot).includes(target)) {
    file.trusted.push(target);
    await writeTrustFile(file, opts.homeDir);
  }
  return target;
}

/** Forget a folder. Only an exact entry is removed; a trusted parent still covers it. */
export async function untrustWorkspace(root: string, opts: WorkspaceTrustOptions = {}): Promise<boolean> {
  const target = normalizeWorkspaceRoot(root);
  const file = await readTrustFile(opts.homeDir);
  const next = file.trusted.filter((t) => normalizeWorkspaceRoot(t) !== target);
  if (next.length === file.trusted.length) return false;
  await writeTrustFile({ ...file, trusted: next }, opts.homeDir);
  return true;
}

/**
 * Record an allow rule the user chose for this folder, so it is honoured even
 * while the folder's own settings are not trusted. Called by
 * `persistAllowEntry` next to the write into `.bandit/settings.json`.
 */
export async function rememberUserGrant(root: string, rule: string, opts: WorkspaceTrustOptions = {}): Promise<void> {
  const target = normalizeWorkspaceRoot(root);
  const file = await readTrustFile(opts.homeDir);
  const grants = file.grants ?? {};
  const existing = grants[target] ?? [];
  if (!existing.includes(rule)) {
    grants[target] = [...existing, rule];
    await writeTrustFile({ ...file, grants }, opts.homeDir);
  }
}

/** Allow rules the user persisted for this folder (exact folder only). */
export async function loadUserGrants(root: string, opts: WorkspaceTrustOptions = {}): Promise<string[]> {
  const target = normalizeWorkspaceRoot(root);
  const file = await readTrustFile(opts.homeDir);
  return [...(file.grants?.[target] ?? [])];
}

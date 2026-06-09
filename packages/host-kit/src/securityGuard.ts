/**
 * Built-in pre-tool security guard — an in-process, no-shell-spawn safety net
 * that blocks the handful of tool calls that are almost never legitimate
 * (catastrophic `rm`, piping a remote script into a shell, writing to system /
 * credential paths, exfiltrating an SSH/cloud key over the network, …).
 *
 * It runs in `beforeToolExecute` BEFORE the user's own PreToolUse hooks and the
 * permission policy, so it's the first line of defense against the *model*
 * footgunning (prompt injection, a hallucinated `rm -rf /`) — NOT a sandbox and
 * NOT protection against a malicious user (who controls the settings).
 *
 * Opt-in, OFF by default (`security.guard.enabled`). Deliberately conservative:
 * every rule targets a pattern that legitimate agent work essentially never
 * produces, so false positives stay rare. Shared by the CLI and the IDE host.
 */
import * as path from 'path';
import * as os from 'os';

export interface SecurityGuardSettings {
  /** Master switch. Off by default. Set in `.bandit/settings.json` (or the
   *  global `~/.bandit/settings.json`) under `security.guard`. */
  enabled?: boolean;
  /** Extra command-substring patterns (regex source) to block, on top of the
   *  built-ins. */
  blockCommands?: string[];
  /** Extra absolute/`~` path prefixes to protect from writes. */
  protectPaths?: string[];
}

export interface SecurityGuardContext {
  workspaceRoot?: string;
  homeDir?: string;
}

export interface SecurityGuardDecision {
  allow: boolean;
  reason?: string;
  /** Identifier of the rule that fired (for logging / tests). */
  rule?: string;
}

const WRITE_TOOLS = new Set(['write_file', 'apply_edit', 'replace_range', 'apply_patch', 'delete_file']);

/** Recursive+force `rm` aimed at `/`, `~`, `$HOME`, or `/*`. */
function isCatastrophicRm(cmd: string): boolean {
  if (!/\brm\b/.test(cmd)) return false;
  const recursive = /(^|\s)-[a-zA-Z]*r[a-zA-Z]*\b/.test(cmd) || /--recursive\b/.test(cmd);
  const force = /(^|\s)-[a-zA-Z]*f[a-zA-Z]*\b/.test(cmd) || /--force\b/.test(cmd) || /--no-preserve-root\b/.test(cmd);
  if (!(recursive && force)) return false;
  if (/--no-preserve-root\b/.test(cmd)) return true;
  // A bare root/home/glob-of-root target (slash/tilde/$HOME/`/*` followed by
  // end, whitespace, or another slash/star — so `/tmp/x` is NOT matched).
  return /(\s|=|["'])(\/|~|\$\{?HOME\}?|\/\*)(\s|$|["']|\/(?:\*|\s|$)|\*)/.test(cmd)
    || /\s\/\s*$/.test(cmd) || /\s~\s*$/.test(cmd) || /\s\/\*/.test(cmd);
}

interface CommandRule { id: string; reason: string; test: (cmd: string) => boolean; }

const COMMAND_RULES: CommandRule[] = [
  { id: 'rm-root', reason: 'recursive force-delete of a root/home path', test: isCatastrophicRm },
  { id: 'curl-pipe-shell', reason: 'a downloaded script piped straight into a shell', test: (c) => /(?:curl|wget|fetch)\b[\s\S]*?\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|python[0-9.]*|perl|ruby|node)\b/i.test(c) },
  { id: 'fork-bomb', reason: 'a fork bomb', test: (c) => /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c) },
  { id: 'disk-destroy', reason: 'a raw write to a block device / filesystem', test: (c) => /\bmkfs(?:\.\w+)?\b/i.test(c) || /\bdd\b[\s\S]*\bof=\/dev\/(?:sd|nvme|hd|disk|mmcblk|vd)/i.test(c) || />\s*\/dev\/(?:sd|nvme|hd|disk|mmcblk|vd)/i.test(c) },
  { id: 'chmod-chown-root', reason: 'a recursive permission/owner change on `/`', test: (c) => /\bchmod\s+(?:-[a-z]*R[a-z]*\s+)?0?[0-7]{3}\s+\/(?:\s|$)/i.test(c) || /\bchown\s+-[a-z]*R[a-z]*\b[\s\S]*\s\/(?:\s|$)/i.test(c) },
  { id: 'redirect-sensitive', reason: 'output redirected into a system / credential path', test: (c) => />>?\s*(?:["']?)(?:\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/boot\/|~\/?\.ssh\/|\$HOME\/\.ssh\/|\.ssh\/authorized_keys|\/root\/)/i.test(c) },
  {
    id: 'secret-exfil',
    reason: 'a credential file read AND sent over the network in one command',
    test: (c) => {
      const secretRead = /(?:\.ssh\/[\w.-]*(?:id_[a-z0-9]+|_rsa|_ed25519|_ecdsa|_dsa)\b|\bid_rsa\b|\.aws\/credentials|\.netrc\b|\.kube\/config\b|\.docker\/config\.json\b|\.gnupg\/)/i.test(c);
      const netEgress = /\b(?:curl|wget|nc|netcat|ncat|telnet|scp|sftp)\b|https?:\/\//i.test(c);
      return secretRead && netEgress;
    }
  }
];

const SENSITIVE_WRITE_PREFIXES = [
  '/etc/', '/usr/', '/bin/', '/sbin/', '/boot/', '/sys/', '/proc/', '/dev/', '/root/',
  '/System/', '/Library/'
];
const SENSITIVE_WRITE_SUFFIXES = [
  '/.ssh/', '/.aws/', '/.gnupg/', '/.kube/config', '/.docker/config.json',
  '/.bashrc', '/.zshrc', '/.profile', '/.bash_profile'
];

function checkWritePath(rawPath: string, ctx: SecurityGuardContext, extraProtected: string[]): SecurityGuardDecision {
  const home = ctx.homeDir ?? os.homedir();
  const expanded = rawPath.trim().replace(/^~(?=\/|$)/, home);
  const norm = expanded.replace(/\\/g, '/');

  for (const prefix of [...SENSITIVE_WRITE_PREFIXES, ...extraProtected]) {
    if (norm === prefix.replace(/\/$/, '') || norm.startsWith(prefix)) {
      return { allow: false, rule: 'write-sensitive', reason: `writing to a protected system/credential path (${prefix})` };
    }
  }
  for (const suffix of SENSITIVE_WRITE_SUFFIXES) {
    if (norm.includes(suffix)) {
      return { allow: false, rule: 'write-sensitive', reason: `writing to a protected credential path (${suffix})` };
    }
  }
  // Path traversal outside the workspace (only when we know the root and the
  // path isn't an unrelated absolute temp path the host already allows).
  if (ctx.workspaceRoot) {
    const resolved = path.resolve(ctx.workspaceRoot, expanded);
    const root = path.resolve(ctx.workspaceRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      // Only flag when the original path explicitly traverses up; bare absolute
      // temp paths (e.g. /tmp/x) aren't the guard's job and the host gates them.
      if (/(^|\/)\.\.(\/|$)/.test(rawPath)) {
        return { allow: false, rule: 'write-escape', reason: 'writing outside the workspace root via `..` traversal' };
      }
    }
  }
  return { allow: true };
}

/**
 * Evaluate a tool call against the guard. Returns `{allow:true}` when the guard
 * is disabled or nothing matches. Never throws.
 */
export function evaluateSecurityGuard(
  call: { name: string; params: Record<string, string> },
  settings: SecurityGuardSettings | undefined,
  ctx: SecurityGuardContext = {}
): SecurityGuardDecision {
  if (!settings?.enabled) return { allow: true };
  try {
    const name = call.name;
    const params = call.params ?? {};

    if (name === 'run_command') {
      const cmd = `${params.cmd ?? ''} ${params.args ?? ''}`.trim();
      if (!cmd) return { allow: true };
      for (const rule of COMMAND_RULES) {
        if (rule.test(cmd)) return { allow: false, rule: rule.id, reason: rule.reason };
      }
      for (const extra of settings.blockCommands ?? []) {
        try { if (new RegExp(extra, 'i').test(cmd)) return { allow: false, rule: 'custom-command', reason: `matched a configured blockCommands pattern (${extra})` }; }
        catch { /* invalid user regex — ignore */ }
      }
      return { allow: true };
    }

    if (WRITE_TOOLS.has(name)) {
      const target = params.path ?? '';
      if (!target) return { allow: true };
      return checkWritePath(target, ctx, settings.protectPaths ?? []);
    }

    return { allow: true };
  } catch {
    // The guard must never break a turn — fail open.
    return { allow: true };
  }
}

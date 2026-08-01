/**
 * Risk classification for tool calls — the single place that answers "how bad
 * is it if this runs and the user wasn't paying attention?"
 *
 * Three tiers:
 *
 *  - `routine`   Reversible, inside the workspace, no external effect. Reading
 *                files, editing tracked source, running the test suite. Losing
 *                one of these to an inattentive approval costs a `git diff`.
 *  - `elevated`  Real consequences, still recoverable: new files, dependency
 *                installs, git state changes, network reads, subagents.
 *  - `critical`  Destructive, irreversible, outside the workspace, or sending
 *                data somewhere. Deletes, force-push, global installs,
 *                credential paths, egress with a body.
 *
 * Two consumers:
 *
 *  1. **Auto mode** auto-approves `routine` and nothing else. `critical` is a
 *     hard floor — it prompts no matter what the config says. See
 *     `permissionMode.ts`.
 *  2. **The permission card**, which uses `why` as its risk line and the tier
 *     for visual weight, so an `rm -rf` prompt doesn't look like a `read_file`
 *     prompt. Both hosts previously hand-rolled this from separate string
 *     matching that had already drifted apart.
 *
 * Design rule: **classify by what the call CAN do, not by what it probably
 * means.** When a command's blast radius depends on arguments we can't
 * evaluate (`npm run <script>` runs whatever package.json says; `make` runs
 * the Makefile), it does not get to be `routine`. Guessing generously here is
 * how an auto mode silently becomes a full bypass.
 */
import * as path from 'path';
import * as os from 'os';

export type RiskTier = 'routine' | 'elevated' | 'critical';

export interface RiskAssessment {
  tier: RiskTier;
  /** One sentence, user-facing. Rendered as the card's risk line. */
  why: string;
  /** Stable identifier for the rule that decided this (logging / tests). */
  rule: string;
}

export interface RiskContext {
  workspaceRoot?: string;
  homeDir?: string;
}

const READ_ONLY_TOOLS = new Set([
  'read_file', 'list_files', 'ls', 'search_code', 'find_directory',
  'read_memory', 'todo_write', 'check_task', 'list_tasks', 'ask_user'
]);

const EDIT_TOOLS = new Set(['apply_edit', 'replace_range']);

/** Commands whose whole job is to build, check, or describe — no state change. */
const ROUTINE_COMMANDS = new Set([
  'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'playwright',
  'pytest', 'ruff', 'mypy', 'black', 'gofmt', 'rustc', 'javac',
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'jq', 'yq', 'wc', 'which', 'echo', 'pwd'
]);

/** Read-only git subcommands. Anything not listed is treated as state-changing. */
const ROUTINE_GIT = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'ls-files', 'rev-parse',
  'describe', 'shortlog', 'whatchanged', 'cat-file', 'remote'
]);

/**
 * Subcommands that only build/test/inspect for package managers that ALSO have
 * destructive subcommands. Anything else on these binaries escalates.
 */
const ROUTINE_SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(['test', 'run-script', 'ls', 'list', 'view', 'outdated', 'why', 'ping']),
  pnpm: new Set(['test', 'ls', 'list', 'why', 'outdated']),
  yarn: new Set(['test', 'list', 'why', 'outdated']),
  cargo: new Set(['build', 'check', 'test', 'clippy', 'fmt', 'tree']),
  go: new Set(['build', 'test', 'vet', 'fmt', 'list']),
  dotnet: new Set(['build', 'test', 'restore', 'format']),
  mvn: new Set(['compile', 'test', 'verify']),
  gradle: new Set(['build', 'test', 'check']),
  bundle: new Set(['exec', 'list', 'check']),
  composer: new Set(['validate', 'show', 'outdated']),
  swift: new Set(['build', 'test'])
};

interface CommandRule { id: string; why: string; test: (cmd: string, argv: string[]) => boolean; }

const CRITICAL_COMMAND_RULES: CommandRule[] = [
  {
    id: 'destructive-fs',
    why: 'Deletes or overwrites files irreversibly.',
    test: (c) => /\b(rm|rmdir|shred|srm)\b/.test(c) || /\bdd\b/.test(c) || /\bmkfs\b/.test(c)
  },
  {
    id: 'privilege-escalation',
    why: 'Runs with elevated privileges.',
    test: (c) => /\b(sudo|doas|su)\b/.test(c)
  },
  {
    id: 'git-history-rewrite',
    why: 'Rewrites git history or discards committed work — hard to recover.',
    test: (c) =>
      /\bgit\b[\s\S]*\bpush\b[\s\S]*(--force\b|--force-with-lease\b|\s-f\b)/.test(c) ||
      /\bgit\b[\s\S]*\breset\b[\s\S]*--hard\b/.test(c) ||
      /\bgit\b[\s\S]*\bclean\b[\s\S]*-[a-z]*f/.test(c) ||
      /\bgit\b[\s\S]*\b(rebase|filter-branch|reflog\s+expire)\b/.test(c)
  },
  {
    id: 'global-install',
    why: 'Installs software outside this project, affecting your whole machine.',
    test: (c) =>
      /\bnpm\b[\s\S]*\b(i|install|add)\b[\s\S]*\s(-g|--global)\b/.test(c) ||
      /\b(pnpm|yarn)\b[\s\S]*\bglobal\b/.test(c) ||
      /\bbrew\b[\s\S]*\b(install|upgrade|uninstall)\b/.test(c) ||
      /\b(pipx|gem)\b[\s\S]*\binstall\b/.test(c) ||
      /\bpip3?\b[\s\S]*\binstall\b(?![\s\S]*(-r|--requirement|-e\b))/.test(c) ||
      /\bcargo\b[\s\S]*\binstall\b/.test(c) ||
      /\bgo\b[\s\S]*\binstall\b/.test(c)
  },
  {
    id: 'publish',
    why: 'Publishes a package or release to a public registry.',
    test: (c) => /\b(npm|pnpm|yarn)\b[\s\S]*\bpublish\b/.test(c) || /\bcargo\b[\s\S]*\bpublish\b/.test(c) || /\btwine\b[\s\S]*\bupload\b/.test(c)
  },
  {
    id: 'network-egress',
    why: 'Sends data off this machine.',
    test: (c) =>
      /\b(curl|wget)\b[\s\S]*(-d\b|--data\b|-F\b|--form\b|-T\b|--upload-file\b|-X\s*(POST|PUT|PATCH|DELETE))/i.test(c) ||
      /\b(scp|sftp|rsync)\b[\s\S]*:/.test(c) ||
      /\b(nc|netcat|ncat|telnet)\b/.test(c)
  },
  {
    id: 'process-control',
    why: 'Kills processes or changes system state.',
    test: (c) => /\b(kill|killall|pkill|shutdown|reboot|halt|launchctl|systemctl|service)\b/.test(c)
  },
  {
    id: 'permission-change',
    why: 'Changes file ownership or permissions.',
    test: (c) => /\b(chmod|chown|chgrp)\b/.test(c)
  }
];

const ELEVATED_COMMAND_RULES: CommandRule[] = [
  {
    id: 'dependency-install',
    why: 'Adds or updates project dependencies.',
    test: (c) => /\b(npm|pnpm|yarn|bun)\b[\s\S]*\b(i|install|add|update|upgrade|ci)\b/.test(c) ||
      /\bpip3?\b[\s\S]*\binstall\b/.test(c) ||
      /\b(bundle|composer)\b[\s\S]*\b(install|update)\b/.test(c) ||
      /\bcargo\b[\s\S]*\b(add|update)\b/.test(c) ||
      /\bgo\b[\s\S]*\b(get|mod)\b/.test(c)
  },
  {
    id: 'git-state-change',
    why: 'Changes git state in this repository.',
    test: (c, argv) => (argv[0] === 'git' || argv[0]?.endsWith('/git') === true) && !ROUTINE_GIT.has(argv[1] ?? '')
  },
  {
    id: 'github-cli',
    why: 'Acts on GitHub — may open, comment on, or merge work.',
    test: (_c, argv) => argv[0] === 'gh'
  },
  {
    id: 'container',
    why: 'Runs or changes containers.',
    test: (_c, argv) => argv[0] === 'docker' || argv[0] === 'docker-compose' || argv[0] === 'podman'
  },
  {
    id: 'project-scripts',
    why: 'Runs project-defined scripts, which can do anything the project author wrote.',
    test: (_c, argv) => argv[0] === 'make' || argv[0] === 'cmake' || argv[0] === 'rake' ||
      (argv[0] === 'npm' && argv[1] === 'run') ||
      (argv[0] === 'pnpm' && argv[1] === 'run') ||
      (argv[0] === 'yarn' && argv[1] === 'run') ||
      argv[0] === 'npx' || argv[0] === 'osascript'
  }
];

const CREDENTIAL_PATH = /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc)(\/|$)|(^|\/)\.env(\.|$)|id_rsa|id_ed25519|credentials$/i;

/** Split a run_command invocation into a normalized argv + full string. */
function commandParts(params: Record<string, string>): { full: string; argv: string[] } {
  const rawCmd = (params.cmd ?? '').trim();
  const rawArgs = (params.args ?? '').trim();
  const full = `${rawCmd}${rawArgs ? ' ' + rawArgs : ''}`.trim();
  const argv = full.split(/\s+/).filter(Boolean);
  if (argv[0]) {
    // Normalize `/usr/local/bin/git` → `git` so rules match on the binary.
    argv[0] = argv[0].split('/').pop() ?? argv[0];
  }
  return { full, argv };
}

function isOutsideWorkspace(rawPath: string, ctx: RiskContext): boolean {
  if (!ctx.workspaceRoot || !rawPath) return false;
  const home = ctx.homeDir ?? os.homedir();
  const expanded = rawPath.trim().replace(/^~(?=\/|$)/, home);
  const resolved = path.resolve(ctx.workspaceRoot, expanded);
  const root = path.resolve(ctx.workspaceRoot);
  return resolved !== root && !resolved.startsWith(root + path.sep);
}

/** Any param value that names a credential file. */
function touchesCredentials(params: Record<string, string>): boolean {
  return Object.values(params).some((v) => typeof v === 'string' && CREDENTIAL_PATH.test(v));
}

/**
 * MCP-bridged tools arrive as `<server>.<tool>` or `mcp__<server>__<tool>`.
 * Names that send, delete, or revoke reach outside the machine irreversibly;
 * other mutations are recoverable.
 */
function stripNamespace(name: string): string {
  const dot = name.indexOf('.');
  if (dot > 0) return name.slice(dot + 1);
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return parts[parts.length - 1] ?? name;
  }
  return name;
}

const IRREVERSIBLE_MCP = /^(send|delete|trash|remove|revoke|purge|destroy|archive|cancel)[A-Z_]/;
const MUTATING_MCP = /^(create|update|modify|add|insert|replace|rename|move|copy|upload|write|append|clear|set|post|reply|batch|duplicate|grant|apply|triage|quick[Aa]dd)[A-Z_]/;

/**
 * Classify a tool call. Never throws — an unknown tool is `elevated`, because
 * the safe default for "we don't recognize this" is "ask", not "run it".
 */
export function classifyRisk(
  call: { name: string; params: Record<string, string> },
  ctx: RiskContext = {}
): RiskAssessment {
  try {
    const name = call.name;
    const params = call.params ?? {};

    if (touchesCredentials(params)) {
      return { tier: 'critical', rule: 'credential-path', why: 'Touches a credentials or secrets file.' };
    }

    // Any file-touching tool aimed outside the workspace is critical
    // regardless of which tool it is — that is the boundary the user
    // actually reasons about.
    const pathParam = params.path ?? '';
    if (pathParam && isOutsideWorkspace(pathParam, ctx)) {
      return { tier: 'critical', rule: 'outside-workspace', why: 'Writes outside your project folder.' };
    }

    if (name === 'delete_file') {
      return { tier: 'critical', rule: 'delete', why: 'Permanently deletes a file.' };
    }

    if (READ_ONLY_TOOLS.has(name)) {
      return { tier: 'routine', rule: 'read-only', why: 'Reads local state only.' };
    }

    if (EDIT_TOOLS.has(name)) {
      return { tier: 'routine', rule: 'in-workspace-edit', why: 'Edits a file in your project. Review the diff.' };
    }

    if (name === 'write_file') {
      // Distinguished from apply_edit: write_file replaces a whole file and is
      // the tool a model reaches for when creating something new.
      return { tier: 'elevated', rule: 'whole-file-write', why: 'Creates or replaces an entire file.' };
    }

    if (name === 'apply_patch') {
      return { tier: 'elevated', rule: 'multi-file-patch', why: 'Changes several files at once.' };
    }

    if (name === 'web_fetch' || name === 'web_search') {
      return { tier: 'elevated', rule: 'network-read', why: 'Fetches external content into the conversation.' };
    }

    if (name === 'task') {
      return { tier: 'elevated', rule: 'subagent', why: 'Starts a subagent with its own tool access.' };
    }

    if (name === 'run_command' || name === 'watch_command') {
      const { full, argv } = commandParts(params);
      if (!full) return { tier: 'elevated', rule: 'empty-command', why: 'Runs a shell command.' };

      for (const rule of CRITICAL_COMMAND_RULES) {
        if (rule.test(full, argv)) return { tier: 'critical', rule: rule.id, why: rule.why };
      }
      for (const rule of ELEVATED_COMMAND_RULES) {
        if (rule.test(full, argv)) return { tier: 'elevated', rule: rule.id, why: rule.why };
      }

      const bin = argv[0] ?? '';
      const sub = argv[1] ?? '';
      if (bin === 'git') {
        return ROUTINE_GIT.has(sub)
          ? { tier: 'routine', rule: 'git-read', why: 'Reads git state.' }
          : { tier: 'elevated', rule: 'git-state-change', why: 'Changes git state in this repository.' };
      }
      const allowedSubs = ROUTINE_SUBCOMMANDS[bin];
      if (allowedSubs) {
        return allowedSubs.has(sub)
          ? { tier: 'routine', rule: 'build-or-test', why: 'Builds or tests this project.' }
          : { tier: 'elevated', rule: 'package-manager', why: `Runs \`${bin} ${sub}\`, which can change project state.` };
      }
      if (ROUTINE_COMMANDS.has(bin)) {
        return { tier: 'routine', rule: 'build-or-test', why: 'Builds, checks, or inspects this project.' };
      }
      // Recognized-but-unclassified binary. Not routine — see the design rule
      // at the top of this file.
      return { tier: 'elevated', rule: 'unclassified-command', why: 'Runs in your shell with your permissions.' };
    }

    const bare = stripNamespace(name);
    if (IRREVERSIBLE_MCP.test(bare)) {
      return { tier: 'critical', rule: 'mcp-irreversible', why: 'Sends or deletes data in a connected service.' };
    }
    if (MUTATING_MCP.test(bare)) {
      return { tier: 'elevated', rule: 'mcp-mutating', why: 'Changes data in a connected service.' };
    }
    if (/^(list|get|search|read|find|fetch|query|describe)[A-Z_]/.test(bare)) {
      return { tier: 'routine', rule: 'mcp-read', why: 'Reads from a connected service.' };
    }

    return { tier: 'elevated', rule: 'unknown-tool', why: 'Bandit is asking before using this capability.' };
  } catch {
    // A classifier crash must not become an auto-approval.
    return { tier: 'critical', rule: 'classifier-error', why: 'Could not assess this call, so it requires review.' };
  }
}

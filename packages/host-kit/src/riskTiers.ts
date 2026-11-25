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
import * as fs from 'fs';
import { isKnownLocalMcpTool, READ_ONLY_TOOLS } from './permissions';
import { patchTargets } from './patchTargets';

export type RiskTier = 'routine' | 'elevated' | 'critical';

export interface RiskAssessment {
  tier: RiskTier;
  /** One sentence, user-facing. Rendered as the card's risk line. */
  why: string;
  /** Stable identifier for the rule that decided this (logging / tests). */
  rule: string;
  /**
   * True only when the call reads/inspects and changes NOTHING — the strict
   * subset plan mode allows through. Deliberately narrower than the `routine`
   * tier: an in-workspace edit or a `vitest` run is `routine` (auto mode runs
   * it) but is NOT read-only (plan mode blocks it). Absent/false means "not
   * known to be read-only", which plan mode treats as blocked — the safe
   * default for anything we can't positively vouch for.
   */
  readOnly?: boolean;
}

export interface RiskContext {
  workspaceRoot?: string;
  homeDir?: string;
}

// READ_ONLY_TOOLS lives in permissions.ts: the same set is the policy's
// default-allow list, so "runs without a prompt" and "read-only in plan mode"
// cannot drift apart.

const EDIT_TOOLS = new Set(['apply_edit', 'replace_range']);

/** Commands whose whole job is to build, check, or describe — no state change. */
const ROUTINE_COMMANDS = new Set([
  'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'playwright',
  'pytest', 'ruff', 'mypy', 'black', 'gofmt', 'rustc', 'javac',
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'jq', 'yq', 'wc', 'which', 'echo', 'pwd'
]);

/**
 * The pure-inspection subset of ROUTINE_COMMANDS: they only print or read and
 * cannot mutate the filesystem or run project code. This is what plan mode
 * lets through as a shell command. `find` and the build/test tools
 * (tsc/vitest/…) are intentionally EXCLUDED — `find -delete`/`-exec` mutate,
 * and a test run executes arbitrary project code. Plan-mode exploration that
 * needs a directory tree should use the read-only `find_directory` /
 * `list_files` tools instead.
 */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'jq', 'yq', 'wc', 'which', 'echo', 'pwd'
]);

/** Read-only git subcommands. Anything not listed is treated as state-changing.
 *  `git remote` is handled separately: bare / `-v` / `show` / `get-url` read,
 *  `add` / `set-url` / `remove` rewrite `.git/config`. */
const ROUTINE_GIT = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'ls-files', 'rev-parse',
  'describe', 'shortlog', 'whatchanged', 'cat-file'
]);

/** `git remote` forms that only print. */
function isGitRemoteRead(argv: string[]): boolean {
  const rest = argv.slice(2);
  if (rest.length === 0) return true;
  if (rest.every((a) => a === '-v' || a === '--verbose')) return true;
  return rest[0] === 'show' || rest[0] === 'get-url';
}

/**
 * Options that turn a git read into a write or an exec: `--output` writes the
 * formatted log or diff to any file, `-c` / `--config-env` inject config
 * (`core.fsmonitor`, `diff.external`, …), `--ext-diff` / `--textconv` run
 * configured programs, `--exec` runs a command, the pack options name a
 * program on the remote side. `git log -1 --format=<payload> --output=<path>`
 * was a file write that plan mode let through as read-only.
 */
const GIT_REVIEW_OPTION = /^(?:-c|-C|-o|--output|--config-env|--ext-diff|--textconv|--filters|--exec|--upload-pack|--receive-pack|--git-dir|--work-tree|--exec-path)(?:=|$)/;

/** A git invocation (argv[0] already normalized to `git`) that only reads. */
function isGitRead(argv: string[]): boolean {
  const sub = argv[1] ?? '';
  if (argv.slice(1).some((a) => GIT_REVIEW_OPTION.test(a))) return false;
  return ROUTINE_GIT.has(sub) || (sub === 'remote' && isGitRemoteRead(argv));
}

/** `yq` edits files in place with `-i`; `--split-exp` writes new ones. */
function readOnlyCommandWrites(argv: string[]): boolean {
  if (argv[0] !== 'yq') return false;
  return argv.slice(1).some((a) => /^(?:-i|--inplace|-s|--split-exp)(?:=|$)/.test(a) || /^-[a-zA-Z]*i[a-zA-Z]*$/.test(a));
}

/**
 * `find` prints paths — until it is told to run something or delete. Those
 * flags turn a listing into arbitrary execution with the user's privileges,
 * which is exactly what auto mode must not wave through under a "read-only
 * command" label.
 */
function findExecutes(argv: string[]): boolean {
  return argv[0] === 'find' && argv.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(a));
}

/**
 * Subcommands that only build/test/inspect for package managers that ALSO have
 * destructive subcommands. Anything else on these binaries escalates.
 */
const ROUTINE_SUBCOMMANDS: Record<string, Set<string>> = {
  // `run-script` is `npm run` under another name: a project-defined script,
  // which the design rule above says is never routine.
  npm: new Set(['test', 'ls', 'list', 'view', 'outdated', 'why', 'ping']),
  pnpm: new Set(['test', 'ls', 'list', 'why', 'outdated']),
  yarn: new Set(['test', 'list', 'why', 'outdated']),
  cargo: new Set(['build', 'check', 'test', 'clippy', 'fmt', 'tree']),
  go: new Set(['build', 'test', 'vet', 'fmt', 'list']),
  dotnet: new Set(['build', 'test', 'restore', 'format']),
  mvn: new Set(['compile', 'test', 'verify']),
  gradle: new Set(['build', 'test', 'check']),
  // `bundle exec <anything>` runs an arbitrary program under the bundle, so it
  // is not a routine subcommand (2026-11-25 audit: `bundle exec ruby -e …`
  // classified routine).
  bundle: new Set(['list', 'check']),
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
    // The 2026-10-29 trojanized-extension playbook: a reverse SSH tunnel or
    // a tunnelling agent gives someone else a shell on this machine. None of
    // these binaries are on run_command's allow-list, but they can be reached
    // through a wrapper (`env`, `xargs`, `find -exec`, `python -c`, `osascript`),
    // so the rule matches the whole command line, not just argv[0].
    id: 'remote-access',
    why: 'Opens remote access to this machine or a tunnel out of it.',
    test: (c) =>
      /\b(ssh|sshd|autossh|mosh|ngrok|cloudflared|tailscale|zerotier|frpc|frps|socat|rathole|localtunnel)\b/.test(c)
      || /\bssh-(keygen|add|agent|copy-id)\b/.test(c)
      || /\bsystemsetup\b[\s\S]*remotelogin/i.test(c)
  },
  {
    // Anything that makes code run again after this session ends: cron,
    // launchd, systemd, Windows scheduled tasks / Run keys, login items.
    id: 'persistence',
    why: 'Installs something that runs at login, on a schedule, or at boot.',
    test: (c) =>
      /\b(crontab|schtasks|launchctl|systemctl|loginctl|update-rc\.d|chkconfig|rc-update)\b/.test(c)
      || /\bsc(\.exe)?\s+(create|config)\b/i.test(c)
      || /\breg(\.exe)?\s+add\b[\s\S]*\\(Run|RunOnce|Winlogon)\b/i.test(c)
      || /\b(New|Register|Set)-ScheduledTask\b/i.test(c)
      || /\bdefaults\s+write\b[\s\S]*(loginwindow|LoginItems|LaunchAgents)/i.test(c)
      || /\bosascript\b[\s\S]*login\s+item/i.test(c)
  },
  {
    id: 'applescript-shell',
    why: 'Runs a shell command through AppleScript, possibly as administrator.',
    test: (c) => /\bosascript\b[\s\S]*(do\s+shell\s+script|administrator\s+privileges)/i.test(c)
  },
  {
    id: 'find-exec',
    why: 'Runs a command or deletes files for every match.',
    test: (_c, argv) => findExecutes(argv)
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
    test: (c, argv) => (argv[0] === 'git' || argv[0]?.endsWith('/git') === true) && !isGitRead(argv)
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

const CREDENTIAL_PATH = new RegExp([
  String.raw`(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.azure|\.gcloud|\.bandit-keys|\.password-store|\.terraform\.d)([\\/]|$)`,
  String.raw`(^|[\\/])\.config[\\/](gcloud|gh|hub|op)([\\/]|$)`,
  String.raw`(^|[\\/])\.env(\.|$)`,
  String.raw`id_rsa|id_ed25519|id_ecdsa|id_dsa`,
  // `credentials`, `credentials.json`, `.credentials.json`, `credentials.yml` …
  String.raw`credentials(\.(json|ya?ml|toml|ini|txt|csv))?$`,
  // Shell / REPL / database histories hold pasted tokens and passwords.
  String.raw`(^|[\\/])\.?[a-z_]*_history$|(^|[\\/])\.lesshst$`,
  String.raw`(^|[\\/])(\.vault-token|\.pgpass|\.my\.cnf|\.boto|\.s3cfg|\.git-credentials|kubeconfig)$`,
  String.raw`(^|[\\/])\.bandit[\\/]config(\.local)?\.json$`,
  String.raw`(^|[\\/])\.m2[\\/]settings\.xml$|(^|[\\/])\.gradle[\\/]gradle\.properties$`,
  // Files named for what they hold, data extensions only (`token.ts` is code).
  String.raw`(^|[\\/])(secrets?|tokens?|passwords?|passwd|api[-_]?keys?|service[-_]?accounts?)\.(json|ya?ml|toml|ini|env|txt|cfg|conf|properties|xml|csv)$`,
  String.raw`(^|[\\/])etc[\\/](shadow|gshadow|master\.passwd)$`
].join('|'), 'i');

/**
 * Files that make code run later, or let someone else in: login shells'
 * rc files, launchd / cron / systemd / autostart entries, git hooks and
 * config (`core.hooksPath`, `core.sshCommand`, credential helpers),
 * `authorized_keys`, the Windows Startup folder. A write to one of these is
 * never routine, inside the workspace or out — a repository's own
 * `.git/hooks/pre-commit` runs on the user's next commit.
 */
const PERSISTENCE_PATH = new RegExp([
  String.raw`(^|[\\/])Library[\\/](LaunchAgents|LaunchDaemons|StartupItems)([\\/]|$)`,
  String.raw`(^|[\\/])\.config[\\/](autostart|systemd)([\\/]|$)`,
  String.raw`(^|[\\/])etc[\\/](cron\.d|cron\.daily|cron\.hourly|cron\.weekly|cron\.monthly|crontab|systemd|rc\.local|profile\.d|profile|sudoers|sudoers\.d|pam\.d|ld\.so\.preload|launchd\.conf|periodic)([\\/]|$)`,
  String.raw`(^|[\\/])var[\\/]spool[\\/]cron([\\/]|$)`,
  String.raw`(^|[\\/])\.(bashrc|zshrc|bash_profile|bash_login|bash_logout|zprofile|zshenv|zlogin|zlogout|profile|xinitrc|xsession|xprofile|gitconfig|git-credentials|hushlogin|mkshrc|kshrc|cshrc|tcshrc|config[\\/]fish[\\/]config\.fish)$`,
  // The whole .git directory, not only hooks/ and config: `info/attributes`
  // selects filter drivers, `index`/`HEAD`/`refs` rewrite history, and nothing
  // under .git/ is ever an ordinary source edit. Paths are normalized before
  // this regex runs, so `.git/./config`, `.git//hooks/x` and
  // `.git/info/../hooks/x` cannot slip past it (2026-11-25 audit).
  String.raw`(^|[\\/])\.git([\\/]|$)`,
  String.raw`(^|[\\/])\.husky([\\/]|$)`,
  // Agent, editor and shell-hook configuration the next session or command
  // reads: Bandit's own project settings, hooks and skills (a repository
  // cannot be allowed to grant itself auto mode or define a tool that runs a
  // command), Claude Code settings, MCP server lists, VS Code tasks and
  // launch configs, direnv, devcontainers, pre-commit / lefthook hook files.
  String.raw`(^|[\\/])\.bandit[\\/](settings[^\\/]*\.json|hooks[^\\/]*|skills|mcp-servers[^\\/]*)([\\/]|$)`,
  String.raw`(^|[\\/])\.claude[\\/]settings[^\\/]*\.json$`,
  String.raw`(^|[\\/])\.mcp\.json$`,
  String.raw`(^|[\\/])\.vscode[\\/](tasks|launch)\.json$`,
  String.raw`(^|[\\/])\.envrc$`,
  String.raw`(^|[\\/])\.devcontainer([\\/]|$)`,
  String.raw`(^|[\\/])(\.pre-commit-config\.ya?ml|lefthook(\.local)?\.ya?ml)$`,
  String.raw`authorized_keys2?$`,
  String.raw`(^|[\\/])\.ssh[\\/](config|rc|environment)$`,
  String.raw`Start Menu[\\/]Programs[\\/]Startup([\\/]|$)`
].join('|'), 'i');

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

function expandHome(rawPath: string, ctx: RiskContext): string {
  const home = ctx.homeDir ?? os.homedir();
  return rawPath.trim().replace(/^~(?=[\\/]|$)/, home);
}

/**
 * The spellings of a path the rule regexes must see. The model writes paths
 * the way it likes, and a rule that only reads the raw text is a rule the
 * model can step around: `.git/./config`, `.git//hooks/x` and
 * `.git/info/../hooks/x` all name files the `.git/` rule exists for, and
 * none of them matched it (2026-11-25 audit, auto mode ran the write). So
 * every rule gets the raw text, the lexically normalized form (`~` expanded,
 * backslashes to slashes, `.`/`..`/`//` folded) and, when a workspace is
 * known, the absolute form. A command line is normalized the same way; its
 * words are not path segments, so the fold only ever touches the path-like
 * runs inside it.
 */
function pathForms(raw: string, ctx: RiskContext): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const expanded = expandHome(trimmed, ctx).replace(/\\/g, '/');
  const forms = new Set<string>([trimmed, path.posix.normalize(expanded)]);
  if (ctx.workspaceRoot && !/\s/.test(trimmed)) {
    forms.add(path.resolve(ctx.workspaceRoot, expanded).replace(/\\/g, '/'));
  }
  return [...forms];
}

/**
 * Where a path really leads: the real path when it exists, and when it does
 * not, the final components are followed by hand so a dangling symlink still
 * resolves to its target's directory. Bounded; a failure to stat anything
 * returns the lexical resolution, which is what the check used before.
 */
function resolveThroughLinks(absolute: string, depth = 0): string {
  if (depth > 40) return absolute;
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    /* not (fully) on disk */
  }
  try {
    if (fs.lstatSync(absolute).isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      return resolveThroughLinks(path.resolve(path.dirname(absolute), target), depth + 1);
    }
  } catch {
    /* no entry: resolve the parent and keep this name */
  }
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  return path.join(resolveThroughLinks(parent, depth + 1), path.basename(absolute));
}

/**
 * 'outside' when the path names a place outside the workspace; 'symlink'
 * when it is spelled inside the workspace but a symlink planted there
 * (`notes.md -> ~/Library/LaunchAgents/x.plist`) makes it land outside; null
 * when it stays inside. Judged against the real root, because `/tmp` is
 * `/private/tmp` on macOS.
 */
function workspaceEscape(rawPath: string, ctx: RiskContext): 'outside' | 'symlink' | null {
  if (!ctx.workspaceRoot || !rawPath) return null;
  const expanded = expandHome(rawPath, ctx);
  const root = path.resolve(ctx.workspaceRoot);
  const resolved = path.resolve(root, expanded);
  const inside = (candidate: string, base: string): boolean =>
    candidate === base || candidate.startsWith(base + path.sep);
  if (!inside(resolved, root)) return 'outside';
  const realRoot = resolveThroughLinks(root);
  const realTarget = resolveThroughLinks(resolved);
  return inside(realTarget, realRoot) ? null : 'symlink';
}

function isOutsideWorkspace(rawPath: string, ctx: RiskContext): boolean {
  return workspaceEscape(rawPath, ctx) !== null;
}

/**
 * The narrow credential list applied to EVERY param, content included (the
 * long-standing behaviour: a write whose body ends in a credential path is
 * reviewed). The full CREDENTIAL_PATH list runs on location params only,
 * in every spelling, so a README that merely mentions `tokens.json` is not a
 * credential read.
 */
const CREDENTIAL_MENTION = /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc)(\/|$)|(^|\/)\.env(\.|$)|id_rsa|id_ed25519|credentials$/i;

/** Any param value that names a credential file (location params in every spelling). */
function touchesCredentials(params: Record<string, string>, ctx: RiskContext): boolean {
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string') continue;
    if (CREDENTIAL_MENTION.test(value)) return true;
    if (LOCATION_PARAMS.includes(key) && pathForms(value, ctx).some((f) => CREDENTIAL_PATH.test(f))) return true;
  }
  return false;
}

/** Params that name a location or a command line, as opposed to file
 *  content — a README that mentions `~/.bashrc` is not a write to it. */
const LOCATION_PARAMS = ['path', 'cwd', 'cmd', 'args', 'url', 'file', 'target', 'destination', 'dest'];

/** Any location-shaped param (or patch target) in a startup / login / git-hook place. */
function touchesPersistence(name: string, params: Record<string, string>, ctx: RiskContext): boolean {
  const values = LOCATION_PARAMS.map((k) => params[k]).filter((v): v is string => typeof v === 'string');
  if (name === 'apply_patch') values.push(...patchTargets(params));
  return values.some((v) => pathForms(v, ctx).some((f) => PERSISTENCE_PATH.test(f)));
}

/**
 * Flags that make a build, test or format tool run a program it was handed
 * rather than the project's own definition: `go test -exec`, `go build
 * -toolexec`, `prettier --plugin`, `eslint --rulesdir`, `vitest --require`,
 * `node --import`, `cargo --config target.x.runner=…`. The project's own
 * config (vitest.config.ts, .eslintrc) is project code the user opened and
 * stays routine; a program named on the command line is not.
 */
const EXEC_FLAG = /^-(?:exec|execdir|toolexec)(?:=|$)|^--(?:toolexec|exec|plugins?|rulesdir|require|loader|import|experimental-loader|config-loader|preload|eval|runner)(?:=|$)|^-e$/;
const CARGO_CONFIG_FLAG = /^(?:--config|-Z)(?:=|$)/;

function namesAProgramToRun(argv: string[]): boolean {
  const bin = argv[0] ?? '';
  if (argv.slice(1).some((a) => EXEC_FLAG.test(a))) return true;
  return bin === 'cargo' && argv.slice(1).some((a) => CARGO_CONFIG_FLAG.test(a));
}

/**
 * A recursive read (`grep -r`, `find`, `ls -R`) rooted at the home directory,
 * a user's folder, or the filesystem root: the shape of "search the machine
 * for keys", which no project task needs.
 */
function sweepsHomeOrRoot(argv: string[], ctx: RiskContext): boolean {
  const bin = argv[0] ?? '';
  const recursive = bin === 'find' || argv.slice(1).some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) || a === '--recursive' || a === '--dereference-recursive');
  if (!recursive) return false;
  const home = expandHome('~', ctx).replace(/[\\/]+$/, '');
  const roots = argv
    .slice(1)
    .filter((a) => a !== '--' && !a.startsWith('-'))
    .map((a) => expandHome(a.replace(/^['"]|['"]$/g, ''), ctx).replace(/\\/g, '/').replace(/\/+$/, ''));
  return roots.some((r) => r === '' || r === '/' || r === home || /^\/(Users|home)(\/[^/]+)?$/.test(r) || /^[A-Za-z]:$/.test(r));
}

/**
 * The paths a call writes. `path` for the single-file tools; for
 * `apply_patch` the targets named inside the patch body, which is where a
 * patch aimed at `~/.zshrc` or `../../Library/LaunchAgents/x.plist` would
 * otherwise hide from the outside-workspace check.
 */
function writeTargets(name: string, params: Record<string, string>): string[] {
  if (name === 'apply_patch') return patchTargets(params);
  const p = params.path ?? '';
  return p ? [p] : [];
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

    if (touchesCredentials(params, ctx)) {
      return { tier: 'critical', rule: 'credential-path', why: 'Touches a credentials or secrets file.' };
    }

    if (touchesPersistence(name, params, ctx)) {
      return { tier: 'critical', rule: 'persistence-path', why: 'Touches a file that runs at login, on a schedule, or on the next git command.' };
    }

    // Any file-touching tool aimed outside the workspace is critical
    // regardless of which tool it is — that is the boundary the user
    // actually reasons about.
    const escapes = writeTargets(name, params).map((p) => workspaceEscape(p, ctx));
    if (escapes.includes('symlink')) {
      // A distinct rule on purpose: hosts relax `outside-workspace` for
      // read tools (a read of ~/notes.md is the user's business), but a
      // path that LOOKS inside the project and secretly leaves it is never
      // relaxed — that is a planted link, not a user's choice.
      return { tier: 'critical', rule: 'symlink-escape', why: 'This path is a symbolic link that leads outside your project folder.' };
    }
    if (escapes.includes('outside')) {
      return { tier: 'critical', rule: 'outside-workspace', why: 'Writes outside your project folder.' };
    }

    if (name === 'delete_file') {
      return { tier: 'critical', rule: 'delete', why: 'Permanently deletes a file.' };
    }

    if (READ_ONLY_TOOLS.has(name)) {
      return { tier: 'routine', rule: 'read-only', why: 'Reads local state only.', readOnly: true };
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

    if (name === 'web_fetch' || name === 'web_search' || name === 'fetch_image') {
      // Not read-only: the request itself carries whatever the model put in
      // the URL or query to another host. Plan mode blocks it.
      return { tier: 'elevated', rule: 'network-read', why: 'Contacts another host. Anything in the address or query is sent to it.' };
    }

    if (name === 'git_push') {
      return { tier: 'elevated', rule: 'git-remote-write', why: "Sends your commits to the repository's git remote." };
    }

    if (name === 'git_pull' || name === 'git_fetch' || name === 'git_clone') {
      return { tier: 'elevated', rule: 'git-remote-read', why: 'Contacts a git remote and changes local repository state.' };
    }

    if (name === 'publish_artifact' || name === 'share_artifact' || name === 'email_artifact' || name === 'update_artifact') {
      return { tier: 'elevated', rule: 'cloud-publish', why: 'Saves to your Bandit Stash or shares a link others can open.' };
    }

    if (name === 'list_artifacts' || name === 'get_artifact') {
      // Reads the user's own Bandit Stash. Routine (auto mode
      // runs it) but not read-only: it is a network call, so plan mode blocks it.
      return { tier: 'routine', rule: 'cloud-read', why: 'Reads your Bandit Stash.' };
    }

    if (name === 'search_conversations' || name === 'read_conversation') {
      // The user's own synced Bandit chats, read from Bandit Cloud. Routine like
      // the Stash reads, and like them not read-only: the search words go to
      // the gateway, so plan mode blocks it.
      return { tier: 'routine', rule: 'cloud-read', why: 'Reads your own synced Bandit conversations from Bandit Cloud.' };
    }

    if (name === 'generate_image') {
      return { tier: 'elevated', rule: 'cloud-generate', why: 'Sends the image prompt to Bandit Cloud.' };
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
        return isGitRead(argv)
          ? { tier: 'routine', rule: 'git-read', why: 'Reads git state.', readOnly: true }
          : { tier: 'elevated', rule: 'git-state-change', why: 'Changes git state in this repository.' };
      }
      // A build or test run executes whatever that directory's project
      // defines. Inside the workspace that is the project the user opened;
      // in another directory it is somebody else's code, so it is not routine.
      const cwdOutside = !!params.cwd && isOutsideWorkspace(params.cwd, ctx);
      const allowedSubs = ROUTINE_SUBCOMMANDS[bin];
      // A build/test/format tool told to run a program it was handed is
      // whatever that program is, not "the project's tests".
      if ((allowedSubs || ROUTINE_COMMANDS.has(bin)) && !READ_ONLY_COMMANDS.has(bin) && namesAProgramToRun(argv)) {
        return { tier: 'elevated', rule: 'exec-flag', why: 'Runs a program named on the command line, not just the project\'s own build or tests.' };
      }
      if (allowedSubs) {
        if (allowedSubs.has(sub) && cwdOutside) {
          return { tier: 'elevated', rule: 'outside-workspace-cwd', why: 'Runs a build or test step in a directory outside your project folder.' };
        }
        return allowedSubs.has(sub)
          ? { tier: 'routine', rule: 'build-or-test', why: 'Builds or tests this project.' }
          : { tier: 'elevated', rule: 'package-manager', why: `Runs \`${bin} ${sub}\`, which can change project state.` };
      }
      if (READ_ONLY_COMMANDS.has(bin)) {
        if (readOnlyCommandWrites(argv)) {
          return { tier: 'elevated', rule: 'in-place-edit', why: 'Rewrites files in place.' };
        }
        // Reads elsewhere stay routine (hosts decide how to treat reads
        // outside the workspace), except a sweep of the whole home directory
        // or disk: `grep -r token ~` is how a prompt-injected turn hunts for
        // secrets, not how a user's project is inspected.
        if (sweepsHomeOrRoot(argv, ctx)) {
          return { tier: 'elevated', rule: 'home-wide-read', why: 'Searches your whole home directory or disk, not the project.', readOnly: true };
        }
        return { tier: 'routine', rule: 'read-only-command', why: 'Inspects files or state without changing them.', readOnly: true };
      }
      if (ROUTINE_COMMANDS.has(bin)) {
        if (bin === 'find' && sweepsHomeOrRoot(argv, ctx)) {
          return { tier: 'elevated', rule: 'home-wide-read', why: 'Searches your whole home directory or disk, not the project.' };
        }
        if (cwdOutside) {
          return { tier: 'elevated', rule: 'outside-workspace-cwd', why: 'Runs a build or test step in a directory outside your project folder.' };
        }
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
    // Only a namespaced name (`server.tool`, `mcp__server__tool`) is an MCP
    // tool. A bare `get_project_info` is a tool a workspace manifest
    // (.bandit/skills/*.json) declared, and a manifest can make it run any
    // command; "the name says read" is no reason to run that unattended
    // (2026-11-25 audit).
    if (bare !== name && /^(list|get|search|read|find|fetch|query|describe)[A-Z_]/.test(bare)) {
      // The name says "read", but Bandit cannot see what the server does with
      // the call (a fetch_* tool can send its arguments anywhere). Only a
      // server the user declared local (`"local": true`) counts as read-only
      // for plan mode; the tier stays routine so auto mode is unchanged.
      return isKnownLocalMcpTool(name)
        ? { tier: 'routine', rule: 'mcp-read', why: 'Reads from a local connected service.', readOnly: true }
        : { tier: 'routine', rule: 'mcp-read', why: 'Reads from a connected service. Its arguments are sent to that service.' };
    }

    return { tier: 'elevated', rule: 'unknown-tool', why: 'Bandit is asking before using this capability.' };
  } catch {
    // A classifier crash must not become an auto-approval.
    return { tier: 'critical', rule: 'classifier-error', why: 'Could not assess this call, so it requires review.' };
  }
}

/**
 * Tool context for eval runs: the real CLI context, confined to the run's sandbox.
 *
 * Each run gets a throwaway directory tree:
 *
 *   <root>/                      confinement boundary — nothing outside is reachable
 *   <root>/home/                 the run's home directory: `~` resolves here
 *   <root>/home/projects/app/    the workspace (tool cwd); the only place writes may land
 *
 * The product prompt tells the model it may look outside the workspace (`~/Downloads`,
 * a sibling repo), so a fixture that tests that provisions the files under the sandbox
 * home (`setup.homeFiles`, `setup.gitRepos`) and the model reaches them with the same
 * calls it would use for real. The real home directory is never read.
 *
 * Evals are non-interactive, so nothing may wait for an approval. Two things are refused
 * immediately with an explanatory tool error and recorded in `denials`:
 *   - any access outside the sandbox root (an invented `/workspace`, `/etc/…`, a
 *     memorized `/Users/<name>/…` checkout);
 *   - a write or delete outside the workspace, even under the sandbox home (a model that
 *     edits `~/Documents/GitHub/<repo>/sample.ts` instead of `sample.ts`).
 * The runner decides what a denial means for the run; see `isSandboxViolation`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ILanguageAdapterRegistry } from '@burtson-labs/agent-core';
import { CliToolExecutionContext } from '../cliToolContext';

export class SandboxDeniedError extends Error {}

export type SandboxAccessKind = 'read' | 'write' | 'delete' | 'list' | 'search' | 'run' | 'run argument';

export interface SandboxDenial {
  kind: SandboxAccessKind;
  /** The path exactly as the model wrote it. */
  path: string;
}

export interface EvalSandboxLayout {
  /** Confinement boundary (real path, symlinks resolved). */
  root: string;
  /** The run's home directory — `~` in tool arguments and HOME for spawned commands. */
  home: string;
  /** Tool working directory. */
  workspace: string;
}

/** Workspace location relative to the sandbox home; matches the stable path traces use. */
export const SANDBOX_WORKSPACE_REL = path.join('projects', 'app');

/**
 * Create the directory tree for one run. The root is resolved to its real path so a tool
 * that reports `/private/var/…` (macOS) and one that reports `/var/…` agree on what is
 * inside.
 */
export async function createSandboxLayout(prefix: string): Promise<EvalSandboxLayout> {
  const created = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  const root = await fs.promises.realpath(created);
  const home = path.join(root, 'home');
  const workspace = path.join(home, SANDBOX_WORKSPACE_REL);
  await fs.promises.mkdir(workspace, { recursive: true });
  return { root, home, workspace };
}

/** Writing or deleting outside the workspace is the one denial that fails a run by itself. */
export function isSandboxViolation(denial: SandboxDenial): boolean {
  return denial.kind === 'write' || denial.kind === 'delete';
}

export function describeDenial(denial: SandboxDenial): string {
  return `${denial.kind} ${denial.path}`;
}

const SENSITIVE_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY)/i;

/**
 * Environment for commands a model runs inside the sandbox: HOME is the sandbox home, git
 * cannot discover a repository above the sandbox and has a fixed identity, and host
 * credentials in the environment are not passed on.
 */
export function sandboxEnv(layout: EvalSandboxLayout, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(base)) {
    if (SENSITIVE_ENV.test(key)) env[key] = undefined;
  }
  return {
    ...env,
    HOME: layout.home,
    USERPROFILE: layout.home,
    GIT_CEILING_DIRECTORIES: layout.root,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'BanditBench',
    GIT_AUTHOR_EMAIL: 'banditbench@example.invalid',
    GIT_COMMITTER_NAME: 'BanditBench',
    GIT_COMMITTER_EMAIL: 'banditbench@example.invalid',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false'
  };
}

/** Resolve symlinks in the deepest existing ancestor, so a not-yet-created file still canonicalizes. */
function canonicalize(absolute: string): string {
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export class EvalSandboxContext extends CliToolExecutionContext {
  readonly denials: SandboxDenial[] = [];
  readonly layout: EvalSandboxLayout;

  constructor(layout: EvalSandboxLayout, adapters: ILanguageAdapterRegistry) {
    super(layout.workspace, adapters, { env: sandboxEnv(layout) });
    this.layout = layout;
  }

  /** `~` is the sandbox home, never the real one. */
  private expand(p: string): string {
    if (p === '~') return this.layout.home;
    if (p.startsWith('~/')) return path.join(this.layout.home, p.slice(2));
    return p;
  }

  /**
   * Resolve like the CLI does (expand `~`, relative to the workspace) and refuse what the
   * sandbox does not allow: writes/deletes outside the workspace, anything outside the root.
   */
  confine(p: string | undefined, kind: SandboxAccessKind): string {
    const raw = p ?? this.workspaceRoot;
    const resolved = canonicalize(path.resolve(this.workspaceRoot, this.expand(raw)));
    const mutates = kind === 'write' || kind === 'delete';
    const boundary = mutates ? this.workspaceRoot : this.layout.root;
    if (resolved !== boundary && !resolved.startsWith(boundary + path.sep)) {
      this.denials.push({ kind, path: raw });
      throw new SandboxDeniedError(
        `Permission denied: ${raw} is outside the workspace (${kind}). This is a non-interactive run, so ` +
        `${mutates ? 'changing files' : 'access'} outside the workspace is refused automatically. ` +
        `The working directory is ${this.workspaceRoot}; use a path relative to the workspace root, e.g. "src/app.ts".`
      );
    }
    return resolved;
  }

  override markFileRead(absolutePath: string): void {
    super.markFileRead(canonicalize(path.resolve(this.workspaceRoot, this.expand(absolutePath))));
  }

  override hasFileBeenRead(absolutePath: string): boolean {
    return super.hasFileBeenRead(canonicalize(path.resolve(this.workspaceRoot, this.expand(absolutePath))));
  }

  override async readFile(absolutePath: string): Promise<string> {
    return super.readFile(this.confine(absolutePath, 'read'));
  }

  override async writeFile(absolutePath: string, content: string): Promise<void> {
    return super.writeFile(this.confine(absolutePath, 'write'), content);
  }

  override async deleteFile(absolutePath: string): Promise<void> {
    return super.deleteFile(this.confine(absolutePath, 'delete'));
  }

  override async listFiles(pattern: string, cwd?: string): Promise<string[]> {
    return super.listFiles(pattern, this.confine(cwd, 'list'));
  }

  override async listDirectoryEntries(cwd: string): Promise<string[]> {
    return super.listDirectoryEntries(this.confine(cwd, 'list'));
  }

  override async searchCode(pattern: string, cwd?: string, fileGlob?: string): Promise<string> {
    return super.searchCode(pattern, this.confine(cwd, 'search'), fileGlob);
  }

  /**
   * Path-shaped arguments must stay in the sandbox too: `~/x` becomes the sandbox home, and
   * an absolute path elsewhere (`/Users/n/x`, `/tmp/other`, `/workspace`) is refused.
   */
  private confineArgs(args: string[]): string[] {
    return args.map(arg => {
      if (arg === '~' || arg.startsWith('~/')) return this.confine(arg, 'run argument');
      if (path.isAbsolute(arg) && arg !== '/dev/null') return this.confine(arg, 'run argument');
      return arg;
    });
  }

  override async runCommand(cmd: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return super.runCommand(cmd, this.confineArgs(args), this.confine(cwd, 'run'));
  }

  override async watchCommand(cmd: string, args: string[], cwd: string | undefined, durationMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; endedEarly: boolean }> {
    return super.watchCommand(cmd, this.confineArgs(args), this.confine(cwd, 'run'), durationMs);
  }
}

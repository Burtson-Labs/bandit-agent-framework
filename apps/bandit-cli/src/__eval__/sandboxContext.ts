/**
 * Tool context for eval runs: the real CLI context, confined to the run's sandbox.
 *
 * Evals are non-interactive, so nothing may wait for an approval. Any access outside the
 * sandbox (a model reaching for a path it memorized, `~/…`, an absolute path elsewhere) is
 * denied immediately with an explanatory tool error, recorded, and reported as a failure
 * reason. This also guarantees an eval can never read or modify real files on the host.
 */
import * as path from 'path';
import type { ILanguageAdapterRegistry } from '@burtson-labs/agent-core';
import { CliToolExecutionContext, expandHome } from '../cliToolContext';

export class SandboxDeniedError extends Error {}

export class EvalSandboxContext extends CliToolExecutionContext {
  readonly denials: string[] = [];

  constructor(sandbox: string, adapters: ILanguageAdapterRegistry) {
    super(sandbox, adapters);
  }

  /** Resolve like the CLI does (expand `~`, relative to the sandbox) and refuse anything outside. */
  confine(p: string | undefined, what: string): string {
    const raw = p ?? this.workspaceRoot;
    const resolved = path.resolve(this.workspaceRoot, expandHome(raw));
    const root = path.resolve(this.workspaceRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      const note = `${what} ${raw}`;
      this.denials.push(note);
      throw new SandboxDeniedError(
        `Permission denied: ${raw} is outside the workspace (${what}). This is a non-interactive run, so ` +
        'access outside the workspace is refused automatically. Use a path relative to the workspace root, e.g. "src/app.ts".'
      );
    }
    return resolved;
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

  /** Home-relative or user-home absolute arguments (`~/x`, `/Users/n/x`) must stay in the sandbox too. */
  private confineArgs(args: string[]): string[] {
    for (const a of args) {
      if (/^(?:~(?:\/|$)|\/Users\/|\/home\/)/.test(a)) this.confine(a, 'run argument');
    }
    return args;
  }

  override async runCommand(cmd: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return super.runCommand(cmd, this.confineArgs(args), this.confine(cwd, 'run'));
  }

  override async watchCommand(cmd: string, args: string[], cwd: string | undefined, durationMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; endedEarly: boolean }> {
    return super.watchCommand(cmd, this.confineArgs(args), this.confine(cwd, 'run'), durationMs);
  }
}

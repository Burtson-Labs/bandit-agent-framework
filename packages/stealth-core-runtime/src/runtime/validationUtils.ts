import * as path from 'path';
import type { ValidationOutcome } from '../internalTypes';
import type { IShellAdapter } from '../internalTypes';

export interface ValidationUtilsDeps {
  shellAdapter: IShellAdapter;
  pathExists(target: string): Promise<boolean>;
  getWorkspaceRoot(): string;
}

export function createValidationUtils(deps: ValidationUtilsDeps) {
  async function findTsConfigFile(): Promise<string | undefined> {
    const root = deps.getWorkspaceRoot();
    const candidates = [
      'tsconfig.json',
      'tsconfig.base.json',
      'tsconfig.build.json',
      'tsconfig.prod.json',
      'jsconfig.json'
    ];
    for (const candidate of candidates) {
      const absolute = path.join(root, candidate);
      if (await deps.pathExists(absolute)) {
        return absolute;
      }
    }
    return undefined;
  }

  async function buildTypeScriptValidationCommands(args: string[]): Promise<Array<{ command: string; args: string[] }>> {
    const commands: Array<{ command: string; args: string[] }> = [];
    const local = await resolveLocalBinary('tsc');
    if (local) {
      commands.push({ command: local, args });
    }
    commands.push({ command: getCommandName('pnpm'), args: ['exec', 'tsc', ...args] });
    commands.push({ command: getCommandName('npx'), args: ['tsc', ...args] });
    commands.push({ command: getCommandName('yarn'), args: ['tsc', ...args] });
    commands.push({ command: getCommandName('tsc'), args });
    return commands;
  }

  async function resolveLocalBinary(name: string): Promise<string | undefined> {
    const root = deps.getWorkspaceRoot();
    const suffix = process.platform === 'win32' ? '.cmd' : '';
    const candidate = path.join(root, 'node_modules', '.bin', `${name}${suffix}`);
    if (await deps.pathExists(candidate)) {
      return candidate;
    }
    return undefined;
  }

  function getCommandName(base: string): string {
    if (process.platform === 'win32') {
      return `${base}.cmd`;
    }
    return base;
  }

  async function spawnValidationProcess(command: string, args: string[], cwd: string): Promise<ValidationOutcome> {
    try {
      const result = await deps.shellAdapter.run(command, args, { cwd });
      const trimmedStdout = result.stdout.trim();
      const trimmedStderr = result.stderr.trim();
      if (result.code === 0) {
        return {
          ok: true,
          output: trimmedStdout,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.code ?? 0
        };
      }
      const message = trimmedStderr || trimmedStdout || `Validation failed (code ${result.code ?? 0}).`;
      return {
        ok: false,
        error: message,
        output: trimmedStdout,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code ?? undefined
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return {
    findTsConfigFile,
    buildTypeScriptValidationCommands,
    spawnValidationProcess,
    getCommandName
  };
}

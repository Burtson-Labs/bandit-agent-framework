/**
 * Contract tests for createValidationUtils — wraps the
 * "find tsconfig + build tsc command list + spawn process" plumbing
 * the runtime uses for post-edit TypeScript validation. Zero coverage
 * before .
 *
 * Pinned contracts:
 * - tsconfig probe order: tsconfig.json → tsconfig.base.json →
 * tsconfig.build.json → tsconfig.prod.json → jsconfig.json
 * - Command fallback order: local node_modules/.bin/tsc →
 * pnpm exec → npx → yarn → bare tsc on PATH
 * - Windows command-name suffix (.cmd) on win32 only
 * - spawnValidationProcess returns ValidationOutcome with structured
 * stdout/stderr/exitCode regardless of success/failure path
 */
import { describe, expect, it } from 'vitest';
import { createValidationUtils } from '../src/runtime/validationUtils';
import type { IShellAdapter } from '../src/hostTypes';

interface ShellCall { command: string; args: string[]; cwd?: string }

function buildDeps(opts: {
  existing?: Set<string>;
  shellResponses?: Array<{ code: number; stdout?: string; stderr?: string }>;
  workspaceRoot?: string;
} = {}) {
  const calls: ShellCall[] = [];
  let respIdx = 0;
  const shell: IShellAdapter = {
    async run(command, args, options) {
      calls.push({ command, args, cwd: options?.cwd });
      const r = opts.shellResponses?.[respIdx++] ?? { code: 0 };
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
  };
  return {
    deps: {
      shellAdapter: shell,
      async pathExists(target: string) {
        return opts.existing?.has(target) ?? false;
      },
      getWorkspaceRoot() {
        return opts.workspaceRoot ?? '/repo';
      }
    },
    calls
  };
}

describe('createValidationUtils — findTsConfigFile', () => {
  it('returns tsconfig.json when it exists (preferred over fallbacks)', async () => {
    const { deps } = buildDeps({
      existing: new Set(['/repo/tsconfig.json', '/repo/tsconfig.base.json'])
    });
    const utils = createValidationUtils(deps);
    expect(await utils.findTsConfigFile()).toBe('/repo/tsconfig.json');
  });

  it('falls back to tsconfig.base.json when tsconfig.json is absent', async () => {
    const { deps } = buildDeps({ existing: new Set(['/repo/tsconfig.base.json']) });
    const utils = createValidationUtils(deps);
    expect(await utils.findTsConfigFile()).toBe('/repo/tsconfig.base.json');
  });

  it('falls through to tsconfig.build.json, then prod, then jsconfig in order', async () => {
    const { deps: depsBuild } = buildDeps({ existing: new Set(['/repo/tsconfig.build.json']) });
    expect(await createValidationUtils(depsBuild).findTsConfigFile()).toBe('/repo/tsconfig.build.json');

    const { deps: depsProd } = buildDeps({ existing: new Set(['/repo/tsconfig.prod.json']) });
    expect(await createValidationUtils(depsProd).findTsConfigFile()).toBe('/repo/tsconfig.prod.json');

    const { deps: depsJs } = buildDeps({ existing: new Set(['/repo/jsconfig.json']) });
    expect(await createValidationUtils(depsJs).findTsConfigFile()).toBe('/repo/jsconfig.json');
  });

  it('returns undefined when none of the candidates exist', async () => {
    const { deps } = buildDeps({});
    const utils = createValidationUtils(deps);
    expect(await utils.findTsConfigFile()).toBeUndefined();
  });
});

describe('createValidationUtils — buildTypeScriptValidationCommands', () => {
  it('includes the local node_modules/.bin/tsc as the FIRST option when present', async () => {
    const { deps } = buildDeps({
      existing: new Set([
        process.platform === 'win32'
          ? '/repo/node_modules/.bin/tsc.cmd'
          : '/repo/node_modules/.bin/tsc'
      ])
    });
    const utils = createValidationUtils(deps);
    const commands = await utils.buildTypeScriptValidationCommands(['--noEmit']);
    expect(commands[0].command).toContain('.bin');
    expect(commands[0].args).toEqual(['--noEmit']);
  });

  it('falls back to package-manager-mediated tsc when local binary is absent', async () => {
    const { deps } = buildDeps({}); // no local binary
    const utils = createValidationUtils(deps);
    const commands = await utils.buildTypeScriptValidationCommands(['--noEmit']);
    // Command name strings (with optional .cmd suffix on win32).
    const names = commands.map((c) => c.command);
    expect(names.some((n) => n.startsWith('pnpm'))).toBe(true);
    expect(names.some((n) => n.startsWith('npx'))).toBe(true);
    expect(names.some((n) => n.startsWith('yarn'))).toBe(true);
    expect(names.some((n) => n.startsWith('tsc'))).toBe(true);
    // pnpm/npx/yarn forms inject `tsc` into args; bare tsc keeps args as-is.
    const pnpmCmd = commands.find((c) => c.command.startsWith('pnpm'))!;
    expect(pnpmCmd.args).toEqual(['exec', 'tsc', '--noEmit']);
    const npxCmd = commands.find((c) => c.command.startsWith('npx'))!;
    expect(npxCmd.args).toEqual(['tsc', '--noEmit']);
    const bareCmd = commands.find((c) => c.command === 'tsc' || c.command === 'tsc.cmd')!;
    expect(bareCmd.args).toEqual(['--noEmit']);
  });

  it('local-bin path uses the .cmd suffix on win32 only', async () => {
    // We can't toggle process.platform mid-test reliably across vitest
    // versions, so this asserts the current platform's behavior and
    // documents that the suffix is platform-conditional. Resolves to
    // `.cmd` on win32 runners, no suffix everywhere else.
    const { deps } = buildDeps({});
    const utils = createValidationUtils(deps);
    const commands = await utils.buildTypeScriptValidationCommands([]);
    const bare = commands.find((c) => c.args.length === 0);
    expect(bare?.command).toBe(process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  });
});

describe('createValidationUtils — spawnValidationProcess', () => {
  it('returns ok=true and surfaces stdout when exitCode is 0', async () => {
    const { deps, calls } = buildDeps({
      shellResponses: [{ code: 0, stdout: 'Compilation OK\n' }]
    });
    const utils = createValidationUtils(deps);
    const outcome = await utils.spawnValidationProcess('tsc', ['--noEmit'], '/repo');
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toBe('Compilation OK');
    expect(outcome.stdout).toBe('Compilation OK\n');
    expect(outcome.exitCode).toBe(0);
    expect(calls[0].cwd).toBe('/repo');
  });

  it('returns ok=false with stderr-derived error when exitCode is non-zero', async () => {
    const { deps } = buildDeps({
      shellResponses: [{ code: 2, stderr: 'TS2304: Cannot find name \'foo\'.\n' }]
    });
    const utils = createValidationUtils(deps);
    const outcome = await utils.spawnValidationProcess('tsc', [], '/repo');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/TS2304/);
    expect(outcome.exitCode).toBe(2);
  });

  it('falls back to stdout when stderr is empty but exitCode is non-zero', async () => {
    const { deps } = buildDeps({
      shellResponses: [{ code: 1, stdout: 'something useful', stderr: '' }]
    });
    const utils = createValidationUtils(deps);
    const outcome = await utils.spawnValidationProcess('tsc', [], '/repo');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('something useful');
  });

  it('falls back to "Validation failed (code N)" message when both streams are empty', async () => {
    const { deps } = buildDeps({
      shellResponses: [{ code: 99 }]
    });
    const utils = createValidationUtils(deps);
    const outcome = await utils.spawnValidationProcess('tsc', [], '/repo');
    expect(outcome.error).toMatch(/code 99/);
  });

  it('catches thrown errors from the shell adapter and returns ok=false', async () => {
    const failingShell: IShellAdapter = {
      async run() { throw new Error('ENOENT: tsc not on PATH'); }
    };
    const utils = createValidationUtils({
      shellAdapter: failingShell,
      async pathExists() { return false; },
      getWorkspaceRoot() { return '/repo'; }
    });
    const outcome = await utils.spawnValidationProcess('tsc', [], '/repo');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/ENOENT/);
    // Defensive: no exitCode field on the thrown path (we couldn't get one).
    expect(outcome.exitCode).toBeUndefined();
  });
});

describe('createValidationUtils — getCommandName', () => {
  it('returns the bare base name on POSIX, base.cmd on win32', () => {
    const { deps } = buildDeps({});
    const utils = createValidationUtils(deps);
    expect(utils.getCommandName('pnpm')).toBe(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  });
});

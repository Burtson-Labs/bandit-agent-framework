/**
 * Contract tests for test_run — framework detection, command building,
 * output parsing, and the agent-tool wrapper. The tool shells out to
 * real runners so we keep the unit tests on the deterministic surface
 * (detection logic + output parsing on captured fixture strings) and
 * use a stub ctx for the end-to-end wrapper test.
 *
 * Why pin: this tool is the closeable side of a "fix-test-rerun" loop.
 * If detection regresses to `null` for a project that actually has
 * vitest, the agent loses TDD capability silently. If the summary
 * parser drifts off the framework's actual headline format, the
 * agent's fix-it loop sees `0 passed, 0 failed` and concludes the
 * suite is empty — worse than a clear failure.
 */
import { describe, expect, it } from 'vitest';
import {
  detectTestFramework,
  buildTestCommand,
  parseTestOutput,
  buildTestRunTool
} from '../src/tools/testRunTool';
import type { ToolExecutionContext } from '@burtson-labs/agent-core';

/** Build a tiny in-memory ctx — readFile/listFiles/runCommand driven by maps. */
function buildCtx(opts: {
  files?: Record<string, string>;
  listFiles?: Record<string, string[]>;
  runCommand?: (cmd: string, args: string[], cwd?: string) => { stdout: string; stderr: string; exitCode: number };
} = {}): ToolExecutionContext {
  return {
    workspaceRoot: '/repo',
    async readFile(absPath: string) {
      if (!opts.files || !(absPath in opts.files)) throw new Error('ENOENT');
      return opts.files[absPath];
    },
    async writeFile() { return; },
    async listFiles(pattern: string, cwd?: string) {
      const key = `${cwd ?? '/repo'}::${pattern}`;
      return opts.listFiles?.[key] ?? [];
    },
    async searchCode() { return ''; },
    async runCommand(cmd: string, args: string[], cwd?: string) {
      if (!opts.runCommand) return { stdout: '', stderr: '', exitCode: 0 };
      return opts.runCommand(cmd, args, cwd);
    }
  };
}

describe('detectTestFramework', () => {
  it('returns vitest when devDependencies has vitest', async () => {
    const ctx = buildCtx({
      files: { '/repo/package.json': JSON.stringify({ devDependencies: { vitest: '^4.0.0' } }) }
    });
    expect(await detectTestFramework(ctx, '/repo')).toBe('vitest');
  });

  it('returns jest when devDependencies has jest', async () => {
    const ctx = buildCtx({
      files: { '/repo/package.json': JSON.stringify({ devDependencies: { jest: '^29.0.0' } }) }
    });
    expect(await detectTestFramework(ctx, '/repo')).toBe('jest');
  });

  it('prefers vitest over jest when both are declared (vitest is more common in 2026)', async () => {
    const ctx = buildCtx({
      files: { '/repo/package.json': JSON.stringify({ devDependencies: { vitest: '^4.0.0', jest: '^29.0.0' } }) }
    });
    expect(await detectTestFramework(ctx, '/repo')).toBe('vitest');
  });

  it('falls back to npm-script when package.json has a test script but no recognized framework dep', async () => {
    const ctx = buildCtx({
      files: { '/repo/package.json': JSON.stringify({ scripts: { test: 'mocha' } }) }
    });
    expect(await detectTestFramework(ctx, '/repo')).toBe('npm-script');
  });

  it('finds vitest via config file when package.json is absent', async () => {
    const ctx = buildCtx({
      files: { '/repo/vitest.config.ts': 'export default {}' }
    });
    expect(await detectTestFramework(ctx, '/repo')).toBe('vitest');
  });

  it('returns pytest when pyproject.toml is present', async () => {
    const ctx = buildCtx({
      files: { '/repo/pyproject.toml': '[tool.pytest.ini_options]\n' }
    });
    expect(await detectTestFramework(ctx, '/repo')).toBe('pytest');
  });

  it('returns go when go.mod is present', async () => {
    const ctx = buildCtx({
      files: { '/repo/go.mod': 'module example.com/foo\n' }
    });
    expect(await detectTestFramework(ctx, '/repo')).toBe('go');
  });

  it('returns cargo when Cargo.toml is present', async () => {
    const ctx = buildCtx({
      files: { '/repo/Cargo.toml': '[package]\nname = "foo"\n' }
    });
    expect(await detectTestFramework(ctx, '/repo')).toBe('cargo');
  });

  it('returns dotnet when a .sln file is present', async () => {
    const ctx = buildCtx({
      listFiles: { '/repo::*.sln': ['/repo/MyApp.sln'] }
    });
    expect(await detectTestFramework(ctx, '/repo')).toBe('dotnet');
  });

  it('returns null when nothing matches', async () => {
    const ctx = buildCtx({});
    expect(await detectTestFramework(ctx, '/repo')).toBeNull();
  });

  it('tolerates malformed package.json without throwing', async () => {
    const ctx = buildCtx({
      files: { '/repo/package.json': 'not { valid json' }
    });
    // Falls through to the non-JS framework probes, none match → null.
    expect(await detectTestFramework(ctx, '/repo')).toBeNull();
  });
});

describe('buildTestCommand', () => {
  it('vitest run with optional pattern', () => {
    expect(buildTestCommand('vitest')).toEqual({ cmd: 'npx', args: ['vitest', 'run'] });
    expect(buildTestCommand('vitest', 'foo.test.ts')).toEqual({ cmd: 'npx', args: ['vitest', 'run', 'foo.test.ts'] });
  });

  it('jest --ci with optional pattern', () => {
    expect(buildTestCommand('jest')).toEqual({ cmd: 'npx', args: ['jest', '--ci'] });
    expect(buildTestCommand('jest', 'auth')).toEqual({ cmd: 'npx', args: ['jest', '--ci', 'auth'] });
  });

  it('pytest -q with -k pattern flag', () => {
    expect(buildTestCommand('pytest')).toEqual({ cmd: 'pytest', args: ['-q'] });
    expect(buildTestCommand('pytest', 'login')).toEqual({ cmd: 'pytest', args: ['-q', '-k', 'login'] });
  });

  it('go test ./... with -run for pattern', () => {
    expect(buildTestCommand('go')).toEqual({ cmd: 'go', args: ['test', './...'] });
    expect(buildTestCommand('go', 'TestX')).toEqual({ cmd: 'go', args: ['test', '-run', 'TestX', './...'] });
  });

  it('cargo test passes pattern positionally', () => {
    expect(buildTestCommand('cargo')).toEqual({ cmd: 'cargo', args: ['test'] });
    expect(buildTestCommand('cargo', 'foo')).toEqual({ cmd: 'cargo', args: ['test', 'foo'] });
  });

  it('dotnet test with --filter for pattern', () => {
    const r = buildTestCommand('dotnet', 'MyTest');
    expect(r.cmd).toBe('dotnet');
    expect(r.args).toContain('--filter');
    expect(r.args).toContain('MyTest');
  });

  it('npm-script ignores pattern (no standard flag)', () => {
    expect(buildTestCommand('npm-script', 'whatever')).toEqual({ cmd: 'npm', args: ['test', '--silent'] });
  });
});

describe('parseTestOutput', () => {
  it('parses vitest all-pass summary', () => {
    const out = `
 ✓ test/foo.test.ts (5)
 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  10:23:11
   Duration  234ms
`;
    expect(parseTestOutput('vitest', out, '')).toMatchObject({
      passed: 5,
      failed: 0,
      failureNames: []
    });
  });

  it('parses vitest with failures', () => {
    const out = `
FAIL test/foo.test.ts > should do X
FAIL test/bar.test.ts > deeper > should do Y
 Test Files  2 failed | 0 passed (2)
      Tests  2 failed | 3 passed (5)
`;
    const r = parseTestOutput('vitest', out, '');
    expect(r.passed).toBe(3);
    expect(r.failed).toBe(2);
    expect(r.failureNames.length).toBeGreaterThan(0);
    expect(r.failureNames[0]).toMatch(/foo\.test\.ts/);
  });

  it('parses jest with failures', () => {
    const out = `
Test Suites: 1 failed, 1 passed, 2 total
Tests:       2 failed, 8 passed, 10 total
  ● Auth › rejects bad password
  ● Auth › expires session
`;
    const r = parseTestOutput('jest', out, '');
    expect(r.passed).toBe(8);
    expect(r.failed).toBe(2);
    expect(r.failureNames).toHaveLength(2);
    expect(r.failureNames[0]).toContain('Auth');
  });

  it('parses pytest with failures', () => {
    const out = `
test_foo.py::test_one PASSED
test_foo.py::test_two FAILED
======== 1 failed, 1 passed in 0.05s ========
FAILED test_foo.py::test_two
`;
    const r = parseTestOutput('pytest', out, '');
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.failureNames[0]).toContain('test_two');
  });

  it('parses go test failures', () => {
    const out = `
--- FAIL: TestA (0.00s)
    foo_test.go:15: expected 1 got 2
--- PASS: TestB (0.00s)
--- PASS: TestC (0.00s)
FAIL
`;
    const r = parseTestOutput('go', out, '');
    expect(r.failed).toBe(1);
    expect(r.passed).toBe(2);
    expect(r.failureNames).toEqual(['TestA']);
  });

  it('parses cargo test summary', () => {
    const out = `
running 3 tests
test foo::test_a ... ok
test foo::test_b ... FAILED
test foo::test_c ... ok
test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out
`;
    const r = parseTestOutput('cargo', out, '');
    expect(r.passed).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.failureNames[0]).toContain('foo::test_b');
  });

  it('parses dotnet test summary', () => {
    const out = `Passed!  - Failed:     0, Passed:    42, Skipped:     1, Total:    43`;
    const r = parseTestOutput('dotnet', out, '');
    expect(r.passed).toBe(42);
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('returns empty summary for npm-script (no parser)', () => {
    const r = parseTestOutput('npm-script', 'whatever output', '');
    expect(r.passed).toBeUndefined();
    expect(r.failed).toBeUndefined();
    expect(r.failureNames).toEqual([]);
  });
});

describe('buildTestRunTool execute', () => {
  it('reports framework + cwd + summary in the output', async () => {
    const ctx = buildCtx({
      files: { '/repo/package.json': JSON.stringify({ devDependencies: { vitest: '^4' } }) },
      runCommand: () => ({
        stdout: '\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n',
        stderr: '',
        exitCode: 0
      })
    });
    const tool = buildTestRunTool();
    const result = await tool.execute({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/PASS · vitest in \./);
    expect(result.output).toMatch(/3 passed/);
  });

  it('flags isError=true on non-zero exit AND surfaces failure names', async () => {
    const ctx = buildCtx({
      files: { '/repo/package.json': JSON.stringify({ devDependencies: { vitest: '^4' } }) },
      runCommand: () => ({
        stdout: 'FAIL test/auth.test.ts > should reject bad token\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n',
        stderr: '',
        exitCode: 1
      })
    });
    const tool = buildTestRunTool();
    const result = await tool.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/FAIL · vitest/);
    expect(result.output).toMatch(/1 failed/);
    expect(result.output).toMatch(/auth\.test\.ts/);
  });

  it('returns a clear "no framework detected" error when nothing matches', async () => {
    const ctx = buildCtx({}); // empty workspace, nothing detected
    const tool = buildTestRunTool();
    const result = await tool.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/Could not detect a test framework/);
    expect(result.output).toMatch(/framework/);
  });

  it('honours a forced `framework` override', async () => {
    let capturedCmd = '';
    const ctx = buildCtx({
      files: { '/repo/package.json': JSON.stringify({ devDependencies: { vitest: '^4' } }) },
      runCommand: (cmd, args) => {
        capturedCmd = `${cmd} ${args.join(' ')}`;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
    });
    const tool = buildTestRunTool();
    await tool.execute({ framework: 'jest' }, ctx);
    // Jest's command starts `npx jest --ci`, not `npx vitest run`.
    expect(capturedCmd).toContain('jest');
    expect(capturedCmd).not.toContain('vitest');
  });

  it('passes `pattern` through to the underlying framework command', async () => {
    let capturedArgs: string[] = [];
    const ctx = buildCtx({
      files: { '/repo/package.json': JSON.stringify({ devDependencies: { vitest: '^4' } }) },
      runCommand: (_cmd, args) => {
        capturedArgs = args;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
    });
    const tool = buildTestRunTool();
    await tool.execute({ pattern: 'memory.test.ts' }, ctx);
    expect(capturedArgs).toContain('memory.test.ts');
  });

  it('runs in `cwd` subdirectory for monorepo packages', async () => {
    let capturedCwd = '';
    const ctx = buildCtx({
      files: { '/repo/packages/agent-core/package.json': JSON.stringify({ devDependencies: { vitest: '^4' } }) },
      runCommand: (_cmd, _args, cwd) => {
        capturedCwd = cwd ?? '';
        return { stdout: '', stderr: '', exitCode: 0 };
      }
    });
    const tool = buildTestRunTool();
    const result = await tool.execute({ cwd: 'packages/agent-core' }, ctx);
    expect(capturedCwd).toBe('/repo/packages/agent-core');
    expect(result.output).toMatch(/in packages\/agent-core/);
  });
});

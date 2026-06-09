/**
 * test_run — the highest-leverage missing tool flagged in Bandit's
 * 2026-05-10 self-eval. Closes the round-trip where the agent has to
 * guess the test framework and shell out via raw run_command, fish
 * through the output, and report fuzzily. Instead:
 *
 *   1. Auto-detect the framework from workspace files (vitest, jest,
 *      pytest, go, cargo, dotnet, npm-script fallback).
 *   2. Run the appropriate command (with an optional `pattern` to
 *      scope to specific tests / files).
 *   3. Parse the output into a tight summary: framework, cwd,
 *      `N passed, M failed`, the first few failure messages.
 *
 * Why a dedicated tool rather than "tell the model to run pnpm test":
 * (a) detection is opinionated, doing it once is cheaper than the model
 *     guessing; (b) parsed output keeps tool-result size bounded so big
 *     suites don't flood the context with 5000 lines of pass logs;
 *     (c) the model gets a deterministic shape to react to, making
 *     fix-it loops actually closeable.
 */

import type { AgentTool, ToolResult, ToolExecutionContext } from '@burtson-labs/agent-core';

export type TestFramework =
  | 'vitest'
  | 'jest'
  | 'pytest'
  | 'go'
  | 'cargo'
  | 'dotnet'
  | 'npm-script';

const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_FAILURE_SNIPPETS = 8;

/**
 * Detect the test framework by inspecting the workspace at `cwd`. Tries
 * config files first, then dependency lookups, finally falls back to a
 * generic `npm test` script if one exists. Returns `null` if nothing
 * looks runnable — the tool surfaces a clear "I don't know how to test
 * this" message rather than blindly running `npm test` and hanging.
 */
export async function detectTestFramework(
  ctx: ToolExecutionContext,
  cwd: string
): Promise<TestFramework | null> {
  // Read package.json once — used by vitest/jest detection AND by the
  // npm-script fallback. Tolerate JSON parse errors silently; some
  // monorepo roots have package.json with comments / pragma lines.
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined;
  try {
    const raw = await ctx.readFile(`${cwd}/package.json`);
    pkg = JSON.parse(raw);
  } catch {
    // No package.json or invalid — that's fine, try the non-JS frameworks.
  }

  // ── JS/TS frameworks (vitest first since it's strict superset of
  // jest's matcher API on this codebase and more common in 2026) ────
  if (pkg) {
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (allDeps.vitest) return 'vitest';
    if (allDeps.jest || allDeps['ts-jest']) return 'jest';
  }
  // Config-file probes for the (rare) case of zero-dep test setups.
  for (const candidate of ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs']) {
    if (await fileExists(ctx, `${cwd}/${candidate}`)) return 'vitest';
  }
  for (const candidate of ['jest.config.ts', 'jest.config.js', 'jest.config.mjs']) {
    if (await fileExists(ctx, `${cwd}/${candidate}`)) return 'jest';
  }

  // ── Python ──────────────────────────────────────────────────────────
  if (
    (await fileExists(ctx, `${cwd}/pytest.ini`)) ||
    (await fileExists(ctx, `${cwd}/pyproject.toml`)) ||
    (await fileExists(ctx, `${cwd}/setup.cfg`))
  ) {
    return 'pytest';
  }

  // ── Go ──────────────────────────────────────────────────────────────
  if (await fileExists(ctx, `${cwd}/go.mod`)) return 'go';

  // ── Rust ────────────────────────────────────────────────────────────
  if (await fileExists(ctx, `${cwd}/Cargo.toml`)) return 'cargo';

  // ── .NET — sln OR any csproj at the root ───────────────────────────
  if (await hasFileMatching(ctx, cwd, '*.sln')) return 'dotnet';
  if (await hasFileMatching(ctx, cwd, '*.csproj')) return 'dotnet';

  // ── Generic npm-script fallback ─────────────────────────────────────
  if (pkg?.scripts?.test) return 'npm-script';

  return null;
}

/**
 * Build the command + args for a given framework. `pattern` is the
 * user-supplied test name / file filter. Each framework's filter flag
 * is different — handled here so the agent doesn't have to know.
 */
export function buildTestCommand(framework: TestFramework, pattern?: string): { cmd: string; args: string[] } {
  switch (framework) {
    case 'vitest':
      // `vitest run` is non-watch; --reporter=default produces the
      // summary line we parse. `pnpm test` would also work in
      // workspaces that wrap vitest, but invoking vitest directly is
      // more deterministic and avoids the workspace's prepush hooks.
      return { cmd: 'npx', args: ['vitest', 'run', ...(pattern ? [pattern] : [])] };
    case 'jest':
      return { cmd: 'npx', args: ['jest', '--ci', ...(pattern ? [pattern] : [])] };
    case 'pytest':
      // -q for short output; pytest's default is too verbose to fit
      // a useful failure list inside MAX_OUTPUT_BYTES.
      return { cmd: 'pytest', args: ['-q', ...(pattern ? ['-k', pattern] : [])] };
    case 'go':
      // `./...` recurses; pattern goes as `-run` regex.
      return { cmd: 'go', args: ['test', ...(pattern ? ['-run', pattern] : []), './...'] };
    case 'cargo':
      return { cmd: 'cargo', args: ['test', ...(pattern ? [pattern] : [])] };
    case 'dotnet':
      return { cmd: 'dotnet', args: ['test', '--nologo', '--verbosity', 'quiet', ...(pattern ? ['--filter', pattern] : [])] };
    case 'npm-script':
      // Generic fallback: respect the project's own `test` script.
      // Pattern isn't standardized for `npm test`, so we ignore it
      // and tell the agent to use a framework-specific override
      // if needed.
      return { cmd: 'npm', args: ['test', '--silent'] };
  }
}

/**
 * Parse stdout+stderr from a test run into a structured summary. We
 * extract the `N passed, M failed` headline plus the first few
 * failure snippets. Best-effort per framework — when parsing fails,
 * we fall back to "(unable to parse summary, see raw output)" and
 * the agent still gets the raw text.
 */
export interface ParsedTestSummary {
  passed?: number;
  failed?: number;
  skipped?: number;
  /** Brief one-line description of each failed test (first MAX_FAILURE_SNIPPETS). */
  failureNames: string[];
}

export function parseTestOutput(framework: TestFramework, stdout: string, stderr: string): ParsedTestSummary {
  const combined = `${stdout}\n${stderr}`;
  const result: ParsedTestSummary = { failureNames: [] };

  // vitest: `Tests  N passed (N)` or `Tests  M failed | N passed (N+M)`
  if (framework === 'vitest') {
    const m = combined.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?\s*\((\d+)\)/);
    if (m) {
      result.failed = m[1] ? parseInt(m[1], 10) : 0;
      result.passed = parseInt(m[2], 10);
      result.skipped = m[3] ? parseInt(m[3], 10) : 0;
    }
    // Failure rows look like `FAIL  test/foo.test.ts > nested > test name`.
    const fails = [...combined.matchAll(/FAIL\s+(.+?)(?:\n|$)/g)];
    result.failureNames = fails.slice(0, MAX_FAILURE_SNIPPETS).map((m2) => m2[1].trim());
  }

  // jest: `Tests:       N passed, M failed, K total`
  if (framework === 'jest') {
    const m = combined.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed,\s+(\d+)\s+total/);
    if (m) {
      result.failed = m[1] ? parseInt(m[1], 10) : 0;
      result.passed = parseInt(m[2], 10);
    }
    const fails = [...combined.matchAll(/●\s+(.+?)(?:\n|$)/g)];
    result.failureNames = fails.slice(0, MAX_FAILURE_SNIPPETS).map((m2) => m2[1].trim());
  }

  // pytest: `N failed, M passed in T.Ts` or `M passed in T.Ts`
  if (framework === 'pytest') {
    const m = combined.match(/(?:(\d+)\s+failed[,\s])?\s*(\d+)\s+passed(?:[,\s]+(\d+)\s+skipped)?\s+in\s+[\d.]+s/);
    if (m) {
      result.failed = m[1] ? parseInt(m[1], 10) : 0;
      result.passed = parseInt(m[2], 10);
      result.skipped = m[3] ? parseInt(m[3], 10) : 0;
    }
    // pytest's failed-list lines look like `FAILED path::testname` or
    // `FAILED path::testname - <reason>`. The `::` separator is the
    // marker — without it we end up matching the `FAILED` token in the
    // dashed summary banner (e.g. `======== 1 failed ...`) and capture
    // `========` as the "failure name."
    const fails = [...combined.matchAll(/FAILED\s+(\S+::\S+)/g)];
    result.failureNames = fails.slice(0, MAX_FAILURE_SNIPPETS).map((m2) => m2[1].trim());
  }

  // go: `--- FAIL: TestName` rows; summary is `ok` per package.
  if (framework === 'go') {
    const fails = [...combined.matchAll(/---\s+FAIL:\s+(\S+)/g)];
    result.failureNames = fails.slice(0, MAX_FAILURE_SNIPPETS).map((m2) => m2[1].trim());
    result.failed = result.failureNames.length;
    // `PASS: TestName` lines, optionally with subtests.
    const passes = [...combined.matchAll(/---\s+PASS:\s+/g)];
    result.passed = passes.length;
  }

  // cargo: `test result: FAILED. N passed; M failed; ...` or `ok. N passed`.
  if (framework === 'cargo') {
    const m = combined.match(/test result:\s+(?:ok|FAILED)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed(?:;\s+(\d+)\s+ignored)?/);
    if (m) {
      result.passed = parseInt(m[1], 10);
      result.failed = parseInt(m[2], 10);
      result.skipped = m[3] ? parseInt(m[3], 10) : 0;
    }
    const fails = [...combined.matchAll(/test\s+(\S+)\s+\.\.\.\s+FAILED/g)];
    result.failureNames = fails.slice(0, MAX_FAILURE_SNIPPETS).map((m2) => m2[1].trim());
  }

  // dotnet: `Passed!  - Failed:     M, Passed:     N, ...`
  if (framework === 'dotnet') {
    const m = combined.match(/Failed:\s+(\d+),\s+Passed:\s+(\d+)(?:,\s+Skipped:\s+(\d+))?/);
    if (m) {
      result.failed = parseInt(m[1], 10);
      result.passed = parseInt(m[2], 10);
      result.skipped = m[3] ? parseInt(m[3], 10) : 0;
    }
    const fails = [...combined.matchAll(/Failed\s+(\S+)/g)];
    result.failureNames = fails.slice(0, MAX_FAILURE_SNIPPETS).map((m2) => m2[1].trim());
  }

  // npm-script: no standard parser — we don't know which framework the
  // user's `test` script wraps. Leave the summary blank; the agent reads
  // the raw output. (If the project wires a real framework, the
  // dedicated branch above already caught it.)

  return result;
}

/**
 * The agent-facing tool.
 */
export function buildTestRunTool(): AgentTool {
  return {
    name: 'test_run',
    description:
      'Run the project\'s test suite and report a parsed summary. Auto-detects the framework (vitest, jest, pytest, go test, cargo test, dotnet test, or the package.json `test` script). Use this after editing code to verify nothing broke — the result tells you exactly how many tests passed/failed and which failed by name, so you can react without re-reading thousands of lines of test output. Pass `pattern` to scope to specific tests when iterating on a fix. Pass `cwd` for monorepos where the framework lives in a subdirectory (e.g. `packages/agent-core`).',
    parameters: [
      { name: 'pattern', description: 'Optional test name / file filter. Each framework maps it to its native flag (vitest/cargo/jest/dotnet: positional; pytest: -k; go: -run regex). Skipped for npm-script.', required: false },
      { name: 'cwd', description: 'Optional subdirectory of the workspace to run in. Defaults to the workspace root. Useful in monorepos to scope to one package.', required: false },
      { name: 'framework', description: 'Optional override when auto-detection picks the wrong one (e.g. monorepos with both jest and vitest). Must be one of: vitest, jest, pytest, go, cargo, dotnet, npm-script.', required: false }
    ],
    async execute(params: Record<string, string>, ctx: ToolExecutionContext): Promise<ToolResult> {
      const cwd = params.cwd?.trim()
        ? resolveCwd(ctx.workspaceRoot, params.cwd.trim())
        : ctx.workspaceRoot;

      const forced = params.framework?.trim() as TestFramework | undefined;
      const framework = forced ?? (await detectTestFramework(ctx, cwd));
      if (!framework) {
        return {
          output:
            `Could not detect a test framework in ${displayCwd(cwd, ctx.workspaceRoot)}. ` +
            `No vitest/jest/pytest/Cargo.toml/go.mod/*.csproj/sln found, and no \`test\` script in package.json. ` +
            `If a framework is present, pass it via the \`framework\` parameter (one of: vitest, jest, pytest, go, cargo, dotnet, npm-script).`,
          isError: true
        };
      }

      const { cmd, args } = buildTestCommand(framework, params.pattern?.trim() || undefined);
      const run = await ctx.runCommand(cmd, args, cwd);
      const stdout = truncate(run.stdout, MAX_OUTPUT_BYTES);
      const stderr = truncate(run.stderr, MAX_OUTPUT_BYTES);
      const summary = parseTestOutput(framework, stdout, stderr);

      const lines: string[] = [];
      const cwdLabel = displayCwd(cwd, ctx.workspaceRoot);
      const status = run.exitCode === 0 ? 'PASS' : 'FAIL';
      lines.push(`${status} · ${framework} in ${cwdLabel}`);
      if (summary.passed != null || summary.failed != null) {
        const parts: string[] = [];
        if (summary.passed != null) parts.push(`${summary.passed} passed`);
        if (summary.failed != null && summary.failed > 0) parts.push(`${summary.failed} failed`);
        if (summary.skipped != null && summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
        lines.push(parts.join(', '));
      }
      if (summary.failureNames.length > 0) {
        lines.push('');
        lines.push('Failures:');
        for (const name of summary.failureNames) lines.push(`  - ${name}`);
      }
      // Always tail the raw output (truncated) so the agent has the
      // actual stack/diagnostic when summary parsing missed something.
      // Cap the appended raw block tightly — the parsed summary is the
      // primary product; raw text is the fallback.
      const rawTail = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).slice(-4 * 1024);
      lines.push('');
      lines.push('--- raw output (tail) ---');
      lines.push(rawTail);

      return {
        output: lines.join('\n'),
        // Non-zero exit OR any failed-count from parsed summary marks it
        // as an error so the loop's existing tool-error handling kicks in
        // (e.g. the model knows to fix-then-retry rather than treat the
        // tool call as a clean success).
        isError: run.exitCode !== 0 || (summary.failed != null && summary.failed > 0)
      };
    }
  };
}

// ── helpers ────────────────────────────────────────────────────────────

async function fileExists(ctx: ToolExecutionContext, absPath: string): Promise<boolean> {
  try {
    await ctx.readFile(absPath);
    return true;
  } catch {
    return false;
  }
}

async function hasFileMatching(ctx: ToolExecutionContext, cwd: string, glob: string): Promise<boolean> {
  try {
    const matches = await ctx.listFiles(glob, cwd);
    return matches.length > 0;
  } catch {
    return false;
  }
}

function resolveCwd(workspaceRoot: string, cwd: string): string {
  if (cwd.startsWith('/')) return cwd;
  return `${workspaceRoot}/${cwd}`.replace(/\/+/g, '/');
}

function displayCwd(absolute: string, workspaceRoot: string): string {
  if (absolute === workspaceRoot) return '.';
  if (absolute.startsWith(workspaceRoot + '/')) return absolute.slice(workspaceRoot.length + 1);
  return absolute;
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n… (truncated)';
}

/**
 * Machine-readable eval output.
 *
 * The eval harness has always written markdown for humans, which means the
 * only way a downstream job could learn "which fixtures failed and why" was to
 * re-parse prose. That's fine for a PR reviewer and useless for automation, so
 * `eval --json-out` emits this shape alongside the markdown.
 *
 * Deliberately flat and string-safe: every field is a scalar or an array of
 * scalars, so a consumer (the nightly brief, a dashboard, a CI gate) can read
 * it without importing the harness's types or its RegExp-carrying Fixture
 * objects. Pure so it unit-tests without running a model.
 */

import type { EvalReport, FixtureResult } from './types';

export interface EvalJsonFixture {
  id: string;
  description: string;
  passed: boolean;
  /** "2/3" — passing runs over total runs. */
  passRate: string;
  /** Reason the fixture was skipped for this provider, when it was. */
  skipped?: string;
  runs: number;
  /** Every DISTINCT assertion failure across the fixture's runs, in order of
   *  first appearance. One-liners, suitable for a summary email. */
  failureReasons: string[];
  /** First runner-level crash (not an assertion failure), when one happened. */
  error?: string;
  medianWallMs: number;
  medianIterations: number;
  /** True when any run ground all the way to the iteration cap. */
  hitLimit: boolean;
}

export interface EvalJsonTotals {
  fixtures: number;
  passed: number;
  /** Excludes skipped fixtures — matches the harness's own exit-code rule. */
  failed: number;
  skipped: number;
}

export interface EvalJson {
  kind: 'bandit-eval-report';
  version: 1;
  provider: string;
  model: string;
  variant: string;
  startedAt: string;
  totalWallTimeMs: number;
  /** How many times each fixture ran, when every fixture agreed. Null when the
   *  set was mixed, so a reader never assumes a uniform N that wasn't used. */
  runsPerFixture: number | null;
  totals: EvalJsonTotals;
  fixtures: EvalJsonFixture[];
}

/** Upper-element median, matching `benchmark.ts` so the two outputs' medians
 *  are directly comparable rather than subtly different on even counts. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Collapse a multi-line reason to a single readable line. */
function oneLine(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim();
}

function fixtureToJson(result: FixtureResult): EvalJsonFixture {
  // Dedupe reasons across runs: a fixture that fails the same assertion 3×
  // should report that once, not three identical bullets.
  const seen = new Set<string>();
  const failureReasons: string[] = [];
  for (const run of result.runs) {
    for (const reason of run.failureReasons ?? []) {
      const line = oneLine(reason);
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line);
        failureReasons.push(line);
      }
    }
  }

  return {
    id: result.fixture.id,
    description: result.fixture.description,
    passed: result.passed,
    passRate: result.passRate,
    ...(result.skipped ? { skipped: result.skipped } : {}),
    runs: result.runs.length,
    failureReasons,
    ...(result.runs.find((r) => r.error)?.error
      ? { error: oneLine(result.runs.find((r) => r.error)!.error!) }
      : {}),
    medianWallMs: median(result.runs.map((r) => r.wallTimeMs)),
    medianIterations: median(result.runs.map((r) => r.iterations)),
    hitLimit: result.runs.some((r) => r.hitLimit)
  };
}

export function buildEvalJson(report: EvalReport): EvalJson {
  const fixtures = report.fixtureResults.map(fixtureToJson);
  const runCounts = new Set(fixtures.map((f) => f.runs));

  return {
    kind: 'bandit-eval-report',
    version: 1,
    provider: report.provider,
    model: report.model,
    variant: report.variant ?? 'cli',
    startedAt: report.startedAt,
    totalWallTimeMs: report.totalWallTimeMs,
    runsPerFixture: runCounts.size === 1 ? [...runCounts][0] : null,
    totals: {
      fixtures: fixtures.length,
      passed: fixtures.filter((f) => f.passed).length,
      // Skipped fixtures are neither passes nor failures — the harness's exit
      // code ignores them and so does this count.
      failed: fixtures.filter((f) => !f.passed && !f.skipped).length,
      skipped: fixtures.filter((f) => f.skipped).length
    },
    fixtures
  };
}

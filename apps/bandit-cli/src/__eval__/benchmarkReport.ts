/**
 * Benchmark report renderer. The eval report is oriented around pass/fail
 * (did the model behave correctly); the benchmark report is oriented around
 * how efficiently each model behaved — across the SAME fixture set, how did
 * models m1, m2, m3 compare on wall time, iteration count, and tool-call
 * count?
 *
 * The primary artifact is a comparison markdown table where rows are
 * fixtures and columns are models. Each cell summarizes that model's
 * performance on that fixture: pass rate + median wall time + median
 * iterations + median tool calls. Median over mean because one stochastic
 * retry (iterations = 8 instead of 2) skews the mean and hides the typical
 * case; the median is a more honest "what usually happens" signal.
 */

import { c, glyph } from '../ansi';
import type { EvalReport, FixtureResult, RunResult } from './types';

export interface BenchmarkEntry {
  /** Human label — e.g. "ollama/gemma3:12b" or "bandit/bandit-core-1". */
  label: string;
  report: EvalReport;
}

interface CellStats {
  passRate: string;
  passed: boolean;
  skipped?: string;
  medianWallMs: number;
  medianIterations: number;
  medianToolCalls: number;
  /** How many runs the stats were computed over — useful when `runs` differs
   *  between models (e.g. a cloud run kept at N=1 for cost while a local run
   *  uses N=3). */
  sampleSize: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function cellStats(result: FixtureResult): CellStats {
  if (result.skipped) {
    return {
      passRate: 'skipped',
      passed: true,
      skipped: result.skipped,
      medianWallMs: 0,
      medianIterations: 0,
      medianToolCalls: 0,
      sampleSize: 0
    };
  }
  const runs: RunResult[] = result.runs;
  return {
    passRate: result.passRate,
    passed: result.passed,
    medianWallMs: median(runs.map(r => r.wallTimeMs)),
    medianIterations: median(runs.map(r => r.iterations)),
    medianToolCalls: median(runs.map(r => r.toolCalls.length)),
    sampleSize: runs.length
  };
}

function formatWall(ms: number): string {
  if (ms === 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Render a tight console summary as each model finishes. Shows one row per
 * fixture: pass | wall | iters | tools, prefixed with the model label so
 * multi-model runs stream sensibly without waiting for the final table.
 */
export function renderBenchmarkLive(entry: BenchmarkEntry): void {
  process.stdout.write('\n' + c.bold(entry.label) + c.dim(` — ${(entry.report.totalWallTimeMs / 1000).toFixed(1)}s total`) + '\n');
  for (const r of entry.report.fixtureResults) {
    const stats = cellStats(r);
    const badge = stats.skipped
      ? c.dim('↷')
      : stats.passed ? c.green(glyph.check) : c.red(glyph.cross);
    const perf = stats.skipped
      ? c.dim(stats.skipped)
      : `${formatWall(stats.medianWallMs).padStart(6)}  iters=${stats.medianIterations}  tools=${stats.medianToolCalls}`;
    process.stdout.write(`  ${badge} ${c.cyan(r.fixture.id.padEnd(36))} ${c.dim(stats.passRate.padEnd(8))} ${perf}\n`);
  }
}

/**
 * Render the cross-model comparison table as markdown. Rows are fixtures;
 * columns are models. Each cell is a compact "pass · wall · iters · tools"
 * summary. Below the table we dump per-model summary rows (aggregate pass
 * count, aggregate wall) so the reader has a headline takeaway without
 * having to eyeball every cell.
 */
export function renderBenchmarkMarkdown(entries: BenchmarkEntry[]): string {
  if (entries.length === 0) return '# Benchmark report\n\n_No entries._\n';

  // Collect the fixture-id set across all entries. We assume the same
  // fixture set is run against each model (the runner enforces this) but
  // skipped fixtures may legitimately appear in one column and not another,
  // so we derive the union defensively.
  const fixtureIds = new Set<string>();
  for (const entry of entries) {
    for (const r of entry.report.fixtureResults) {
      fixtureIds.add(r.fixture.id);
    }
  }
  const orderedIds = Array.from(fixtureIds);

  const lines: string[] = [];
  lines.push('# Bandit benchmark report');
  lines.push('');
  lines.push(`_Generated ${new Date().toISOString()}_`);
  lines.push('');
  lines.push('Each cell: pass-rate · median wall-time · median iterations · median tool calls.');
  lines.push('Median over mean so one long retry run does not distort the typical case.');
  lines.push('');

  // Header row
  const headerCells = ['fixture', ...entries.map(e => e.label)];
  lines.push('| ' + headerCells.join(' | ') + ' |');
  lines.push('| ' + headerCells.map(() => '---').join(' | ') + ' |');

  for (const id of orderedIds) {
    const row: string[] = [`\`${id}\``];
    for (const entry of entries) {
      const result = entry.report.fixtureResults.find(r => r.fixture.id === id);
      if (!result) {
        row.push('_absent_');
        continue;
      }
      const stats = cellStats(result);
      if (stats.skipped) {
        row.push(`_skipped_`);
        continue;
      }
      const marker = stats.passed ? '✅' : '❌';
      row.push(`${marker} ${stats.passRate} · ${formatWall(stats.medianWallMs)} · i=${stats.medianIterations} · t=${stats.medianToolCalls}`);
    }
    lines.push('| ' + row.join(' | ') + ' |');
  }

  lines.push('');
  lines.push('## Per-model summary');
  lines.push('');
  lines.push('| model | pass count | total wall |');
  lines.push('| --- | --- | --- |');
  for (const entry of entries) {
    const passed = entry.report.fixtureResults.filter(r => r.passed && !r.skipped).length;
    const total = entry.report.fixtureResults.filter(r => !r.skipped).length;
    lines.push(`| \`${entry.label}\` | ${passed}/${total} | ${formatWall(entry.report.totalWallTimeMs)} |`);
  }
  lines.push('');

  return lines.join('\n');
}

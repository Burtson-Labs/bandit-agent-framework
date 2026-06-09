/**
 * Markdown report formatter for eval runs. Prints to stdout (color) for the
 * live view during `pnpm eval`, and returns a plain-markdown string the
 * runner can also write to disk for CI / PR-review consumption.
 *
 * The report leads with a pass/fail matrix — what the reader wants first is
 * "did anything regress" — and drills down into failures with the actual
 * tool-call trace, because that trace is what you'd look at to fix the
 * system prompt or the tool description.
 */

import { c, glyph } from '../ansi';
import type { EvalReport, FixtureResult, RunResult, ToolCallTrace } from './types';

export function renderLive(report: EvalReport): void {
  const total = report.fixtureResults.length;
  const passed = report.fixtureResults.filter(r => r.passed).length;
  const skipped = report.fixtureResults.filter(r => r.skipped).length;
  const failed = total - passed - skipped;
  const headline = failed === 0
    ? `${glyph.check} ${passed}/${total} fixtures passed`
    : `${glyph.cross} ${failed} failing, ${passed} passed, ${skipped} skipped`;

  process.stdout.write('\n');
  const variantTag = report.variant ? ` variant=${report.variant}` : '';
  process.stdout.write(c.bold(`Bandit eval report  `) + c.dim(`— ${report.provider}/${report.model}${variantTag}`) + '\n');
  process.stdout.write(c.dim(`started: ${report.startedAt}  wall: ${(report.totalWallTimeMs / 1000).toFixed(1)}s`) + '\n');
  process.stdout.write((failed === 0 ? c.green(headline) : c.red(headline)) + '\n\n');

  for (const result of report.fixtureResults) {
    renderResultLive(result);
  }
}

/**
 * Emit one fixture's line as soon as it resolves. Used by the eval entry
 * point to stream progress during the run instead of silent-then-dump.
 * Callers still get the full `renderLive` summary at the end for people
 * who copy-paste the final state; this is purely additive.
 */
export function renderFixtureProgress(result: FixtureResult, progress: { done: number; total: number }): void {
  const prefix = c.dim(`[${progress.done.toString().padStart(progress.total.toString().length)}/${progress.total}]`);
  if (result.skipped) {
    process.stdout.write(`  ${prefix} ${c.dim('↷')} ${c.cyan(result.fixture.id)}  ${c.dim(result.skipped)}\n`);
    return;
  }
  const badge = result.passed ? c.green(glyph.check) : c.red(glyph.cross);
  const rate = result.passed ? c.green(result.passRate) : c.red(result.passRate);
  process.stdout.write(`  ${prefix} ${badge} ${c.cyan(result.fixture.id.padEnd(32))} ${rate}  ${c.dim(result.fixture.description)}\n`);
}

function renderResultLive(result: FixtureResult): void {
  const { fixture } = result;
  if (result.skipped) {
    process.stdout.write(`  ${c.dim('↷')} ${c.cyan(fixture.id)}  ${c.dim(result.skipped)}\n`);
    return;
  }
  const badge = result.passed ? c.green(glyph.check) : c.red(glyph.cross);
  const rate = result.passed ? c.green(result.passRate) : c.red(result.passRate);
  process.stdout.write(`  ${badge} ${c.cyan(fixture.id.padEnd(32))} ${rate}  ${c.dim(fixture.description)}\n`);

  // Surface failures with their trace so the user can see WHY it failed
  // without having to grep through a separate log.
  if (!result.passed) {
    for (const run of result.runs.filter(r => !r.passed)) {
      process.stdout.write(c.dim(`      run ${run.runNumber}:  ${describeTrace(run.toolCalls)}\n`));
      for (const reason of run.failureReasons) {
        process.stdout.write(c.red(`        ✗ ${reason}\n`));
      }
      if (run.error) {
        process.stdout.write(c.red(`        ! runner error — see markdown report\n`));
      }
    }
  }
}

function describeTrace(calls: ToolCallTrace[]): string {
  if (calls.length === 0) return '(no tool calls — model returned prose only)';
  return calls.slice(0, 6).map(describeCall).join(' → ') + (calls.length > 6 ? ` → … (+${calls.length - 6})` : '');
}

function describeCall(call: ToolCallTrace): string {
  const primary = call.params.path ?? call.params.cmd ?? call.params.pattern ?? call.params.url ?? call.params.repo_path;
  const hint = primary ? `(${truncate(primary, 40)})` : '';
  return `${call.name}${hint}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}

/**
 * Render the full report as markdown. Safe to write to disk verbatim —
 * colors are stripped. Used for CI artifacts and PR comment attachments.
 */
export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  const total = report.fixtureResults.length;
  const passed = report.fixtureResults.filter(r => r.passed).length;
  const skipped = report.fixtureResults.filter(r => r.skipped).length;
  const failed = total - passed - skipped;

  lines.push(`# Bandit Eval Report`);
  lines.push('');
  lines.push(`- **Provider:** ${report.provider} / \`${report.model}\``);
  if (report.variant) lines.push(`- **Variant:** \`${report.variant}\``);
  lines.push(`- **Started:** ${report.startedAt}`);
  lines.push(`- **Wall time:** ${(report.totalWallTimeMs / 1000).toFixed(1)}s`);
  lines.push(`- **Summary:** ${passed} passed · ${failed} failed · ${skipped} skipped (of ${total})`);
  lines.push('');

  lines.push(`## Results`);
  lines.push('');
  lines.push(`| Fixture | Pass | Runs | Description |`);
  lines.push(`|---------|------|------|-------------|`);
  for (const result of report.fixtureResults) {
    const status = result.skipped ? '↷ skipped' : result.passed ? '✅' : '❌';
    lines.push(`| \`${result.fixture.id}\` | ${status} | ${result.passRate} | ${escapePipe(result.fixture.description)} |`);
  }
  lines.push('');

  const failedResults = report.fixtureResults.filter(r => !r.passed && !r.skipped);
  if (failedResults.length > 0) {
    lines.push(`## Failures`);
    lines.push('');
    for (const result of failedResults) {
      lines.push(...renderFailureMd(result));
      lines.push('');
    }
  }

  return lines.join('\n') + '\n';
}

function renderFailureMd(result: FixtureResult): string[] {
  const lines: string[] = [];
  const { fixture } = result;
  lines.push(`### \`${fixture.id}\` — ${result.passRate}`);
  lines.push('');
  lines.push(`**Description:** ${fixture.description}`);
  lines.push('');
  lines.push(`**Prompt:**`);
  lines.push('```');
  lines.push(fixture.prompt);
  lines.push('```');
  lines.push('');
  for (const run of result.runs) {
    lines.push(`**Run ${run.runNumber}** — ${run.passed ? '✅ pass' : '❌ fail'} (${run.iterations} iterations, ${run.wallTimeMs}ms${run.hitLimit ? ', hit limit' : ''})`);
    lines.push('');
    if (run.toolCalls.length === 0) {
      lines.push('- No tool calls');
    } else {
      for (const call of run.toolCalls) {
        const primary = call.params.path ?? call.params.cmd ?? call.params.pattern ?? call.params.url ?? '';
        const paramsStr = primary ? ` \`${primary}\`` : '';
        const errorMark = call.isError ? ' ⚠️ error' : '';
        lines.push(`- iter ${call.iteration}: **${call.name}**${paramsStr}${errorMark}`);
        // Surface the actual error message on failed calls — without it,
        // the eval report says "write_file errored" and the author has
        // to go hunt for the reason. The snippet comes from the
        // tool_loop:tool_result event (first 280 chars of the output).
        if (call.isError && call.outputSnippet) {
          const oneLine = call.outputSnippet.replace(/\s+/g, ' ').trim();
          lines.push(`  - \`${escapePipe(oneLine)}\``);
        }
        // When a required-parameter error fires, the raw tool_call block
        // is the diagnostic — it reveals what shape the model actually
        // emitted (missing key, wrong wrapper, nested array, etc).
        if (call.isError && /parameter is required/.test(call.outputSnippet ?? '') && call.rawCallSnippet) {
          const oneLine = call.rawCallSnippet.replace(/\s+/g, ' ').trim();
          lines.push(`  - raw: \`${escapePipe(oneLine)}\``);
        }
      }
    }
    if (run.failureReasons.length > 0) {
      lines.push('');
      lines.push('Failure reasons:');
      for (const reason of run.failureReasons) {
        lines.push(`- ${reason}`);
      }
    }
    if (run.error) {
      lines.push('');
      lines.push('Runner error:');
      lines.push('```');
      lines.push(run.error);
      lines.push('```');
    }
    lines.push('');
  }
  return lines;
}

function escapePipe(text: string): string {
  return text.replace(/\|/g, '\\|');
}

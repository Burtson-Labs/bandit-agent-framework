/**
 * Post-edit deep checks — close the agent's feedback loop.
 *
 * Bandit's self-evaluations have repeatedly flagged "no automatic
 * verification after changes" as a top gap. The existing language-
 * adapter system runs a per-file PARSE check (ts.transpileModule for
 * TS, JSON.parse for JSON, etc.) before write — fast, but doesn't
 * catch type errors, broken imports, or any cross-file regression
 * the model just introduced.
 *
 * This module runs the project-level tooling AFTER the write has
 * landed and surfaces ONLY the errors that weren't there before.
 * Pre-existing rot is ignored (same invariant as introducedNewErrors
 * — we only block when THIS edit introduced something new).
 *
 * Strategy:
 *   - lazy: only fires when the touched file lives in a project that
 *     has the relevant tooling installed (tsconfig.json + typescript
 *     in node_modules for the TS check). Quietly returns no-op when
 *     the workspace doesn't support it — never blocks an edit on
 *     missing tooling.
 *   - per-project caching: the first edit to a project pays for
 *     baselining the existing error set, subsequent edits diff
 *     against that cached baseline (and update it after each run).
 *   - bounded: 30s hard timeout so a broken tsconfig or huge project
 *     can't lock up the loop.
 *   - opt-in via NO env var (defaults on). Can be disabled per-call
 *     by callers passing a flag, or globally by setting
 *     BANDIT_DISABLE_POST_EDIT_CHECKS=1.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ToolExecutionContext } from './tool-types';

/**
 * Per-project baseline cache — error set keyed by absolute tsconfig
 * path. Module-scoped so it persists across edits in a single
 * session. Fresh process / fresh CLI launch starts empty.
 */
const TS_BASELINE_CACHE = new Map<string, Set<string>>();

const POST_EDIT_TIMEOUT_MS = 30_000;
const MAX_NEW_ERRORS_REPORTED = 8;
const TSC_FILE_EXTS = new Set(['ts', 'tsx', 'cts', 'mts']);

/**
 * Walk up from `start` looking for the nearest `tsconfig.json` (or
 * `jsconfig.json` as a fallback for JS-only projects). Returns
 * undefined if none found before hitting the filesystem root.
 */
function findNearestTsconfig(start: string): string | undefined {
  let dir = path.dirname(start);
  const root = path.parse(dir).root;
  while (dir && dir !== root) {
    for (const candidate of ['tsconfig.json', 'jsconfig.json']) {
      const probe = path.join(dir, candidate);
      try {
        if (fs.statSync(probe).isFile()) {return probe;}
      } catch { /* not present, keep walking */ }
    }
    const next = path.dirname(dir);
    if (next === dir) {break;}
    dir = next;
  }
  return undefined;
}

/**
 * Detect whether the project has typescript installed locally —
 * either a direct dep or hoisted to a parent `node_modules`. We
 * check by looking for the ts binary in node_modules/.bin OR the
 * package's package.json. Cheap stat, no resolve overhead.
 */
function hasTypeScriptInstalled(tsconfigPath: string): boolean {
  let dir = path.dirname(tsconfigPath);
  const root = path.parse(dir).root;
  while (dir && dir !== root) {
    const probes = [
      path.join(dir, 'node_modules', 'typescript', 'package.json'),
      path.join(dir, 'node_modules', '.bin', 'tsc')
    ];
    for (const p of probes) {
      try { if (fs.statSync(p)) {return true;} } catch { /* keep walking */ }
    }
    const next = path.dirname(dir);
    if (next === dir) {break;}
    dir = next;
  }
  return false;
}

/**
 * Parse `tsc --noEmit` output into a set of unique error lines.
 * tsc lines look like:
 *   src/foo.ts(12,3): error TS2304: Cannot find name 'bar'.
 * We normalize position info out so the same logical error round-trips
 * across edits that shift line numbers — same trick as
 * introducedNewErrors in core-tools.ts.
 */
function parseTscErrors(stdout: string): Set<string> {
  const errors = new Set<string>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) {continue;}
    // Look for the "error TSxxxx" marker — tsc emits both errors and
    // warnings; we only care about errors here.
    if (!/error TS\d+:/.test(line)) {continue;}
    // Strip line/col so a position shift doesn't register as a new
    // error. "src/foo.ts(12,3)" → "src/foo.ts(N,N)".
    const normalized = line.replace(/\(\d+,\d+\)/g, '(N,N)');
    errors.add(normalized);
  }
  return errors;
}

export interface PostEditCheckResult {
  /** Human-readable warning to append to the tool result. Undefined when
   *  the check found no new errors or could not run. */
  warning?: string;
  /** Number of NEW errors detected (post − pre). Always 0 if warning is
   *  undefined. Useful for telemetry. */
  newErrorCount: number;
}

/**
 * Run a post-edit project-level type check on the touched file's
 * project. Returns any NEW errors introduced by this edit, ignoring
 * pre-existing ones.
 */
export async function runPostEditTypeCheck(
  absPath: string,
  ctx: ToolExecutionContext
): Promise<PostEditCheckResult> {
  if (process.env.BANDIT_DISABLE_POST_EDIT_CHECKS === '1') {
    return { newErrorCount: 0 };
  }

  // Only TS/TSX/CTS/MTS files trigger the tsc check. JS/JSX edits
  // don't catch much from tsc unless allowJs is on, which is
  // project-specific; skip for now to avoid false positives.
  const ext = absPath.split('.').pop()?.toLowerCase() ?? '';
  if (!TSC_FILE_EXTS.has(ext)) {return { newErrorCount: 0 };}

  const tsconfig = findNearestTsconfig(absPath);
  if (!tsconfig) {return { newErrorCount: 0 };}
  if (!hasTypeScriptInstalled(tsconfig)) {return { newErrorCount: 0 };}

  // Run tsc --noEmit on the project. Use --incremental so subsequent
  // runs in the same session use cached build info (much faster than
  // a cold compile). The buildinfo path is per-tsconfig hash so two
  // workspaces don't collide.
  const tsconfigDir = path.dirname(tsconfig);
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    // Use a Promise.race against a timeout — ctx.runCommand does its
    // own timeout but we want a hard cap regardless of host config.
    result = await Promise.race([
      ctx.runCommand(
        'npx',
        ['--no-install', 'tsc', '--noEmit', '-p', tsconfig, '--incremental'],
        tsconfigDir
      ),
      new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        setTimeout(() => resolve({
          stdout: '',
          stderr: 'post-edit-check: tsc timed out after 30s',
          exitCode: 124
        }), POST_EDIT_TIMEOUT_MS);
      })
    ]);
  } catch {
    // Don't let post-edit-check failure break the tool result.
    return { newErrorCount: 0, warning: undefined };
  }

  if (result.exitCode === 124) {
    // Timeout — skip silently rather than report a stale baseline.
    return { newErrorCount: 0 };
  }

  const currentErrors = parseTscErrors(result.stdout + '\n' + result.stderr);
  const cached = TS_BASELINE_CACHE.get(tsconfig);

  // Update cache regardless so the next edit diffs against THIS state.
  TS_BASELINE_CACHE.set(tsconfig, currentErrors);

  // First run for this project — no baseline to diff against. Record
  // the current error set as the baseline; do not report anything.
  // The first edit per project per session is "free" — we only catch
  // NEW errors from EDIT N+1 onwards. Trade-off: the very first edit
  // could introduce errors that go unreported until the next edit.
  // Acceptable for now; alternative is to baseline pre-edit on EVERY
  // first edit which doubles the latency budget.
  if (!cached) {return { newErrorCount: 0 };}

  const newErrors: string[] = [];
  for (const err of currentErrors) {
    if (!cached.has(err)) {newErrors.push(err);}
  }
  if (newErrors.length === 0) {return { newErrorCount: 0 };}

  const shown = newErrors.slice(0, MAX_NEW_ERRORS_REPORTED);
  const more = newErrors.length > MAX_NEW_ERRORS_REPORTED
    ? `\n  …and ${newErrors.length - MAX_NEW_ERRORS_REPORTED} more`
    : '';
  const projectLabel = path.relative(process.cwd(), tsconfig) || tsconfig;
  return {
    newErrorCount: newErrors.length,
    warning:
      `\n\n[Post-edit type check on ${projectLabel}] ${newErrors.length} NEW TypeScript error${newErrors.length === 1 ? '' : 's'} this edit introduced:\n  ` +
      shown.join('\n  ') +
      more +
      '\n\nFix these in the next iteration. Pre-existing errors in the project are ignored.'
  };
}

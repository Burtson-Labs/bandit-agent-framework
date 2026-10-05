/**
 * Assertion evaluation for eval fixtures. Takes a captured tool-call trace
 * plus the fixture's assertions and returns a boolean pass + human-readable
 * failure reasons (which feed straight into the markdown report).
 *
 * All assertions are evaluated in one pass so the report shows every reason
 * a run failed, not just the first one — faster feedback when a fixture
 * breaks three ways at once after a system-prompt change.
 */

import type { FixtureAssertions, ToolCallSpec, ToolCallTrace } from './types';

export interface EvaluationResult {
  passed: boolean;
  reasons: string[];
  /** How many `mustCallAnyOf` / `mustCallAllOf` requirements no successful call
   *  satisfied. Non-zero on a run that ended with a final answer means the model
   *  stopped before doing the work the task needed. */
  missingRequiredCalls: number;
}

export function evaluateRun(
  toolCalls: ToolCallTrace[],
  iterations: number,
  finalResponse: string,
  assertions: FixtureAssertions,
  finalFiles?: Record<string, string | null>
): EvaluationResult {
  const reasons: string[] = [];
  let missingRequiredCalls = 0;
  // A required call only counts when it worked (or the spec opts into attempts).
  const satisfies = (spec: ToolCallSpec): boolean => toolCalls.some(call => matchesSpec(call, spec, 'required'));
  const describeActual = (): string => toolCalls.length > 0
    ? toolCalls.map(c => (c.isError ? `${c.name} (failed)` : c.name)).join(', ')
    : '(no tool calls)';

  if (assertions.mustCallAnyOf && assertions.mustCallAnyOf.length > 0) {
    if (!assertions.mustCallAnyOf.some(satisfies)) {
      missingRequiredCalls++;
      const expected = assertions.mustCallAnyOf.map(describeSpec).join(' OR ');
      reasons.push(`expected agent to call ${expected} — got: ${describeActual()}`);
    }
  }

  if (assertions.mustCallAllOf && assertions.mustCallAllOf.length > 0) {
    // Each entry must be satisfied by at least one call in the trace.
    // Unlike mustCallAnyOf, the failure reason names each unmet entry
    // individually — for a cross-stack fixture the author wants to see
    // "missed Worksheet.cs AND worksheet.ts", not "missed one of…".
    for (const entry of assertions.mustCallAllOf) {
      const alternatives = Array.isArray(entry) ? entry : [entry];
      if (!alternatives.some(satisfies)) {
        missingRequiredCalls++;
        reasons.push(`expected call matching ${alternatives.map(describeSpec).join(' OR ')} was never made successfully — got: ${describeActual()}`);
      }
    }
  }

  if (assertions.firstCallAnyOf && assertions.firstCallAnyOf.length > 0) {
    const first = toolCalls[0];
    if (!first || !assertions.firstCallAnyOf.some(spec => matchesSpec(first, spec, 'attempt'))) {
      const expected = assertions.firstCallAnyOf.map(describeSpec).join(' OR ');
      const actual = first ? `${first.name}${paramPreview(first)}` : '(no tool calls)';
      reasons.push(`expected the first tool call to be ${expected} — got: ${actual}`);
    }
  }

  if (assertions.mustNotCall && assertions.mustNotCall.length > 0) {
    for (const forbidden of assertions.mustNotCall) {
      const violation = toolCalls.find(c => matchesSpec(c, forbidden, 'attempt'));
      if (violation) {
        const label = typeof forbidden === 'string' ? `"${forbidden}"` : `"${violation.name}" (forbidden: ${describeSpec(forbidden)})`;
        reasons.push(`agent called forbidden tool ${label} at iteration ${violation.iteration}${paramPreview(violation)}`);
      }
    }
  }

  if (assertions.maxIterations !== undefined && iterations > assertions.maxIterations) {
    reasons.push(`agent used ${iterations} loop iterations; fixture caps it at ${assertions.maxIterations}`);
  }

  if (assertions.finalResponseMatches && !assertions.finalResponseMatches.test(finalResponse)) {
    const preview = finalResponse.slice(0, 120).replace(/\s+/g, ' ');
    reasons.push(`final response did not match ${assertions.finalResponseMatches} — got "${preview}${finalResponse.length > 120 ? '…' : ''}"`);
  }

  if (assertions.finalFiles) {
    for (const [file, expected] of Object.entries(assertions.finalFiles)) {
      const actual = finalFiles?.[file] ?? null;
      if (expected === null) {
        if (actual !== null) reasons.push(`file ${file} should not exist after the run`);
        continue;
      }
      if (actual === null) {
        reasons.push(`file ${file} missing after the run`);
        continue;
      }
      const ok = expected instanceof RegExp ? expected.test(actual) : sameContent(file, actual, expected);
      if (!ok) {
        const preview = actual.slice(0, 120).replace(/\s+/g, ' ');
        reasons.push(`file ${file} content did not match ${expected instanceof RegExp ? expected : 'the expected text'} — got "${preview}${actual.length > 120 ? '…' : ''}"`);
      }
    }
  }

  return { passed: reasons.length === 0, reasons, missingRequiredCalls };
}

/**
 * Text equality for `finalFiles`: every non-blank line must match in order, but blank
 * lines and trailing whitespace are not compared. A line-range edit whose content ends
 * in a newline leaves a stray blank line behind (replace_range counts the empty tail as
 * a line); that is not what "the file is wrong" should mean. A fixture that cares where
 * a blank line is uses a RegExp.
 */
function sameText(actual: string, expected: string): boolean {
  const lines = (text: string): string[] => text.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.length > 0);
  const a = lines(actual);
  const b = lines(expected);
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * A `.json` file is compared as JSON: same keys and values, whatever the layout. An edit
 * that lands the right value but joins two lines (apply_edit's whitespace-tolerant match
 * does this when the model's `find` is indented differently from the file) has not
 * changed the configuration. Invalid JSON never matches. Everything else is compared as text.
 */
function sameContent(file: string, actual: string, expected: string): boolean {
  if (/\.json$/i.test(file)) {
    let want: unknown;
    try { want = JSON.parse(expected); } catch { return sameText(actual, expected); }
    try { return canonicalJson(JSON.parse(actual)) === canonicalJson(want); } catch { return false; }
  }
  return sameText(actual, expected);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function paramPreview(call: ToolCallTrace): string {
  return Object.keys(call.params).length > 0 ? ` (params: ${summarizeParams(call.params)})` : '';
}

/**
 * `required`: the call must also have succeeded, unless the spec sets `allowError`.
 * `attempt`: the call was made, whatever came of it (forbidden calls, first-call checks).
 */
function matchesSpec(call: ToolCallTrace, spec: ToolCallSpec, mode: 'required' | 'attempt'): boolean {
  const allowError = mode === 'attempt' || (typeof spec !== 'string' && spec.allowError === true);
  if (!allowError && call.isError) return false;
  if (typeof spec === 'string') return call.name === spec;
  // Tool-name matching: string for exact, RegExp for OR patterns like
  // /^(apply_edit|replace_range|write_file)$/.
  if (typeof spec.name === 'string') {
    if (call.name !== spec.name) return false;
  } else {
    spec.name.lastIndex = 0;
    if (!spec.name.test(call.name)) return false;
  }
  if (!spec.params) return true;
  for (const [key, matcher] of Object.entries(spec.params)) {
    // `commandLine` is virtual: run_command's cmd plus its separate args, so a fixture can
    // match "npm test" whether the model sent cmd="npm test" or cmd="npm", args="test".
    const value = key === 'commandLine'
      ? [call.params.cmd, call.params.args].filter(Boolean).join(' ')
      : call.params[key];
    if (value === undefined || value === null) return false;
    if (typeof matcher === 'string') {
      if (value !== matcher) return false;
    } else if (matcher instanceof RegExp) {
      matcher.lastIndex = 0;
      if (!matcher.test(value)) return false;
    } else if (typeof matcher === 'function') {
      if (!matcher(value)) return false;
    }
  }
  return true;
}

function describeSpec(spec: ToolCallSpec): string {
  if (typeof spec === 'string') return spec;
  const nameLabel = typeof spec.name === 'string' ? spec.name : `/${spec.name.source}/`;
  if (!spec.params || Object.keys(spec.params).length === 0) return nameLabel;
  const paramDesc = Object.entries(spec.params)
    .map(([key, matcher]) => {
      if (matcher instanceof RegExp) return `${key}~${matcher.source}`;
      if (typeof matcher === 'function') return `${key}=<pred>`;
      return `${key}="${matcher}"`;
    })
    .join(', ');
  return `${nameLabel}(${paramDesc})`;
}

function summarizeParams(params: Record<string, string>): string {
  const primary = params.path ?? params.cmd ?? params.pattern ?? params.url ?? params.query;
  if (primary) return `${Object.keys(params)[0] === 'path' ? 'path=' : ''}${shorten(primary, 60)}`;
  const entries = Object.entries(params).slice(0, 2).map(([k, v]) => `${k}=${shorten(v, 30)}`);
  return entries.join(', ') + (Object.keys(params).length > 2 ? ', …' : '');
}

function shorten(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}

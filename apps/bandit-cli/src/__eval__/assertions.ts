/**
 * Assertion evaluation for eval fixtures. Takes a captured tool-call trace
 * plus the fixture's assertions and returns a boolean pass + human-readable
 * failure reasons (which feed straight into the markdown report).
 *
 * All assertions are evaluated in one pass so the report shows every reason
 * a run failed, not just the first one — faster feedback when a fixture
 * breaks three ways at once after a system-prompt change.
 */

import type { FixtureAssertions, ToolCallAssertion, ToolCallTrace } from './types';

export interface EvaluationResult {
  passed: boolean;
  reasons: string[];
}

export function evaluateRun(
  toolCalls: ToolCallTrace[],
  iterations: number,
  finalResponse: string,
  assertions: FixtureAssertions
): EvaluationResult {
  const reasons: string[] = [];

  if (assertions.mustCallAnyOf && assertions.mustCallAnyOf.length > 0) {
    const satisfied = assertions.mustCallAnyOf.some(spec => toolCalls.some(call => matchesSpec(call, spec)));
    if (!satisfied) {
      const expected = assertions.mustCallAnyOf.map(describeSpec).join(' OR ');
      const actual = toolCalls.length > 0
        ? toolCalls.map(c => c.name).join(', ')
        : '(no tool calls)';
      reasons.push(`expected agent to call ${expected} — got: ${actual}`);
    }
  }

  if (assertions.mustCallAllOf && assertions.mustCallAllOf.length > 0) {
    // Each entry must be satisfied by at least one call in the trace.
    // Unlike mustCallAnyOf, the failure reason names each unmet entry
    // individually — for a cross-stack fixture the author wants to see
    // "missed Worksheet.cs AND worksheet.ts", not "missed one of…".
    for (const spec of assertions.mustCallAllOf) {
      const hit = toolCalls.some(call => matchesSpec(call, spec));
      if (!hit) {
        reasons.push(`expected call matching ${describeSpec(spec)} was never made`);
      }
    }
  }

  if (assertions.mustNotCall && assertions.mustNotCall.length > 0) {
    for (const forbidden of assertions.mustNotCall) {
      const violation = toolCalls.find(c => c.name === forbidden);
      if (violation) {
        const paramPreview = Object.keys(violation.params).length > 0
          ? ` (params: ${summarizeParams(violation.params)})`
          : '';
        reasons.push(`agent called forbidden tool "${forbidden}" at iteration ${violation.iteration}${paramPreview}`);
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

  return { passed: reasons.length === 0, reasons };
}

function matchesSpec(call: ToolCallTrace, spec: string | ToolCallAssertion): boolean {
  if (typeof spec === 'string') return call.name === spec;
  // Tool-name matching: string for exact, RegExp for OR patterns like
  // /^(apply_edit|replace_range|write_file)$/.
  if (typeof spec.name === 'string') {
    if (call.name !== spec.name) return false;
  } else {
    if (!spec.name.test(call.name)) return false;
  }
  if (!spec.params) return true;
  for (const [key, matcher] of Object.entries(spec.params)) {
    const value = call.params[key];
    if (value === undefined || value === null) return false;
    if (typeof matcher === 'string') {
      if (value !== matcher) return false;
    } else if (matcher instanceof RegExp) {
      if (!matcher.test(value)) return false;
    } else if (typeof matcher === 'function') {
      if (!matcher(value)) return false;
    }
  }
  return true;
}

function describeSpec(spec: string | ToolCallAssertion): string {
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

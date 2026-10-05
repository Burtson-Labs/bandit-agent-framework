import { describe, expect, it } from 'vitest';
import { evaluateRun } from '../src/__eval__/assertions';
import type { FixtureAssertions, ToolCallTrace } from '../src/__eval__/types';

let order = 0;
const ok = (name: string, params: Record<string, string> = {}): ToolCallTrace => ({ name, params, order: order++, iteration: 1, isError: false });
const failed = (name: string, params: Record<string, string> = {}): ToolCallTrace => ({ ...ok(name, params), isError: true });
const grade = (calls: ToolCallTrace[], assertions: FixtureAssertions, response = '') => evaluateRun(calls, 1, response, assertions);

describe('eval assertions: a required call has to have worked', () => {
  const edit: FixtureAssertions = { mustCallAnyOf: [{ name: 'apply_edit', params: { path: /greetings\.ts/ } }] };

  it('does not count an edit the tool rejected', () => {
    // The v3b trace that "passed" refactor.multi_file: every apply_edit was rejected.
    const r = grade([failed('apply_edit', { path: 'src/greetings.ts', find: 'greet' })], edit);
    expect(r.passed).toBe(false);
    expect(r.missingRequiredCalls).toBe(1);
    expect(r.reasons[0]).toMatch(/apply_edit \(failed\)/);
  });

  it('counts the same edit once it succeeds', () => {
    const r = grade([failed('apply_edit', { path: 'greetings.ts' }), ok('apply_edit', { path: 'greetings.ts' })], edit);
    expect(r.passed).toBe(true);
    expect(r.missingRequiredCalls).toBe(0);
  });

  it('counts a failed call when the spec says the attempt is the point', () => {
    const spec: FixtureAssertions = { mustCallAnyOf: [{ name: 'run_command', params: { commandLine: /npm test/ }, allowError: true }] };
    expect(grade([failed('run_command', { cmd: 'npm', args: 'test' })], spec).passed).toBe(true);
    expect(grade([failed('run_command', { cmd: 'npm', args: 'install' })], spec).passed).toBe(false);
  });

  it('plain tool names follow the same rule', () => {
    expect(grade([failed('read_file')], { mustCallAnyOf: ['read_file'] }).passed).toBe(false);
    expect(grade([ok('read_file')], { mustCallAnyOf: ['read_file'] }).passed).toBe(true);
  });
});

describe('eval assertions: mustCallAllOf alternatives', () => {
  const spec: FixtureAssertions = {
    mustCallAllOf: [
      [{ name: /^(list_files|ls)$/ }, { name: 'run_command', params: { commandLine: /^ls\b/ } }],
      { name: 'read_file', params: { path: /deploy/ } }
    ]
  };

  it('accepts any one alternative of a step', () => {
    expect(grade([ok('run_command', { cmd: 'ls', args: 'scripts' }), ok('read_file', { path: 'scripts/deploy.sh' })], spec).passed).toBe(true);
    expect(grade([ok('ls', { path: 'scripts' }), ok('read_file', { path: 'scripts/deploy.sh' })], spec).passed).toBe(true);
  });

  it('names the alternatives of the step that was skipped and counts each missing step', () => {
    const r = grade([ok('read_file', { path: 'scripts/deploy.sh' })], spec);
    expect(r.passed).toBe(false);
    expect(r.missingRequiredCalls).toBe(1);
    expect(r.reasons[0]).toMatch(/list_files\|ls.* OR run_command/);
    expect(grade([], spec).missingRequiredCalls).toBe(2);
  });
});

describe('eval assertions: forbidden calls', () => {
  it('forbids only the calls a {name, params} entry describes', () => {
    const spec: FixtureAssertions = { mustNotCall: [{ name: 'run_command', params: { commandLine: /\bnpm\b/ } }] };
    expect(grade([ok('run_command', { cmd: 'cat', args: 'src/utils/scoring.ts' })], spec).passed).toBe(true);
    const r = grade([ok('run_command', { cmd: 'npm', args: 'test' })], spec);
    expect(r.passed).toBe(false);
    expect(r.reasons[0]).toMatch(/forbidden tool "run_command"/);
  });

  it('an attempt is a violation even when the call failed', () => {
    expect(grade([failed('write_file', { path: 'a.ts' })], { mustNotCall: ['write_file'] }).passed).toBe(false);
  });

  it('a name pattern can forbid every tool', () => {
    const none: FixtureAssertions = { mustNotCall: [{ name: /./ }] };
    expect(grade([], none).passed).toBe(true);
    expect(grade([ok('git_status')], none).passed).toBe(false);
  });
});

describe('eval assertions: first call', () => {
  const spec: FixtureAssertions = { firstCallAnyOf: [{ name: /^(apply_edit|write_file)$/, params: { path: /status\.html/ } }] };

  it('passes when the run opens with the expected call, even one the tool rejected', () => {
    expect(grade([failed('apply_edit', { path: 'status.html' }), ok('read_file', { path: 'status.html' })], spec).passed).toBe(true);
  });

  it('fails when the run opens with something else, or makes no call', () => {
    const r = grade([ok('read_file', { path: 'status.html' }), ok('apply_edit', { path: 'status.html' })], spec);
    expect(r.passed).toBe(false);
    expect(r.reasons[0]).toMatch(/first tool call.*got: read_file/);
    expect(grade([], spec).reasons[0]).toMatch(/\(no tool calls\)/);
  });
});

describe('eval assertions: stateful regexes', () => {
  it('a /g matcher gives the same answer on every call', () => {
    const spec: FixtureAssertions = { mustCallAnyOf: [{ name: 'read_file', params: { path: /config/g } }] };
    for (let i = 0; i < 3; i++) expect(grade([ok('read_file', { path: 'config/a.json' })], spec).passed).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { evaluateRun } from '../src/__eval__/assertions';
import { buildRunTrace, TRACE_WORKSPACE } from '../src/__eval__/traceOut';
import { editVerifyLabels } from '../src/training/quality';
import type { ToolCallTrace } from '../src/__eval__/types';

const call = (name: string, params: Record<string, string>): ToolCallTrace => ({ name, params, order: 0, iteration: 1 });

describe('eval harness: synthetic-task assertions', () => {
  it('grades final file content exactly (trailing whitespace ignored), by regex, and by absence', () => {
    const assertions = { finalFiles: { 'a.ts': 'export const X = 5;', 'b.md': /## Done/, 'gone.txt': null } };
    expect(evaluateRun([], 1, '', assertions, { 'a.ts': 'export const X = 5;\n', 'b.md': '# T\n## Done\n', 'gone.txt': null }).passed).toBe(true);
    const bad = evaluateRun([], 1, '', assertions, { 'a.ts': 'export const X = 50;\n', 'b.md': '# T\n', 'gone.txt': 'still here' });
    expect(bad.passed).toBe(false);
    expect(bad.reasons.join('\n')).toMatch(/a\.ts content did not match/);
    expect(bad.reasons.join('\n')).toMatch(/b\.md content did not match/);
    expect(bad.reasons.join('\n')).toMatch(/gone\.txt should not exist/);
    expect(evaluateRun([], 1, '', { finalFiles: { 'a.ts': 'x' } }, { 'a.ts': null }).reasons[0]).toMatch(/missing after the run/);
  });

  it('compares text line for line, ignoring blank lines and trailing whitespace', () => {
    const expected = { finalFiles: { 'a.ts': 'export function f() {\n  return 1;\n}\n' } };
    const grade = (actual: string) => evaluateRun([], 1, '', expected, { 'a.ts': actual }).passed;
    // What replace_range leaves when its content ends in a newline: one stray blank line.
    expect(grade('export function f() {\n\n  return 1;\n}\n')).toBe(true);
    expect(grade('export function f() {  \r\n  return 1;\r\n}')).toBe(true);
    // Indentation, content and order still count.
    expect(grade('export function f() {\nreturn 1;\n}\n')).toBe(false);
    expect(grade('export function f() {\n  return 2;\n}\n')).toBe(false);
    expect(grade('  return 1;\nexport function f() {\n}\n')).toBe(false);
    expect(grade('export function f() {\n  return 1;\n}\n// extra\n')).toBe(false);
  });

  it('compares a .json file as JSON, and never accepts invalid JSON', () => {
    const expected = { finalFiles: { 'config/features.json': JSON.stringify({ darkMode: true, betaSearch: true, maxUploadMb: 25 }, null, 2) } };
    const grade = (actual: string) => evaluateRun([], 1, '', expected, { 'config/features.json': actual }).passed;
    // qwen3:14b, 2026-10-05: apply_edit matched across the line break and joined two lines.
    expect(grade('{    "darkMode": true,\n  "betaSearch": true,\n  "maxUploadMb": 25\n}')).toBe(true);
    expect(grade('{"maxUploadMb":25,"betaSearch":true,"darkMode":true}')).toBe(true);
    // qwen3:8b: the key itself was damaged.
    expect(grade('{\n  "dark,Mode": true,\n  "betaSearch": true,\n  "maxUploadMb": 25\n}')).toBe(false);
    expect(grade('{\n  "darkMode": false,\n  "betaSearch": true,\n  "maxUploadMb": 25\n}')).toBe(false);
    expect(grade('{\n  "darkMode": true,\n  "betaSearch": true\n}')).toBe(false);
    expect(grade('{\n  "darkMode": true,\n  "betaSearch": true,\n  "maxUploadMb": 25,\n}')).toBe(false);
  });

  it('matches commandLine against run_command cmd plus separate args', () => {
    const spec = { mustCallAnyOf: [{ name: 'run_command', params: { commandLine: /npm (run )?test/ } }] };
    expect(evaluateRun([call('run_command', { cmd: 'npm', args: 'test' })], 1, '', spec).passed).toBe(true);
    expect(evaluateRun([call('run_command', { cmd: 'npm test' })], 1, '', spec).passed).toBe(true);
    expect(evaluateRun([call('run_command', { cmd: 'npm', args: 'install' })], 1, '', spec).passed).toBe(false);
  });
});

describe('eval harness: trace-out', () => {
  it('replaces the throwaway sandbox path with a stable project path', () => {
    const root = '/var/folders/zz/abc/T/bandit-eval-syn.x-Qq12';
    const trace = buildRunTrace({
      fixtureId: 'syn.x', runNumber: 1, model: 'teacher', systemPrompt: `Workspace: ${root}`,
      tools: [], hitLimit: false, passed: true, failureReasons: [], workspaceRoot: root,
      messages: [
        { role: 'user', content: 'fix it' },
        { role: 'assistant', content: '<tool_call>{"name":"search_code","params":{"pattern":"X"}}</tool_call>' },
        { role: 'user', content: `<tool_result name="search_code">\n/private${root}/src/a.ts:1:X\n${root}/src/b.ts:2:X\n</tool_result>` },
        { role: 'assistant', content: 'done' }
      ]
    });
    const text = JSON.stringify(trace.messages);
    expect(text).not.toContain('bandit-eval-syn');
    expect(text).toContain(`${TRACE_WORKSPACE}/src/a.ts`);
    expect(text).toContain(`${TRACE_WORKSPACE}/src/b.ts`);
    expect(trace.labels.passed).toBe(true);
  });
});

describe('training quality: verified label', () => {
  it('sees a test run whose arguments are split from the command', () => {
    const turn = [
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'a', type: 'function' as const, function: { name: 'apply_edit', arguments: '{"path":"src/x.js","find":"1","replace":"2"}' } }] },
      { role: 'tool' as const, tool_call_id: 'a', name: 'apply_edit', content: 'ok' },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'b', type: 'function' as const, function: { name: 'run_command', arguments: '{"cmd":"npm","args":"test"}' } }] }
    ];
    expect(editVerifyLabels(turn as never)).toEqual({ edited: true, verified: true });
  });
});

/**
 * run_command and interpreters (2026-10-20 benchmark, gemma4:12b): code sent
 * as `python_script` / `python_args` used to be dropped, so a bare `python3`
 * read an empty stdin, exited 0 and counted as a passing check.
 */
import { describe, expect, it } from 'vitest';
import { runCommandTool } from '../src/tools/core-tools';
import type { ToolExecutionContext } from '../src/tools/tool-types';

function ctxRecording(calls: Array<{ cmd: string; args: string[] }>): ToolExecutionContext {
  return {
    workspaceRoot: '/ws',
    async readFile() { throw new Error('ENOENT'); },
    async writeFile() {},
    async listFiles() { return []; },
    async searchCode() { return ''; },
    async runCommand(cmd: string, args: string[]) {
      calls.push({ cmd, args });
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    }
  };
}

describe('run_command with an interpreter', () => {
  it('runs python_script as python3 -c <code>', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const code = 'from acme.stamps import report_stamp\nassert report_stamp().endswith("+00:00")';
    const r = await runCommandTool.execute({ cmd: 'python3', python_script: code }, ctxRecording(calls));
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([{ cmd: 'python3', args: ['-c', code] }]);
  });

  it('takes python_args as the args', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    await runCommandTool.execute({ cmd: 'python3', python_args: '-c "print(1)"' }, ctxRecording(calls));
    expect(calls).toEqual([{ cmd: 'python3', args: ['-c', 'print(1)'] }]);
  });

  it('refuses a bare interpreter instead of reporting exit 0', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const r = await runCommandTool.execute({ cmd: 'python3' }, ctxRecording(calls));
    expect(r.isError).toBe(true);
    expect(r.output).toContain('runs nothing here');
    expect(calls).toHaveLength(0);
    const n = await runCommandTool.execute({ cmd: 'node', args: '' }, ctxRecording(calls));
    expect(n.isError).toBe(true);
    expect(n.output).toContain('-e');
  });

  it('leaves normal calls alone', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    await runCommandTool.execute({ cmd: 'python3', args: '-m unittest -q' }, ctxRecording(calls));
    await runCommandTool.execute({ cmd: 'git', args: 'status' }, ctxRecording(calls));
    await runCommandTool.execute({ cmd: 'npx', args: 'vitest run', script: 'ignored for non-interpreters' }, ctxRecording(calls));
    expect(calls).toEqual([
      { cmd: 'python3', args: ['-m', 'unittest', '-q'] },
      { cmd: 'git', args: ['status'] },
      { cmd: 'npx', args: ['vitest', 'run'] }
    ]);
  });
});

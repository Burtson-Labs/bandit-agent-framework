import { describe, expect, it } from 'vitest';
import { readFileTool, replaceRangeTool } from '../src/tools/core-tools';
import type { ToolExecutionContext } from '../src/tools/tool-types';

function buildCtx(files: Map<string, string>): ToolExecutionContext {
  const read = new Set<string>();
  return {
    workspaceRoot: '/tmp/test',
    async readFile(p: string) {
      const hit = files.get(p);
      if (hit === undefined) throw new Error('ENOENT');
      return hit;
    },
    async writeFile(p: string, content: string) {
      files.set(p, content);
    },
    async listFiles() { return []; },
    async searchCode() { return ''; },
    async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; },
    markFileRead(p: string) { read.add(p); },
    hasFileBeenRead(p: string) { return read.has(p); }
  };
}

function shownHash(output: string): string {
  const match = /shown_hash=([0-9a-f]+)/.exec(output);
  if (!match) throw new Error(`missing shown_hash in output: ${output}`);
  return match[1];
}

describe('replace_range', () => {
  it('replaces a line range using read_file line numbers and shown_hash', async () => {
    const files = new Map<string, string>([
      ['/tmp/test/src/app.ts', ['one', 'two', 'three', 'four'].join('\n')]
    ]);
    const ctx = buildCtx(files);

    const read = await readFileTool.execute({ path: 'src/app.ts', offset: '2', limit: '2' }, ctx);
    const hash = shownHash(read.output);
    const result = await replaceRangeTool.execute({
      path: 'src/app.ts',
      start_line: '2',
      end_line: '3',
      content: 'TWO\nTHREE',
      expected_hash: hash
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(files.get('/tmp/test/src/app.ts')).toBe(['one', 'TWO', 'THREE', 'four'].join('\n'));
    expect(result.output).toContain('Replaced lines 2-3');
  });

  it('inserts before a line when end_line is start_line minus one', async () => {
    const files = new Map<string, string>([
      ['/tmp/test/src/app.ts', ['one', 'three'].join('\n')]
    ]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'src/app.ts' }, ctx);

    const result = await replaceRangeTool.execute({
      path: 'src/app.ts',
      start_line: '2',
      end_line: '1',
      content: 'two'
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(files.get('/tmp/test/src/app.ts')).toBe(['one', 'two', 'three'].join('\n'));
    expect(result.output).toContain('Inserted 1 line before line 2');
  });

  it('stale expected_hash no longer blocks the edit — proceeds with a warning trailer (2026-05-26 right-way fix)', async () => {
    // Prior behavior rejected on hash mismatch, which created a loop:
    // model copied shown_hash from a wider read_file and called
    // replace_range with it; hashes diverged (different byte ranges);
    // tool rejected; model re-read and got tripped up again. The hash
    // was always weaker safety than the hasFileBeenRead guard, so it
    // now warns instead of blocking — the actual edit lands and the
    // model's next turn sees the warning if it cares.
    const lines = ['L1', 'L2', 'L3', 'L4', 'L5'];
    const files = new Map<string, string>([
      ['/tmp/test/src/app.ts', lines.join('\n')]
    ]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'src/app.ts' }, ctx);

    const result = await replaceRangeTool.execute({
      path: 'src/app.ts',
      start_line: '2',
      end_line: '3',
      content: 'X',
      expected_hash: 'deadbeef' // deliberately wrong
    }, ctx);

    // Edit succeeds (no isError).
    expect(result.isError).toBeFalsy();
    // File was actually written with the replacement.
    expect(files.get('/tmp/test/src/app.ts')).toBe(['L1', 'X', 'L4', 'L5'].join('\n'));
    // Warning is surfaced in the result so the model can see something
    // diverged without it being a hard failure.
    expect(result.output).toContain('expected_hash');
    expect(result.output).toMatch(/expected_hash deadbeef did not match/);
    expect(result.output).toMatch(/current range hash [0-9a-f]+/);
    // Tells the model to drop expected_hash on follow-ups instead of looping.
    expect(result.output).toMatch(/Drop expected_hash on follow-ups/);
  });

  it('expected_old still rejects on mismatch (strict surgical guard kept)', async () => {
    // expected_old is opt-in tight matching for short edits where the
    // model knows exactly which line(s) it's targeting. Unlike
    // expected_hash, this stays REJECT-on-mismatch — the model passes
    // it intentionally and a mismatch means "the line I thought I was
    // targeting isn't there." Different failure shape, deserves a hard stop.
    const lines = ['L1', 'L2', 'L3'];
    const files = new Map<string, string>([
      ['/tmp/test/src/app.ts', lines.join('\n')]
    ]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'src/app.ts' }, ctx);

    const result = await replaceRangeTool.execute({
      path: 'src/app.ts',
      start_line: '2',
      end_line: '2',
      content: 'X',
      expected_old: 'NOT_THE_REAL_LINE'
    }, ctx);

    expect(result.isError).toBe(true);
    expect(files.get('/tmp/test/src/app.ts')).toBe(lines.join('\n'));
  });

  it('requires the target file to be read first when the host tracks reads', async () => {
    const files = new Map<string, string>([
      ['/tmp/test/src/app.ts', ['one', 'two'].join('\n')]
    ]);
    const ctx = buildCtx(files);

    const result = await replaceRangeTool.execute({
      path: 'src/app.ts',
      start_line: '2',
      end_line: '2',
      content: 'TWO'
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('you have not read this file');
    expect(files.get('/tmp/test/src/app.ts')).toBe(['one', 'two'].join('\n'));
  });
});

/**
 * Contract tests for `apply_patch` per-hunk recovery (v1.7.298).
 *
 * Prior behavior aborted the ENTIRE multi-file patch on first hunk
 * failure. Real CLI session 2026-05-26: 5-file unified diff,
 * first hunk applied cleanly, second hunk's context lines had
 * drifted by one character from a prior edit, whole patch rejected
 * with "Applied 1 hunk" and the remaining 4 files silently skipped.
 * Model then regenerated the whole patch instead of just the
 * failed hunks.
 *
 * v1.7.298 answered that by applying hunks independently and writing
 * whatever matched ("Partially updated", isError:false). That left
 * half-applied refactors on disk with an all-clear, so since the
 * 2026-11 harness audit the contract is atomic:
 *   - Every hunk of every action is tried, so the report names ALL the
 *     failing hunks with what was searched for (the model fixes just those)
 *   - Hunks that fail exact match try a whitespace-tolerant fallback,
 *     which keeps the file's own indentation
 *   - Any failure writes NOTHING and returns isError:true
 *   - CRLF files keep CRLF
 */
import { describe, expect, it } from 'vitest';
import { applyPatchTool, readFileTool } from '../src/tools/core-tools';
import type { ToolExecutionContext } from '../src/tools/tool-types';

function buildCtx(files: Map<string, string>): ToolExecutionContext {
  const reads = new Set<string>();
  return {
    workspaceRoot: '/tmp/test',
    async readFile(p: string) {
      reads.add(p);
      const content = files.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    async writeFile(p: string, content: string) {
      files.set(p, content);
    },
    async listFiles() { return []; },
    async searchCode() { return ''; },
    async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; },
    hasFileBeenRead: (p: string) => reads.has(p)
  };
}

describe('apply_patch per-hunk reporting, atomic writes', () => {
  it('one broken hunk writes nothing, returns isError:true, and names that hunk', async () => {
    const a = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n');
    const files = new Map<string, string>([['/tmp/test/a.txt', a]]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'a.txt' }, ctx);

    const patch = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@ first',
      '-line 1',
      '+LINE 1',
      '@@ broken — wrong context',
      ' nonexistent context',
      '-line 9999',
      '+REPLACED',
      '@@ third',
      '-line 5',
      '+LINE 5',
      '*** End Patch'
    ].join('\n');

    const result = await applyPatchTool.execute({ patch }, ctx);
    // Changed deliberately (was isError:false + "Partially updated" with
    // hunks 1 and 3 written): a patch now lands whole or not at all.
    expect(result.isError).toBe(true);
    expect(files.get('/tmp/test/a.txt')).toBe(a);
    expect(result.output).toMatch(/wrote nothing/);
    expect(result.output).toMatch(/FAILED Update a\.txt: 2\/3 hunks matched, 1 did not/);
    expect(result.output).toMatch(/hunk #2/);
    expect(result.output).not.toMatch(/hunk #1|hunk #3/);
  });

  it('whitespace-tolerant fallback: extra spaces in find text still match', async () => {
    // File has tabs + single spaces. Model emits the patch with
    // multiple spaces. Exact match fails; whitespace-collapsed match
    // succeeds; replacement lands at the right line range.
    const file = ['function foo() {', '\treturn 1;', '}'].join('\n');
    const files = new Map<string, string>([['/tmp/test/a.ts', file]]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'a.ts' }, ctx);

    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      // Model emitted four spaces; file uses a tab.
      '-    return 1;',
      '+    return 2;',
      '*** End Patch'
    ].join('\n');

    const result = await applyPatchTool.execute({ patch }, ctx);
    expect(result.isError).toBeFalsy();
    // The substitution landed — file now has `return 2;`.
    expect(files.get('/tmp/test/a.ts')).toContain('return 2;');
    expect(files.get('/tmp/test/a.ts')).not.toContain('return 1;');
  });

  it('all hunks failing leaves the file untouched and returns isError:true', async () => {
    const original = ['alpha', 'beta', 'gamma'].join('\n');
    const files = new Map<string, string>([['/tmp/test/a.txt', original]]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'a.txt' }, ctx);

    const patch = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      '-not in file',
      '+replacement',
      '@@',
      '-also not in file',
      '+replacement 2',
      '*** End Patch'
    ].join('\n');

    const result = await applyPatchTool.execute({ patch }, ctx);
    expect(result.isError).toBe(true);
    // File is exactly what it was.
    expect(files.get('/tmp/test/a.txt')).toBe(original);
    expect(result.output).toMatch(/0\/2 hunks matched, 2 did not/);
    expect(result.output).toMatch(/wrote nothing/);
  });

  it('multi-action: one file failing means the other file is not written either', async () => {
    const fileA = ['A1', 'A2'].join('\n');
    const fileB = ['B1', 'B2'].join('\n');
    const files = new Map<string, string>([
      ['/tmp/test/a.txt', fileA],
      ['/tmp/test/b.txt', fileB]
    ]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'a.txt' }, ctx);
    await readFileTool.execute({ path: 'b.txt' }, ctx);

    const patch = [
      '*** Begin Patch',
      '*** Update File: b.txt',
      '@@',
      '-B1',
      '+BEE 1',
      '*** Update File: a.txt',
      '@@',
      '-not in file',
      '+nope',
      '*** Add File: c.txt',
      '+new',
      '*** End Patch'
    ].join('\n');

    const result = await applyPatchTool.execute({ patch }, ctx);
    // Changed deliberately (was isError:false with b.txt written): the
    // earlier action b.txt staged fine but must not land without a.txt.
    expect(result.isError).toBe(true);
    expect(files.get('/tmp/test/a.txt')).toBe(fileA);
    expect(files.get('/tmp/test/b.txt')).toBe(fileB);
    expect(files.has('/tmp/test/c.txt')).toBe(false);
    expect(result.output).toMatch(/FAILED Update a\.txt/);
    expect(result.output).toMatch(/1 of 3 actions failed/);
    expect(result.output).toMatch(/2 other actions matched/);
  });

  it('a write failure part-way restores the files already written', async () => {
    const files = new Map<string, string>([
      ['/tmp/test/a.txt', 'A1\n'],
      ['/tmp/test/b.txt', 'B1\n']
    ]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'a.txt' }, ctx);
    await readFileTool.execute({ path: 'b.txt' }, ctx);
    const realWrite = ctx.writeFile.bind(ctx);
    let failNext = true;
    ctx.writeFile = async (p: string, content: string) => {
      if (p.endsWith('b.txt') && failNext) { failNext = false; throw new Error('EACCES: permission denied'); }
      return realWrite(p, content);
    };
    const patch = ['*** Begin Patch', '*** Update File: a.txt', '-A1', '+AA', '*** Update File: b.txt', '-B1', '+BB', '*** End Patch'].join('\n');
    const result = await applyPatchTool.execute({ patch }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/FAILED Update b\.txt: EACCES/);
    expect(result.output).toMatch(/restored; nothing changed/);
    expect(files.get('/tmp/test/a.txt')).toBe('A1\n');
    expect(files.get('/tmp/test/b.txt')).toBe('B1\n');
  });

  it('keeps CRLF line endings on a CRLF file', async () => {
    const crlf = 'one\r\ntwo\r\nthree\r\n';
    const files = new Map<string, string>([['/tmp/test/w.txt', crlf]]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'w.txt' }, ctx);
    const patch = ['*** Begin Patch', '*** Update File: w.txt', ' one', '-two', '+TWO', '+two and a half', '*** End Patch'].join('\n');
    const result = await applyPatchTool.execute({ patch }, ctx);
    expect(result.isError).toBeFalsy();
    expect(files.get('/tmp/test/w.txt')).toBe('one\r\nTWO\r\ntwo and a half\r\nthree\r\n');
  });

  it('whitespace-tolerant fallback keeps the file\'s indentation (Python block)', async () => {
    // The file nests the block at 8 spaces; the model wrote the hunk at 4.
    // Splicing the replacement as written would dedent it out of the
    // method body and change what the code does.
    const py = ['class A:', '    def f(self):', '        if x:', '            return 1', '        return 2', ''].join('\n');
    const files = new Map<string, string>([['/tmp/test/a.py', py]]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'a.py' }, ctx);
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.py',
      '@@',
      '-    if x:',
      '-        return 1',
      '+    if x and y:',
      '+        log()',
      '+        return 1',
      '*** End Patch'
    ].join('\n');
    const result = await applyPatchTool.execute({ patch }, ctx);
    expect(result.isError).toBeFalsy();
    expect(files.get('/tmp/test/a.py')).toBe(
      ['class A:', '    def f(self):', '        if x and y:', '            log()', '            return 1', '        return 2', ''].join('\n')
    );
  });
});

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
 * New contract:
 *   - Each hunk attempts independently
 *   - Hunks that match cleanly apply
 *   - Hunks that fail exact match try a whitespace-tolerant fallback
 *   - Failures don't poison sibling hunks in the same action OR
 *     sibling actions in the same patch
 *   - Partial-success returns isError:false with detailed per-hunk
 *     pass/fail notes so the model can retarget just the failures
 *   - All-failure returns isError:true with the same detail
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

describe('apply_patch per-hunk recovery (v1.7.298)', () => {
  it('partial success: applies the hunks that match, skips the broken one, returns isError:false', async () => {
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
    expect(result.isError).toBeFalsy();
    // First and third hunks landed.
    const after = files.get('/tmp/test/a.txt')!;
    expect(after.startsWith('LINE 1')).toBe(true);
    expect(after.endsWith('LINE 5')).toBe(true);
    // The middle line is untouched.
    expect(after).toContain('line 2');
    expect(after).toContain('line 3');
    // Report names the failing hunk so the model can retry just it.
    expect(result.output).toMatch(/Partially updated.*a\.txt/);
    expect(result.output).toMatch(/2\/3 hunks applied/);
    expect(result.output).toMatch(/hunk #2/);
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
    expect(result.output).toMatch(/0\/2 hunks applied/);
    expect(result.output).toMatch(/file left untouched/);
  });

  it('multi-action: one file failing does not block the next file from applying', async () => {
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
      '*** Update File: a.txt',
      '@@',
      '-not in file',
      '+nope',
      '*** Update File: b.txt',
      '@@',
      '-B1',
      '+BEE 1',
      '*** End Patch'
    ].join('\n');

    const result = await applyPatchTool.execute({ patch }, ctx);
    // Overall not isError because b.txt landed.
    expect(result.isError).toBeFalsy();
    // a.txt unchanged.
    expect(files.get('/tmp/test/a.txt')).toBe(fileA);
    // b.txt updated.
    expect(files.get('/tmp/test/b.txt')).toContain('BEE 1');
    // Report names both outcomes.
    expect(result.output).toMatch(/FAILED Update a\.txt/);
    expect(result.output).toMatch(/Updated:? b\.txt/);
  });
});

/**
 * apply_patch must apply every file of a multi-file unified diff.
 *
 * BanditBench 2026-10-05, qwen3.6:27b, edit.rename_across_files: one diff covering
 * src/format.ts and src/render.ts came back as "Applied 1 hunk to "src/format.ts"" and
 * nothing else. The parser read the first file's hunks and stopped at the second header;
 * render.ts was never touched and the result did not say so.
 */
import { describe, expect, it } from 'vitest';
import { applyPatchTool } from '../src/tools/core-tools';
import { patchPaths } from '../src/tools/loop/parallelExecute';
import { splitUnifiedPatchByFile } from '../src/tools/unified-patch';
import type { ToolExecutionContext } from '../src/tools/tool-types';
import { testCtx } from './_helpers';

const FORMAT = 'export function formatUser(name: string, id: number): string {\n  return `${name} (#${id})`;\n}\n';
const RENDER = "import { formatUser } from './format';\n\nexport function renderRow(name: string, id: number): string {\n  return `<td>${formatUser(name, id)}</td>`;\n}\n";

/** The patch from the trace, verbatim. */
const RENAME_PATCH = [
  '--- a/src/format.ts',
  '+++ b/src/format.ts',
  '@@ -1,3 +1,3 @@',
  '-export function formatUser(name: string, id: number): string {',
  '+export function formatUserLabel(name: string, id: number): string {',
  '   return `${name} (#${id})`;',
  ' }',
  '',
  '--- a/src/render.ts',
  '+++ b/src/render.ts',
  '@@ -1,5 +1,5 @@',
  "-import { formatUser } from './format';",
  "+import { formatUserLabel } from './format';",
  ' ',
  ' export function renderRow(name: string, id: number): string {',
  '-  return `<td>${formatUser(name, id)}</td>`;',
  '+  return `<td>${formatUserLabel(name, id)}</td>`;',
  ' }'
].join('\n');

function memoryCtx(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const ctx: ToolExecutionContext = {
    ...testCtx,
    workspaceRoot: '/work',
    async readFile(p: string) { if (!files.has(p)) {throw new Error(`ENOENT: ${p}`);} return files.get(p)!; },
    async writeFile(p: string, content: string) { files.set(p, content); }
  };
  return { files, ctx };
}

describe('apply_patch with a multi-file unified diff', () => {
  it('applies both files of the rename patch and says so', async () => {
    const { files, ctx } = memoryCtx({ '/work/src/format.ts': FORMAT, '/work/src/render.ts': RENDER });
    const result = await applyPatchTool.execute({ patch: RENAME_PATCH }, ctx);
    expect(result.isError).toBeFalsy();
    expect(files.get('/work/src/format.ts')).toBe(FORMAT.replace('formatUser', 'formatUserLabel'));
    expect(files.get('/work/src/render.ts')).toBe(RENDER.replaceAll('formatUser', 'formatUserLabel'));
    expect(result.output).toContain('to "src/format.ts"');
    expect(result.output).toContain('to "src/render.ts"');
  });

  it('git-style diffs (diff --git / index lines) and three files', async () => {
    const { files, ctx } = memoryCtx({ '/work/a.txt': 'one\n', '/work/b.txt': 'two\n', '/work/c.txt': 'three\n' });
    const patch = ['a', 'b', 'c'].map((name, n) => [
      `diff --git a/${name}.txt b/${name}.txt`,
      'index 1111111..2222222 100644',
      `--- a/${name}.txt`,
      `+++ b/${name}.txt`,
      '@@ -1 +1 @@',
      `-${['one', 'two', 'three'][n]}`,
      `+${['ONE', 'TWO', 'THREE'][n]}`
    ].join('\n')).join('\n');
    const result = await applyPatchTool.execute({ patch }, ctx);
    expect(result.isError).toBeFalsy();
    expect([...files.values()]).toEqual(['ONE\n', 'TWO\n', 'THREE\n']);
  });

  it('one file failing is reported by name and does not stop the others', async () => {
    const { files, ctx } = memoryCtx({ '/work/src/format.ts': FORMAT, '/work/src/render.ts': 'something else entirely\n' });
    const result = await applyPatchTool.execute({ patch: RENAME_PATCH }, ctx);
    expect(result.isError).toBeFalsy(); // partial success, as with the Codex envelope
    expect(files.get('/work/src/format.ts')).toContain('formatUserLabel');
    expect(files.get('/work/src/render.ts')).toBe('something else entirely\n');
    expect(result.output).toContain('apply_patch applied 1 of 2 files');
    expect(result.output).toContain('FAILED "src/render.ts"');
    expect(result.output).toContain('NOT changed');
  });

  it('is an error when no file applies', async () => {
    const { files, ctx } = memoryCtx({ '/work/src/format.ts': 'nope\n', '/work/src/render.ts': 'nope\n' });
    const result = await applyPatchTool.execute({ patch: RENAME_PATCH }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('failed for all 2 files');
    expect([...files.values()]).toEqual(['nope\n', 'nope\n']);
  });

  it('a single-file diff behaves as before, including the explicit path override', async () => {
    const { files, ctx } = memoryCtx({ '/work/src/format.ts': FORMAT });
    const single = RENAME_PATCH.split('\n').slice(0, 7).join('\n');
    const result = await applyPatchTool.execute({ patch: single.replace(/src\/format\.ts/g, 'wrong/name.ts'), path: 'src/format.ts' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('Applied 1 hunk to "src/format.ts" (4 lines after).');
    expect(files.get('/work/src/format.ts')).toContain('formatUserLabel');
  });
});

describe('splitUnifiedPatchByFile', () => {
  it('splits at each file header and keeps a one-file diff whole', () => {
    const sections = splitUnifiedPatchByFile(RENAME_PATCH);
    expect(sections).toHaveLength(2);
    expect(sections[0].startsWith('--- a/src/format.ts')).toBe(true);
    expect(sections[1].startsWith('--- a/src/render.ts')).toBe(true);
    expect(splitUnifiedPatchByFile(sections[1])).toEqual([sections[1]]);
  });

  it('does not mistake a removed "-- comment" line for a file header', () => {
    const patch = ['--- a/q.sql', '+++ b/q.sql', '@@ -1,3 +1,2 @@', ' SELECT 1;', '--- old note', ' SELECT 2;'].join('\n');
    expect(splitUnifiedPatchByFile(patch)).toHaveLength(1);
  });

  it('sees every file the lock and permission checks see', () => {
    expect(splitUnifiedPatchByFile(RENAME_PATCH)).toHaveLength(new Set(patchPaths(RENAME_PATCH).map((p) => p.replace(/^[ab]\//, ''))).size);
  });
});

/**
 * Same-file writes in one parallel batch must not race.
 *
 * Found by the synthetic edit-task run (2026-10-04): a model that sent two
 * apply_edit calls on the same file in one turn got "Replaced 1 occurrence…
 * File saved" for both, but only the last write survived — both edits read the
 * original before either wrote. The model then reported success. Calls on
 * different files, and reads, must stay concurrent.
 */
import { describe, expect, it } from 'vitest';
import {
  executeParallelBatch,
  mutationKeys,
  patchPaths
} from '../src/tools/loop/parallelExecute';
import { applyEditTool, applyPatchTool, readFileTool, writeFileTool } from '../src/tools/core-tools';
import type { ToolExecutionContext } from '../src/tools/tool-types';
import type { ParsedToolCall } from '../src/tools/tool-use-parser';
import type { ToolDispatchResult } from '../src/tools/loop/singleToolExecute';
import { buildEmitRecorder } from './_helpers';

const ROOT = '/work';

/** A filesystem whose reads and writes yield, so concurrent edits interleave the way real I/O does. */
function slowFs(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const ctx: ToolExecutionContext = {
    workspaceRoot: ROOT,
    async readFile(p: string) { await tick(); if (!files.has(p)) {throw new Error(`ENOENT ${p}`);} return files.get(p)!; },
    async writeFile(p: string, content: string) { await tick(); files.set(p, content); },
    async listFiles() { return []; },
    async searchCode() { return ''; },
    async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
  };
  return { files, ctx };
}

const TOOLS = { apply_edit: applyEditTool, write_file: writeFileTool, read_file: readFileTool, apply_patch: applyPatchTool };

function call(name: keyof typeof TOOLS, params: Record<string, string>): ParsedToolCall {
  return { name, params, id: `${name}-${Math.random().toString(36).slice(2, 7)}` };
}

async function runBatch(ctx: ToolExecutionContext, calls: ParsedToolCall[], onStart?: (c: ParsedToolCall) => void) {
  const { emit } = buildEmitRecorder();
  const dispatchOne = async (c: ParsedToolCall): Promise<ToolDispatchResult> => {
    onStart?.(c);
    const res = await TOOLS[c.name as keyof typeof TOOLS].execute(c.params, ctx);
    return { name: c.name, output: res.output, isError: res.isError };
  };
  return executeParallelBatch({
    toolCalls: calls, dispatchOne, outputBudgetTokens: Infinity, outputBudgetRatio: 0.6, emit, iteration: 1, workspaceRoot: ROOT
  });
}

describe('same-file mutating tools are serialized within a parallel batch', () => {
  it('two apply_edit calls on one file in one turn both land', async () => {
    const { files, ctx } = slowFs({ [`${ROOT}/src/a.ts`]: 'function one() {}\nfunction two() {}\n' });
    const results = await runBatch(ctx, [
      call('apply_edit', { path: 'src/a.ts', find: 'function one() {}', replace: '/** One. */\nfunction one() {}' }),
      call('apply_edit', { path: 'src/a.ts', find: 'function two() {}', replace: '/** Two. */\nfunction two() {}' })
    ]);
    expect(results.every((r) => !r.isError)).toBe(true);
    const text = files.get(`${ROOT}/src/a.ts`)!;
    expect(text).toContain('/** One. */');
    expect(text).toContain('/** Two. */');
  });

  it('relative and absolute spellings of one file share a lock', async () => {
    const abs = `${ROOT}/src/a.ts`;
    const { files, ctx } = slowFs({ [abs]: 'a\nb\n' });
    await runBatch(ctx, [
      call('apply_edit', { path: 'src/a.ts', find: 'a', replace: 'A' }),
      call('apply_edit', { path: abs, find: 'b', replace: 'B' })
    ]);
    expect(files.get(abs)).toBe('A\nB\n');
  });

  it('write_file then apply_edit on the same file runs in call order', async () => {
    const { files, ctx } = slowFs({ [`${ROOT}/notes.md`]: 'old\n' });
    const results = await runBatch(ctx, [
      call('write_file', { path: 'notes.md', content: 'fresh draft\n' }),
      call('apply_edit', { path: 'notes.md', find: 'fresh draft', replace: 'final draft' })
    ]);
    expect(results.map((r) => r.isError ?? false)).toEqual([false, false]);
    expect(files.get(`${ROOT}/notes.md`)).toBe('final draft\n');
  });

  it('writes to different files and reads still start concurrently', async () => {
    const { ctx } = slowFs({ [`${ROOT}/a.ts`]: 'x', [`${ROOT}/b.ts`]: 'y', [`${ROOT}/c.ts`]: 'z' });
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const calls = [
      call('apply_edit', { path: 'a.ts', find: 'x', replace: 'X' }),
      call('apply_edit', { path: 'b.ts', find: 'y', replace: 'Y' }),
      call('read_file', { path: 'c.ts' })
    ];
    const { emit } = buildEmitRecorder();
    await executeParallelBatch({
      toolCalls: calls,
      dispatchOne: async (c) => {
        started.push(c.params.path);
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        const res = await TOOLS[c.name as keyof typeof TOOLS].execute(c.params, ctx);
        inFlight--;
        return { name: c.name, output: res.output, isError: res.isError };
      },
      outputBudgetTokens: Infinity, outputBudgetRatio: 0.6, emit, iteration: 1, workspaceRoot: ROOT
    });
    expect(maxInFlight).toBe(3);
  });

  it('an apply_patch locks every file it names', async () => {
    const { files, ctx } = slowFs({ [`${ROOT}/a.ts`]: 'alpha\n', [`${ROOT}/b.ts`]: 'beta\n' });
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      '-alpha',
      '+ALPHA',
      '*** Update File: b.ts',
      '@@',
      '-beta',
      '+BETA',
      '*** End Patch'
    ].join('\n');
    await runBatch(ctx, [
      call('apply_patch', { patch }),
      call('apply_edit', { path: 'b.ts', find: 'BETA', replace: 'BETA!' })
    ]);
    expect(files.get(`${ROOT}/a.ts`)).toBe('ALPHA\n');
    expect(files.get(`${ROOT}/b.ts`)).toBe('BETA!\n');
  });
});

describe('lock keys', () => {
  it('only file writers get keys; unknown targets get the wildcard', () => {
    expect(mutationKeys({ name: 'read_file', params: { path: 'a.ts' } }, ROOT)).toEqual([]);
    expect(mutationKeys({ name: 'apply_edit', params: { path: 'src/../a.ts' } }, ROOT)).toEqual(['/work/a.ts']);
    expect(mutationKeys({ name: 'apply_patch', params: { patch: 'no headers here' } }, ROOT)).toEqual(['*']);
  });

  it('reads paths from both patch formats', () => {
    expect(patchPaths('--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b')).toEqual(['a/src/x.ts', 'b/src/x.ts']);
    expect(mutationKeys({ name: 'apply_patch', params: { patch: '--- a/src/x.ts\n+++ b/src/x.ts\n@@\n-a\n+b' } }, ROOT)).toEqual(['/work/src/x.ts']);
    expect(patchPaths('*** Begin Patch\n*** Add File: n.ts\n+hi\n*** Delete File: old.ts\n*** End Patch')).toEqual(['n.ts', 'old.ts']);
  });
});

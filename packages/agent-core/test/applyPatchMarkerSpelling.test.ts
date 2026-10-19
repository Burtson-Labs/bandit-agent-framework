/**
 * apply_patch envelope: one marker character per line.
 *
 * `+    """Doc."""` adds a line indented four spaces. The parser used to
 * read every `+`/`-` line as "marker + space" and dropped one more
 * column, so qwen3.8:27b's docstring patches (2026-10-19 benchmark)
 * landed at three spaces and the Python module stopped importing. The
 * marker-plus-space spelling (`+ text`) still works where the file or
 * the patch shows the model used it.
 */
import { describe, expect, it } from 'vitest';
import { addFileLines, applyEditTool, applyPatchTool, readFileTool, resolvePatchHunk } from '../src/tools/core-tools';
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

async function patchFile(file: string, patchLines: string[], name = 'a.py'): Promise<{ after: string; output: string; isError?: boolean }> {
  const files = new Map<string, string>([[`/tmp/test/${name}`, file]]);
  const ctx = buildCtx(files);
  await readFileTool.execute({ path: name }, ctx);
  const result = await applyPatchTool.execute({ patch: ['*** Begin Patch', `*** Update File: ${name}`, ...patchLines, '*** End Patch'].join('\n') }, ctx);
  return { after: files.get(`/tmp/test/${name}`)!, output: result.output, isError: result.isError };
}

const PRICING = [
  'from __future__ import annotations',
  '',
  'def unit_price(cost_cents: int, markup_pct: float) -> int:',
  '    if cost_cents < 0:',
  '        raise ValueError("negative")',
  '    return round(cost_cents * (1 + markup_pct / 100))',
  ''
].join('\n');

describe('apply_patch marker spelling', () => {
  it('keeps the indentation of added lines (docstring at four spaces stays at four)', async () => {
    const { after, isError } = await patchFile(PRICING, [
      '@@',
      ' def unit_price(cost_cents: int, markup_pct: float) -> int:',
      '+    """Compute the unit price in cents.',
      '+',
      '+    Args:',
      '+        cost_cents: Cost of one item in cents.',
      '+    """',
      '     if cost_cents < 0:'
    ]);
    expect(isError).toBeFalsy();
    expect(after).toContain('def unit_price(cost_cents: int, markup_pct: float) -> int:\n    """Compute the unit price in cents.\n\n    Args:\n        cost_cents: Cost of one item in cents.\n    """\n    if cost_cents < 0:');
  });

  it('keeps the indentation of replaced lines', async () => {
    const { after, isError } = await patchFile(PRICING, [
      '@@',
      '-    return round(cost_cents * (1 + markup_pct / 100))',
      '+    return int(round(cost_cents * (1 + markup_pct / 100)))'
    ]);
    expect(isError).toBeFalsy();
    expect(after).toContain('\n    return int(round(cost_cents * (1 + markup_pct / 100)))\n');
  });

  it('still accepts the "marker + space" spelling when the removed lines show it', async () => {
    const { after, isError } = await patchFile(PRICING, [
      '@@',
      '-     return round(cost_cents * (1 + markup_pct / 100))',
      '+     return int(round(cost_cents * (1 + markup_pct / 100)))'
    ]);
    expect(isError).toBeFalsy();
    expect(after).toContain('\n    return int(round(cost_cents * (1 + markup_pct / 100)))\n');
  });

  it('reads an addition-only hunk as "marker + space" when every added line is odd-indented', async () => {
    const { after, isError } = await patchFile(PRICING, [
      '@@',
      ' from __future__ import annotations',
      '+ BULK = 3',
      '+ ',
      '+ def helper() -> int:',
      '+     return BULK'
    ]);
    expect(isError).toBeFalsy();
    expect(after).toContain('from __future__ import annotations\nBULK = 3\n\ndef helper() -> int:\n    return BULK\n');
  });

  it('matches a whitespace-drifted "marker + space" hunk and lands the right indent', async () => {
    // File line has a doubled space, so neither reading matches exactly;
    // the whitespace-tolerant match is used and the removed line sits one
    // column deeper than the file: the model wrote "marker + space".
    const file = PRICING.replace('raise ValueError("negative")', 'raise  ValueError("negative")');
    const { after, isError } = await patchFile(file, [
      '@@',
      '-         raise ValueError("negative")',
      '+         raise ValueError("cost_cents must not be negative")'
    ]);
    expect(isError).toBeFalsy();
    expect(after).toContain('\n        raise ValueError("cost_cents must not be negative")\n');
  });

  it('TypeScript rename hunks keep two-space indentation', async () => {
    const ts = ['export function run(): number {', '  const net = calcTotal(invoice);', '  return net;', '}', ''].join('\n');
    const { after, isError } = await patchFile(ts, [
      '@@',
      '-  const net = calcTotal(invoice);',
      '+  const net = invoiceTotal(invoice);'
    ], 'cli.ts');
    expect(isError).toBeFalsy();
    expect(after).toBe(['export function run(): number {', '  const net = invoiceTotal(invoice);', '  return net;', '}', ''].join('\n'));
  });

  it('Add File keeps indentation, and drops the space when every line is spelled "+ "', async () => {
    expect(addFileLines(['def f():', '    return 1'])).toEqual(['def f():', '    return 1']);
    expect(addFileLines([' def f():', '     return 1', ''])).toEqual(['def f():', '    return 1', '']);
    const files = new Map<string, string>();
    const ctx = buildCtx(files);
    const result = await applyPatchTool.execute({
      patch: ['*** Begin Patch', '*** Add File: b.py', '+def f():', '+    return 1', '*** End Patch'].join('\n')
    }, ctx);
    expect(result.isError).toBeFalsy();
    expect(files.get('/tmp/test/b.py')).toBe('def f():\n    return 1\n');
  });

  it('resolvePatchHunk reports which spelling it used', () => {
    const oneChar = resolvePatchHunk([{ kind: 'removed', text: '    x = 1' }, { kind: 'added', text: '    x = 2' }], 'def f():\n    x = 1\n');
    expect(oneChar).toMatchObject({ spelling: 'one-char', occurrences: 1, replace: '    x = 2' });
    const markerSpace = resolvePatchHunk([{ kind: 'removed', text: '     x = 1' }, { kind: 'added', text: '     x = 2' }], 'def f():\n    x = 1\n');
    expect(markerSpace).toMatchObject({ spelling: 'marker-space', occurrences: 1, replace: '    x = 2' });
  });

  it('writes `$` sequences in replacement text literally (apply_patch and apply_edit)', async () => {
    const make = ['run:', '\techo $(HOME)', ''].join('\n');
    const patched = await patchFile(make, ['@@', '-\techo $(HOME)', "+\techo $$HOME $& $' done"], 'Makefile');
    expect(patched.isError).toBeFalsy();
    expect(patched.after).toBe(['run:', "\techo $$HOME $& $' done", ''].join('\n'));

    const files = new Map<string, string>([['/tmp/test/Makefile', make]]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'Makefile' }, ctx);
    const edited = await applyEditTool.execute({ path: 'Makefile', find: 'echo $(HOME)', replace: 'echo $$HOME $&' }, ctx);
    expect(edited.isError).toBeFalsy();
    expect(files.get('/tmp/test/Makefile')).toBe(['run:', '\techo $$HOME $&', ''].join('\n'));
  });
});

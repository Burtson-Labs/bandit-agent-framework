/**
 * Edit-tool repairs from the 2026-10-20 benchmark (gemma4:12b / 26b):
 *  - twice-escaped edit text (`\"\"\"doc\"\"\"`, `\n\n\ndef`) is decoded when,
 *    and only when, the literal text fails validation and the decoded text
 *    passes;
 *  - re-sending an edit that is already applied says so instead of an
 *    indentation hint about a line the edit itself created;
 *  - replace_range says where the lines below it moved.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { applyEditTool, decodeOverEscaped, readFileTool, replaceRangeTool, writeFileTool } from '../src/tools/core-tools';
import type { ILanguageAdapterRegistry, ToolExecutionContext } from '../src/tools/tool-types';

const hasPython = (() => {
  try { execFileSync('python3', ['-c', 'pass']); return true; } catch { return false; }
})();

/** Real Python syntax check, like the CLI's Python adapter. */
const pythonAdapters: ILanguageAdapterRegistry = {
  async validate(filePath, content) {
    if (!filePath.endsWith('.py')) {return { ok: true };}
    try {
      execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: content, stdio: ['pipe', 'ignore', 'pipe'] });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Python syntax error:\n${String((err as { stderr?: Buffer }).stderr ?? err).trim().split('\n').pop()}` };
    }
  }
};

function buildCtx(files: Map<string, string>, adapters?: ILanguageAdapterRegistry): ToolExecutionContext {
  const read = new Set<string>();
  return {
    workspaceRoot: '/ws',
    async readFile(p: string) {
      const hit = files.get(p);
      if (hit === undefined) throw new Error('ENOENT');
      return hit;
    },
    async writeFile(p: string, content: string) { files.set(p, content); },
    async listFiles() { return []; },
    async searchCode() { return ''; },
    async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; },
    markFileRead(p: string) { read.add(p); },
    hasFileBeenRead(p: string) { return read.has(p); },
    languageAdapters: adapters
  };
}

const STOCK = [
  '"""Stock levels."""',
  '',
  'import math',
  '',
  '',
  'def reorder_quantity(item, target):',
  '    packs = math.ceil((target - item.on_hand) / item.pack_size)',
  '    return packs * item.pack_size',
  ''
].join('\n');

// The exact shape gemma4:12b sent: real newlines mixed with \n and \" escapes.
const OVERESCAPED_REPLACE = '    return packs * item.pack_size\\n\\n\\ndef days_of_cover(item, daily_usage):\n    \\"\\"\\"Whole days the stock lasts.\\"\\"\\"\n    if daily_usage <= 0:\n        raise ValueError(\\"daily_usage must be positive\\")\n    return math.floor(item.on_hand / daily_usage)';

describe('decodeOverEscaped', () => {
  it('decodes \\n, \\t, \\" and \\\\ and leaves plain text alone', () => {
    expect(decodeOverEscaped('a\\nb\\t\\"c\\" d\\\\n')).toBe('a\nb\t"c" d\\n');
    expect(decodeOverEscaped('no escapes here')).toBeNull();
  });
});

describe.skipIf(!hasPython)('over-escaped edit text', () => {
  it('apply_edit: decodes a twice-escaped replace that fails validation, and says so', async () => {
    const files = new Map([['/ws/stock.py', STOCK]]);
    const ctx = buildCtx(files, pythonAdapters);
    await readFileTool.execute({ path: 'stock.py' }, ctx);
    const r = await applyEditTool.execute({ path: 'stock.py', find: '    return packs * item.pack_size', replace: OVERESCAPED_REPLACE }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain('literal backslash escapes');
    const after = files.get('/ws/stock.py')!;
    expect(after).toContain('\n\n\ndef days_of_cover(item, daily_usage):\n    """Whole days the stock lasts."""');
    expect(after).toContain('raise ValueError("daily_usage must be positive")');
  });

  it('apply_edit: a legitimate escape inside a string literal is written as sent', async () => {
    const files = new Map([['/ws/stock.py', STOCK]]);
    const ctx = buildCtx(files, pythonAdapters);
    await readFileTool.execute({ path: 'stock.py' }, ctx);
    const replace = '    return packs * item.pack_size\n\n\ndef label(item):\n    return "\\n".join([item.sku, item.name])';
    const r = await applyEditTool.execute({ path: 'stock.py', find: '    return packs * item.pack_size', replace }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.output).not.toContain('literal backslash escapes');
    expect(files.get('/ws/stock.py')).toContain('return "\\n".join([item.sku, item.name])');
  });

  it('apply_edit: a real syntax error is still rejected (decoding does not help), with the escape hint', async () => {
    const files = new Map([['/ws/stock.py', STOCK]]);
    const ctx = buildCtx(files, pythonAdapters);
    await readFileTool.execute({ path: 'stock.py' }, ctx);
    const r = await applyEditTool.execute({ path: 'stock.py', find: '    return packs * item.pack_size', replace: '    return packs * (item.pack_size\\n' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toContain('The file was NOT written');
    expect(r.output).toContain('send real line breaks');
    expect(files.get('/ws/stock.py')).toBe(STOCK);
  });

  it('write_file: decodes twice-escaped quotes when the literal content fails validation', async () => {
    const files = new Map<string, string>();
    const ctx = buildCtx(files, pythonAdapters);
    const content = 'def f():\n    \\"\\"\\"Doc.\\"\\"\\"\n    return 1\n';
    const r = await writeFileTool.execute({ path: 'new.py', content }, ctx);
    expect(r.isError).toBeFalsy();
    expect(files.get('/ws/new.py')).toBe('def f():\n    """Doc."""\n    return 1\n');
    expect(r.output).toContain('literal backslash escapes');
  });

  it('replace_range: decodes the same way', async () => {
    const files = new Map([['/ws/stock.py', STOCK]]);
    const ctx = buildCtx(files, pythonAdapters);
    await readFileTool.execute({ path: 'stock.py' }, ctx);
    const r = await replaceRangeTool.execute({ path: 'stock.py', start_line: '8', end_line: '8', content: OVERESCAPED_REPLACE }, ctx);
    expect(r.isError).toBeFalsy();
    expect(files.get('/ws/stock.py')).toContain('    """Whole days the stock lasts."""');
  });

  it('a file without a validator is written exactly as sent', async () => {
    const files = new Map<string, string>();
    const ctx = buildCtx(files, pythonAdapters);
    const content = 'printf("a\\n");\n';
    const r = await writeFileTool.execute({ path: 'notes.md', content }, ctx);
    expect(r.isError).toBeFalsy();
    expect(files.get('/ws/notes.md')).toBe(content);
  });
});

describe('re-sent edits', () => {
  const CLI = [
    "  const json = rest.includes('--json');",
    "  const file = rest.find((a) => !a.startsWith('-'));",
    '  if (!file) {',
    '    return 2;',
    '  }',
    ''
  ].join('\n');
  const FIND = "const json = rest.includes('--json');\n  const file = rest.find((a) => !a.startsWith('-'));";
  const REPLACE = "const json = rest.includes('--json');\n  const currencyArg = rest.find((a) => a.startsWith('--currency='));\n  const currency = currencyArg ? currencyArg.split('=')[1] : 'USD';\n  const file = rest.find((a) => !a.startsWith('-'));";

  it('the same apply_edit sent again after it succeeded says it is already applied', async () => {
    const files = new Map([['/ws/src/cli.ts', CLI]]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'src/cli.ts' }, ctx);
    const first = await applyEditTool.execute({ path: 'src/cli.ts', find: FIND, replace: REPLACE }, ctx);
    expect(first.isError).toBeFalsy();
    const second = await applyEditTool.execute({ path: 'src/cli.ts', find: FIND, replace: REPLACE }, ctx);
    expect(second.isError).toBe(true);
    expect(second.output).toContain('already been applied');
    expect(second.output).toMatch(/lines 1-4/);
    expect(second.output).not.toContain('missing that indent');
  });

  it('find === replace with the text in the file says the change is already there', async () => {
    const files = new Map([['/ws/src/cli.ts', CLI]]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'src/cli.ts' }, ctx);
    const line = "const file = rest.find((a) => !a.startsWith('-'));";
    const r = await applyEditTool.execute({ path: 'src/cli.ts', find: line, replace: line }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toContain('already in "src/cli.ts" at line 2');
  });

  it('a genuinely wrong find still gets the normal not-found help', async () => {
    const files = new Map([['/ws/src/cli.ts', CLI]]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'src/cli.ts' }, ctx);
    const r = await applyEditTool.execute({ path: 'src/cli.ts', find: 'const nope = 1;', replace: 'const nope = 2; // a different, new line' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toContain('was not found');
    expect(r.output).not.toContain('already been applied');
  });
});

describe('replace_range line shift note', () => {
  it('says where the lines below moved after a size-changing replacement', async () => {
    const files = new Map([['/ws/a.ts', ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n')]]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'a.ts' }, ctx);
    const r = await replaceRangeTool.execute({ path: 'a.ts', start_line: '2', end_line: '2', content: 'L2a\nL2b\nL2c' }, ctx);
    expect(r.output).toContain('Line numbers from line 3 down moved by +2: what your last read showed as line 3 is now line 5.');
  });

  it('adds nothing when the line count is unchanged', async () => {
    const files = new Map([['/ws/a.ts', ['l1', 'l2', 'l3'].join('\n')]]);
    const ctx = buildCtx(files);
    await readFileTool.execute({ path: 'a.ts' }, ctx);
    const r = await replaceRangeTool.execute({ path: 'a.ts', start_line: '2', end_line: '2', content: 'L2' }, ctx);
    expect(r.output).not.toContain('moved by');
  });
});

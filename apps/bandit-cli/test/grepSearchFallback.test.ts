/**
 * search_code's grep fallback (used when ripgrep cannot be spawned) must honour a
 * `file_glob` that names a directory.
 *
 * BanditBench traces, 2026-10-04: search_code({"pattern":"//.*","file_glob":
 * "src/utils/scoring.ts"}) answered "No matches found" on a file full of `//` comments,
 * because grep's --include only matches basenames. The model reported there were none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { grepSearch } from '../src/cliToolContext';

let root: string;

const write = (rel: string, text: string): void => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

/** Files (relative to the root) that grep reported, sorted. */
const filesIn = (output: string): string[] =>
  [...new Set(output.split('\n').filter(Boolean).map(line => path.relative(root, line.split(':')[0])))].sort();

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-grep-')));
  write('src/utils/scoring.ts', '// weights\nexport const w = 1; // inline\n');
  write('src/utils/deep/scoring.ts', '// nested\n');
  write('src/utils/format.ts', '// format\n');
  write('src/main.tsx', '// main\n');
  write('docs/notes.md', '// not code\n');
  write('node_modules/pkg/index.ts', '// dependency\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('grepSearch', () => {
  it('finds matches in a file named by path', async () => {
    const output = await grepSearch('//.*', root, 'src/utils/scoring.ts');
    expect(filesIn(output)).toEqual(['src/utils/scoring.ts']);
    expect(output).toContain(':1:// weights');
    expect(output).toContain(':2:export const w = 1; // inline');
  });

  it('a directory glob stays in that directory', async () => {
    expect(filesIn(await grepSearch('//', root, 'src/utils/*.ts'))).toEqual(['src/utils/format.ts', 'src/utils/scoring.ts']);
  });

  it('recursive globs still work, with and without a prefix', async () => {
    expect(filesIn(await grepSearch('//', root, 'src/**/*.ts'))).toEqual(['src/utils/deep/scoring.ts', 'src/utils/format.ts', 'src/utils/scoring.ts']);
    expect(filesIn(await grepSearch('//', root, '**/*.{ts,tsx}'))).toEqual(['src/main.tsx', 'src/utils/deep/scoring.ts', 'src/utils/format.ts', 'src/utils/scoring.ts']);
  });

  it('basename globs match at any depth and ignored directories stay ignored', async () => {
    expect(filesIn(await grepSearch('//', root, 'scoring.ts'))).toEqual(['src/utils/deep/scoring.ts', 'src/utils/scoring.ts']);
    expect(filesIn(await grepSearch('//', root, '*.ts'))).not.toContain('node_modules/pkg/index.ts');
  });

  it('no glob searches everything', async () => {
    expect(filesIn(await grepSearch('not code', root))).toEqual(['docs/notes.md']);
  });

  it('a glob for a directory that does not exist is "no matches", not an error', async () => {
    await expect(grepSearch('//', root, 'src/missing/*.ts')).resolves.toBe('');
  });
});

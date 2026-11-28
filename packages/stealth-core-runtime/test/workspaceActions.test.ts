import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import {
  createNodeFsAdapter,
  createShellAdapter,
  createWorkspaceActionBridge,
  diffTextValue,
  isInsideRoot,
  pySplitLines
} from '../src';
import type { IShellAdapter } from '../src/hostTypes';

// Expected diffs were produced by Python's difflib.unified_diff(..., lineterm='')
// on str.splitlines(), which is what the removed bandit_agent.py ran.
const difflibCases = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'difflib-unified.json'), 'utf8')
) as Array<{ name: string; before: string; after: string; fromFile: string; toFile: string; diff: string }>;

let root: string;

function bridge(overrides: { shell?: IShellAdapter; platform?: string } = {}) {
  return createWorkspaceActionBridge({
    fs: createNodeFsAdapter(root),
    shell: overrides.shell ?? createShellAdapter(),
    getDefaultRoot: () => root,
    platform: overrides.platform
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'stealth-actions-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(`${root}-secrets`, { recursive: true, force: true });
});

describe('diffText', () => {
  it.each(difflibCases.map((c) => [c.name, c] as const))('matches difflib: %s', (_name, c) => {
    expect(diffTextValue(c.before, c.after, c.fromFile, c.toFile)).toBe(c.diff);
  });

  it('defaults the file labels and returns the Python response shape', async () => {
    const response = await bridge().run('diffText', { before: 'a\n', after: 'b\n' });
    expect(response).toEqual({ status: 'SUCCESS', data: { diff: '--- before\n+++ after\n@@ -1 +1 @@\n-a\n+b' } });
    const empty = await bridge().run('diffText', { before: null, after: undefined });
    expect(empty).toEqual({ status: 'SUCCESS', data: { diff: '' } });
  });

  it('splits lines like str.splitlines', () => {
    expect(pySplitLines('')).toEqual([]);
    expect(pySplitLines('a\n')).toEqual(['a']);
    expect(pySplitLines('a\n\n')).toEqual(['a', '']);
    expect(pySplitLines('a\r\nb\rc\u2028d')).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('scanProject', () => {
  it('walks like os.walk with the same skip list, depth and file limits', async () => {
    mkdirSync(path.join(root, 'src', 'deep', 'er'), { recursive: true });
    mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(path.join(root, 'README.md'), '# hi');
    writeFileSync(path.join(root, 'src', 'a.ts'), 'a');
    writeFileSync(path.join(root, 'src', 'deep', 'b.TS'), 'b');
    writeFileSync(path.join(root, 'src', 'deep', 'er', 'c.ts'), 'c');
    writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), '');
    writeFileSync(path.join(root, '.git', 'HEAD'), '');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest' } }));

    const all = await bridge().run('scanProject', { root });
    expect(all.status).toBe('SUCCESS');
    expect((all.data?.files as string[]).sort()).toEqual(
      ['README.md', 'package.json', 'src/a.ts', 'src/deep/b.TS', 'src/deep/er/c.ts'].sort()
    );
    expect(all.data?.root).toBe(path.resolve(root));
    expect(all.data?.scripts).toEqual({ test: 'vitest' });
    expect((all.data?.packageJson as { name: string }).name).toBe('x');

    const shallow = await bridge().run('scanProject', { root, maxDepth: 1, includeExtensions: ['.TS'] });
    expect(shallow.data?.files).toEqual(['src/a.ts']);

    const capped = await bridge().run('scanProject', { root, maxFiles: 2 });
    expect(capped.data?.files).toHaveLength(2);
  });

  it('does not follow symlinked directories', async () => {
    mkdirSync(path.join(root, 'real'));
    writeFileSync(path.join(root, 'real', 'f.txt'), '');
    symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'dir');
    const response = await bridge().run('scanProject', { root });
    expect(response.data?.files).toEqual(['real/f.txt']);
  });

  it('returns no package.json data when absent and fails on an invalid one', async () => {
    const none = await bridge().run('scanProject', { root });
    expect(none).toEqual({ status: 'SUCCESS', data: { root: path.resolve(root), files: [], packageJson: null, scripts: {} } });
    writeFileSync(path.join(root, 'package.json'), '{ nope');
    const bad = await bridge().run('scanProject', { root });
    expect(bad.status).toBe('FAILED');
    expect(bad.error).toMatch(/^Failed to parse package\.json: /);
  });
});

describe('readFile / writeFile', () => {
  it('writes, creates parent directories and reports bytes written', async () => {
    const response = await bridge({ platform: 'linux' }).run('writeFile', { root, path: 'a/b/c.txt', content: 'héllo\n' });
    expect(response).toEqual({ status: 'SUCCESS', data: { path: 'a/b/c.txt', bytesWritten: 7 } });
    expect(readFileSync(path.join(root, 'a/b/c.txt'), 'utf8')).toBe('héllo\n');
  });

  it('writes CRLF on Windows like Python text mode, without doubling existing CRLF', async () => {
    await bridge({ platform: 'win32' }).run('writeFile', { root, path: 'w.txt', content: 'a\nb\r\nc' });
    expect(readFileSync(path.join(root, 'w.txt'), 'utf8')).toBe('a\r\nb\r\nc');
  });

  it('reads with universal newlines', async () => {
    writeFileSync(path.join(root, 'r.txt'), 'a\r\nb\rc\n');
    const response = await bridge().run('readFile', { root, path: 'r.txt' });
    expect(response).toEqual({ status: 'SUCCESS', data: { path: 'r.txt', content: 'a\nb\nc\n' } });
  });

  it('keeps the Python error messages', async () => {
    const b = bridge();
    expect(await b.run('readFile', { root })).toEqual({ status: 'FAILED', error: 'Path is required for readFile action.' });
    expect(await b.run('writeFile', { root, content: 'x' })).toEqual({
      status: 'FAILED',
      error: 'Path is required for writeFile action.'
    });
    expect(await b.run('writeFile', { root, path: 'x.txt' })).toEqual({
      status: 'FAILED',
      error: 'Content is required for writeFile action.'
    });
    expect(await b.run('readFile', { root, path: 'missing.txt' })).toEqual({
      status: 'FAILED',
      error: 'File not found: missing.txt'
    });
    writeFileSync(path.join(root, 'e.txt'), 'x');
    const badEncoding = await b.run('readFile', { root, path: 'e.txt', encoding: 'klingon' });
    expect(badEncoding).toEqual({ status: 'FAILED', error: 'Failed to read e.txt: unknown encoding: klingon' });
    expect(await b.run('nope', {})).toEqual({ status: 'FAILED', error: 'Unknown action: nope' });
  });

  it('allows an empty file write', async () => {
    const response = await bridge().run('writeFile', { root, path: 'empty.txt', content: '' });
    expect(response).toEqual({ status: 'SUCCESS', data: { path: 'empty.txt', bytesWritten: 0 } });
  });

  it('confines reads and writes to the project root, including sibling-prefix paths', async () => {
    mkdirSync(`${root}-secrets`);
    writeFileSync(`${root}-secrets/key.txt`, 'secret');
    const sibling = `../${path.basename(root)}-secrets/key.txt`;
    const b = bridge();
    expect(await b.run('readFile', { root, path: '../outside.txt' })).toEqual({
      status: 'FAILED',
      error: 'Attempt to read outside project root.'
    });
    expect(await b.run('readFile', { root, path: sibling })).toEqual({
      status: 'FAILED',
      error: 'Attempt to read outside project root.'
    });
    expect(await b.run('readFile', { root, path: '/etc/hosts' })).toEqual({
      status: 'FAILED',
      error: 'Attempt to read outside project root.'
    });
    expect(await b.run('writeFile', { root, path: sibling, content: 'x' })).toEqual({
      status: 'FAILED',
      error: 'Attempt to write outside project root.'
    });
    expect(readFileSync(`${root}-secrets/key.txt`, 'utf8')).toBe('secret');
    expect(existsSync(path.join(path.dirname(root), 'outside.txt'))).toBe(false);
  });

  it('isInsideRoot checks whole path segments', () => {
    expect(isInsideRoot('/work/app', '/work/app')).toBe(true);
    expect(isInsideRoot('/work/app', '/work/app/src/a.ts')).toBe(true);
    expect(isInsideRoot('/work/app', '/work/app-secrets/a')).toBe(false);
    expect(isInsideRoot('/', '/etc')).toBe(true);
  });
});

describe('runCommand', () => {
  it('runs through /bin/sh -c in the given cwd and reports the exit code', async () => {
    if (process.platform === 'win32') {
      return;
    }
    mkdirSync(path.join(root, 'sub'));
    const ok = await bridge().run('runCommand', { command: 'pwd && echo out && echo err 1>&2', cwd: path.join(root, 'sub') });
    expect(ok.status).toBe('SUCCESS');
    expect(ok.code).toBe(0);
    expect((ok.output as string).trim().split('\n')[1]).toBe('out');
    expect(ok.error).toBe('err\n');

    const fail = await bridge().run('runCommand', { command: 'exit 3', root });
    expect(fail).toEqual({ status: 'FAILED', output: '', error: undefined, code: 3 });
  });

  it('uses ComSpec /c "<command>" verbatim on Windows', async () => {
    const calls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
    const shell: IShellAdapter = {
      async run(cmd, args, opts) {
        calls.push({ cmd, args, opts });
        return { code: 0, stdout: 'a\r\nb\r\n', stderr: '' };
      }
    };
    const b = createWorkspaceActionBridge({
      fs: createNodeFsAdapter(root),
      shell,
      getDefaultRoot: () => root,
      platform: 'win32',
      comspec: 'C:\\Windows\\system32\\cmd.exe'
    });
    const response = await b.run('runCommand', { command: 'echo "hi" && dir', root });
    expect(calls).toEqual([
      {
        cmd: 'C:\\Windows\\system32\\cmd.exe',
        args: ['/c', '"echo "hi" && dir"'],
        opts: { cwd: path.resolve(root), windowsVerbatimArguments: true }
      }
    ]);
    expect(response).toEqual({ status: 'SUCCESS', output: 'a\nb\n', error: undefined, code: 0 });
  });

  it('keeps the Python error messages', async () => {
    expect(await bridge().run('runCommand', { root })).toEqual({
      status: 'FAILED',
      error: 'Command is required for runCommand action.'
    });
    const missingCwd = await bridge().run('runCommand', { command: 'true', cwd: path.join(root, 'does-not-exist') });
    expect(missingCwd.status).toBe('FAILED');
    expect(missingCwd.error).toMatch(/^Command failed: /);
  });
});

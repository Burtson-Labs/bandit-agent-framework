/**
 * In-process workspace actions for plan steps (`type: 'python'` actions).
 *
 * These five actions (scanProject, readFile, writeFile, runCommand,
 * diffText) used to run in a Python subprocess (`bandit_agent.py`), which
 * meant every host needed Python 3 installed before an agent plan could
 * touch a file. They now run in the host process on top of the host's own
 * `IFsAdapter` and `IShellAdapter`, so the runtime stays host-agnostic
 * (VS Code extension host, Stealth web host, tests) and needs no second
 * runtime.
 *
 * Behaviour, payloads, response shapes and error messages match the Python
 * implementation. The action type name `python` is kept in plans so saved
 * plans still replay.
 */
import path from 'path';
import type { IFsAdapter, IShellAdapter, PythonResponse } from './types';

export interface WorkspaceActionBridgeDeps {
  fs: IFsAdapter;
  shell: IShellAdapter;
  /** Root used when a payload carries no `root`. */
  getDefaultRoot(): string;
  /** Overridable for tests; defaults to `process.platform`. */
  platform?: string;
  /** Overridable for tests; defaults to `process.env.ComSpec`. */
  comspec?: string;
}

export interface WorkspaceActionBridge {
  run(action: string, payload: unknown): Promise<PythonResponse>;
}

const SCAN_SKIP_DIRS = new Set([
  '.git',
  '.bandit',
  'node_modules',
  'vendor',
  '.next',
  '.turbo',
  'dist',
  'build',
  '.cache',
  '.vscode',
  '.idea',
  '.vsce',
  'out',
  '__pycache__'
]);

type Params = Record<string, unknown>;

function success(extra: Record<string, unknown>): PythonResponse {
  return { status: 'SUCCESS', ...extra };
}

function failed(error: string, extra: Record<string, unknown> = {}): PythonResponse {
  return { status: 'FAILED', error, ...extra };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentPlatform(): string {
  return typeof process !== 'undefined' && process.platform ? process.platform : 'linux';
}

/** Normalises universal newlines the way Python's text mode does on read. */
function toUniversalNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

interface ResolvedEncoding {
  node: BufferEncoding;
  bom: boolean;
}

/**
 * Maps a Python codec name to a Node encoding. Unknown names fail the same
 * way Python's `LookupError` did (`unknown encoding: <name>`).
 */
export function resolveEncoding(value: unknown): ResolvedEncoding {
  if (value === undefined || value === null || value === '') {
    return { node: 'utf8', bom: false };
  }
  const name = String(value).trim().toLowerCase().replace(/_/g, '-');
  switch (name) {
    case 'utf-8':
    case 'utf8':
    case 'u8':
      return { node: 'utf8', bom: false };
    case 'utf-8-sig':
      return { node: 'utf8', bom: true };
    case 'latin-1':
    case 'latin1':
    case 'iso-8859-1':
    case 'iso8859-1':
    case 'l1':
      return { node: 'latin1', bom: false };
    case 'ascii':
    case 'us-ascii':
      return { node: 'ascii', bom: false };
    case 'utf-16le':
    case 'utf-16-le':
      return { node: 'utf16le', bom: false };
    default:
      throw new Error(`unknown encoding: ${String(value)}`);
  }
}

function byteLength(content: string, encoding: ResolvedEncoding): number {
  return Buffer.byteLength(content, encoding.node) + (encoding.bom ? 3 : 0);
}

/**
 * True when `target` is `root` or inside it. Python compared with a bare
 * `startswith(root)`, which let `/work/app-secrets` pass for root
 * `/work/app`; this checks a whole path segment. Windows paths compare
 * without case: VS Code hands over `c:\repo` (lower-case drive) while
 * tools and models write `C:\repo\src\a.ts`, which is the same file.
 */
export function isInsideRoot(root: string, target: string, platform: string = currentPlatform()): boolean {
  const win = platform === 'win32';
  const sep = path.sep;
  const a = win ? root.toLowerCase() : root;
  const b = win ? target.toLowerCase() : target;
  if (b === a) {
    return true;
  }
  const prefix = a.endsWith(sep) ? a : a + sep;
  return b.startsWith(prefix);
}

/**
 * Port of Python's `str.splitlines()` (no keepends): splits on every line
 * boundary Python recognises and drops the trailing empty element.
 */
export function pySplitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  // eslint-disable-next-line no-control-regex -- Python's line boundaries include \v, \f and \x1c-\x1e
  const parts = text.split(/\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

type Opcode = ['replace' | 'delete' | 'insert' | 'equal', number, number, number, number];

/**
 * Port of `difflib.SequenceMatcher(None, a, b)` (autojunk on), limited to
 * what `unified_diff` needs, so diffs read exactly as they did before.
 */
class SequenceMatcher {
  private readonly b2j = new Map<string, number[]>();

  constructor(
    private readonly a: string[],
    private readonly b: string[]
  ) {
    b.forEach((line, index) => {
      const indices = this.b2j.get(line);
      if (indices) {
        indices.push(index);
      } else {
        this.b2j.set(line, [index]);
      }
    });
    const n = b.length;
    if (n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      const popular: string[] = [];
      for (const [line, indices] of this.b2j) {
        if (indices.length > ntest) {
          popular.push(line);
        }
      }
      for (const line of popular) {
        this.b2j.delete(line);
      }
    }
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i += 1) {
      const newj2len = new Map<number, number>();
      const indices = b2j.get(a[i]);
      if (indices) {
        for (const j of indices) {
          if (j < blo) {
            continue;
          }
          if (j >= bhi) {
            break;
          }
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newj2len;
    }
    // No junk predicate, so these extend the match across equal "popular"
    // lines that autojunk removed from b2j (same as difflib).
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize += 1;
    }
    return [besti, bestj, bestsize];
  }

  private getMatchingBlocks(): Array<[number, number, number]> {
    const la = this.a.length;
    const lb = this.b.length;
    const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
    const blocks: Array<[number, number, number]> = [];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const match = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = match;
      if (k) {
        blocks.push(match);
        if (alo < i && blo < j) {
          queue.push([alo, i, blo, j]);
        }
        if (i + k < ahi && j + k < bhi) {
          queue.push([i + k, ahi, j + k, bhi]);
        }
      }
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const nonAdjacent: Array<[number, number, number]> = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) {
          nonAdjacent.push([i1, j1, k1]);
        }
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1) {
      nonAdjacent.push([i1, j1, k1]);
    }
    nonAdjacent.push([la, lb, 0]);
    return nonAdjacent;
  }

  private getOpcodes(): Opcode[] {
    let i = 0;
    let j = 0;
    const answer: Opcode[] = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      let tag: Opcode[0] | '' = '';
      if (i < ai && j < bj) {
        tag = 'replace';
      } else if (i < ai) {
        tag = 'delete';
      } else if (j < bj) {
        tag = 'insert';
      }
      if (tag) {
        answer.push([tag, i, ai, j, bj]);
      }
      i = ai + size;
      j = bj + size;
      if (size) {
        answer.push(['equal', ai, i, bj, j]);
      }
    }
    return answer;
  }

  getGroupedOpcodes(n = 3): Opcode[][] {
    let codes = this.getOpcodes();
    if (codes.length === 0) {
      codes = [['equal', 0, 1, 0, 1]];
    }
    if (codes[0][0] === 'equal') {
      const [tag, i1, i2, j1, j2] = codes[0];
      codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
    }
    const last = codes.length - 1;
    if (codes[last][0] === 'equal') {
      const [tag, i1, i2, j1, j2] = codes[last];
      codes[last] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
    }
    const nn = n + n;
    const groups: Opcode[][] = [];
    let group: Opcode[] = [];
    for (const code of codes) {
      const [tag, , i2, , j2] = code;
      let [, i1, , j1] = code;
      if (tag === 'equal' && i2 - i1 > nn) {
        group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
        groups.push(group);
        group = [];
        i1 = Math.max(i1, i2 - n);
        j1 = Math.max(j1, j2 - n);
      }
      group.push([tag, i1, i2, j1, j2]);
    }
    if (group.length > 0 && !(group.length === 1 && group[0][0] === 'equal')) {
      groups.push(group);
    }
    return groups;
  }
}

function formatRangeUnified(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) {
    return `${beginning}`;
  }
  if (!length) {
    beginning -= 1;
  }
  return `${beginning},${length}`;
}

/** Port of `difflib.unified_diff(a, b, fromfile, tofile, lineterm='')`. */
export function unifiedDiffLines(a: string[], b: string[], fromFile: string, toFile: string, n = 3): string[] {
  const lines: string[] = [];
  let started = false;
  for (const group of new SequenceMatcher(a, b).getGroupedOpcodes(n)) {
    if (!started) {
      started = true;
      lines.push(`--- ${fromFile}`);
      lines.push(`+++ ${toFile}`);
    }
    const first = group[0];
    const last = group[group.length - 1];
    lines.push(`@@ -${formatRangeUnified(first[1], last[2])} +${formatRangeUnified(first[3], last[4])} @@`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === 'equal') {
        for (const line of a.slice(i1, i2)) {
          lines.push(` ${line}`);
        }
        continue;
      }
      if (tag === 'replace' || tag === 'delete') {
        for (const line of a.slice(i1, i2)) {
          lines.push(`-${line}`);
        }
      }
      if (tag === 'replace' || tag === 'insert') {
        for (const line of b.slice(j1, j2)) {
          lines.push(`+${line}`);
        }
      }
    }
  }
  return lines;
}

/** Same text the Python `diffText` action returned. */
export function diffTextValue(before: string, after: string, fromFile: string, toFile: string): string {
  return unifiedDiffLines(pySplitLines(before), pySplitLines(after), fromFile, toFile).join('\n');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createWorkspaceActionBridge(deps: WorkspaceActionBridgeDeps): WorkspaceActionBridge {
  const platform = deps.platform ?? currentPlatform();

  function normalizeRoot(value: unknown): string {
    const root = typeof value === 'string' && value ? value : deps.getDefaultRoot();
    return path.resolve(root);
  }

  async function listEntries(dir: string): Promise<Array<{ name: string; type: 'file' | 'directory' | 'other' }>> {
    if (deps.fs.readDirEntries) {
      return deps.fs.readDirEntries(dir);
    }
    // Adapters without typed listings: a child that lists is a directory.
    const names = await deps.fs.readDir(dir);
    const entries: Array<{ name: string; type: 'file' | 'directory' | 'other' }> = [];
    for (const name of names) {
      try {
        await deps.fs.readDir(path.join(dir, name));
        entries.push({ name, type: 'directory' });
      } catch {
        entries.push({ name, type: 'file' });
      }
    }
    return entries;
  }

  async function scanProject(params: Params): Promise<PythonResponse> {
    const root = normalizeRoot(params.root);
    const maxDepth = Math.trunc(Number(params.maxDepth ?? 5));
    const maxFiles = Math.trunc(Number(params.maxFiles ?? 400));
    const includeExts = (Array.isArray(params.includeExtensions) ? params.includeExtensions : []).map((ext) =>
      String(ext).toLowerCase()
    );
    const collected: string[] = [];

    // Top-down walk in the same order as os.walk: a directory's files, then
    // its subdirectories. Unreadable directories are skipped silently.
    async function walk(dir: string, depth: number): Promise<boolean> {
      if (depth > maxDepth) {
        return false;
      }
      let entries: Array<{ name: string; type: 'file' | 'directory' | 'other' }>;
      try {
        entries = await listEntries(dir);
      } catch {
        return false;
      }
      for (const entry of entries) {
        if (entry.type !== 'file') {
          continue;
        }
        if (includeExts.length > 0) {
          const lowered = entry.name.toLowerCase();
          if (!includeExts.some((ext) => lowered.endsWith(ext))) {
            continue;
          }
        }
        collected.push(path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/'));
        if (collected.length >= maxFiles) {
          return true;
        }
      }
      for (const entry of entries) {
        if (entry.type !== 'directory' || SCAN_SKIP_DIRS.has(entry.name)) {
          continue;
        }
        if (await walk(path.join(dir, entry.name), depth + 1)) {
          return true;
        }
      }
      return false;
    }

    await walk(root, 0);

    let packageJson: unknown = null;
    let scripts: unknown = {};
    const packagePath = path.join(root, 'package.json');
    if (await deps.fs.exists(packagePath)) {
      try {
        packageJson = JSON.parse(await deps.fs.readText(packagePath, 'utf8'));
        if (!isPlainObject(packageJson)) {
          throw new Error(`package.json is not an object`);
        }
        scripts = packageJson.scripts || {};
      } catch (error) {
        return failed(`Failed to parse package.json: ${errorMessage(error)}`);
      }
    }

    return success({
      data: {
        root,
        files: collected,
        packageJson,
        scripts
      }
    });
  }

  async function readFile(params: Params): Promise<PythonResponse> {
    const root = normalizeRoot(params.root);
    const relativePath = params.path;
    if (!relativePath || typeof relativePath !== 'string') {
      return failed('Path is required for readFile action.');
    }
    const absolutePath = path.resolve(root, relativePath);
    if (!isInsideRoot(root, absolutePath, platform)) {
      return failed('Attempt to read outside project root.');
    }
    if (!(await deps.fs.exists(absolutePath))) {
      return failed(`File not found: ${relativePath}`);
    }
    try {
      const encoding = resolveEncoding(params.encoding);
      let content = await deps.fs.readText(absolutePath, encoding.node);
      if (encoding.bom && content.charCodeAt(0) === 0xfeff) {
        content = content.slice(1);
      }
      return success({
        data: {
          path: relativePath,
          content: toUniversalNewlines(content)
        }
      });
    } catch (error) {
      return failed(`Failed to read ${relativePath}: ${errorMessage(error)}`);
    }
  }

  async function writeFile(params: Params): Promise<PythonResponse> {
    const root = normalizeRoot(params.root);
    const relativePath = params.path;
    const content = params.content;
    if (!relativePath || typeof relativePath !== 'string') {
      return failed('Path is required for writeFile action.');
    }
    if (content === undefined || content === null) {
      return failed('Content is required for writeFile action.');
    }
    const absolutePath = path.resolve(root, relativePath);
    if (!isInsideRoot(root, absolutePath, platform)) {
      return failed('Attempt to write outside project root.');
    }
    try {
      const encoding = resolveEncoding(params.encoding);
      const text = String(content);
      // Python's text mode wrote os.linesep for '\n'; keep CRLF on Windows
      // without doubling an existing '\r\n'.
      let onDisk = platform === 'win32' ? text.replace(/\r?\n/g, '\r\n') : text;
      if (encoding.bom) {
        onDisk = `\ufeff${onDisk}`;
      }
      await deps.fs.ensureDir(path.dirname(absolutePath));
      await deps.fs.writeText(absolutePath, onDisk, encoding.node);
      return success({
        data: {
          path: relativePath,
          bytesWritten: byteLength(text, encoding)
        }
      });
    } catch (error) {
      return failed(`Failed to write ${relativePath}: ${errorMessage(error)}`);
    }
  }

  async function runCommand(params: Params): Promise<PythonResponse> {
    const command = params.command;
    if (!command || typeof command !== 'string') {
      return failed('Command is required for runCommand action.');
    }
    const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : normalizeRoot(params.root);
    try {
      // Same shell as Python's subprocess.run(shell=True): /bin/sh -c on
      // POSIX, `%ComSpec% /c "<command>"` on Windows.
      const result =
        platform === 'win32'
          ? await deps.shell.run(
              deps.comspec ?? (typeof process !== 'undefined' ? process.env.ComSpec : undefined) ?? 'cmd.exe',
              ['/c', `"${command}"`],
              { cwd, windowsVerbatimArguments: true }
            )
          : await deps.shell.run('/bin/sh', ['-c', command], { cwd });
      const stdout = toUniversalNewlines(result.stdout ?? '');
      const stderr = toUniversalNewlines(result.stderr ?? '');
      return {
        status: result.code === 0 ? 'SUCCESS' : 'FAILED',
        output: stdout,
        error: stderr || undefined,
        code: result.code
      };
    } catch (error) {
      return failed(`Command failed: ${errorMessage(error)}`);
    }
  }

  function diffText(params: Params): PythonResponse {
    const before = typeof params.before === 'string' ? params.before : '';
    const after = typeof params.after === 'string' ? params.after : '';
    const fromFile = typeof params.fromFile === 'string' && params.fromFile ? params.fromFile : 'before';
    const toFile = typeof params.toFile === 'string' && params.toFile ? params.toFile : 'after';
    return success({ data: { diff: diffTextValue(before, after, fromFile, toFile) } });
  }

  async function run(action: string, payload: unknown): Promise<PythonResponse> {
    const params: Params = isPlainObject(payload) ? payload : {};
    switch (action) {
      case 'scanProject':
        return scanProject(params);
      case 'readFile':
        return readFile(params);
      case 'writeFile':
        return writeFile(params);
      case 'runCommand':
        return runCommand(params);
      case 'diffText':
        return diffText(params);
      default:
        return failed(`Unknown action: ${action}`);
    }
  }

  return { run };
}

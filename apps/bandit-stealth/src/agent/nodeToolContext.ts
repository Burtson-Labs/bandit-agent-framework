/**
 * Node.js implementation of ToolExecutionContext for the VS Code extension.
 *
 * Provides filesystem, search, and shell execution capabilities to the
 * tool use loop using Node.js built-ins and VS Code workspace APIs.
 * No dependency on vscode is taken for file I/O — only for glob resolution
 * via vscode.workspace.findFiles() so the ignore rules match the editor's.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import type { ToolExecutionContext, ILanguageAdapterRegistry, UserInputRequest, UserInputResponse } from '@burtson-labs/agent-core';

export interface NodeToolContextOptions {
  /** Host callback the `ask_user` tool uses to pose questions to the user
   *  and await answers. Wired from the provider's MultiQuestionGateService. */
  requestUserInput?: (request: UserInputRequest) => Promise<UserInputResponse>;
}

/** Expand leading `~` / `~/` to the user's home dir. Models often emit paths
 * like "~/Desktop" verbatim because that's what users type in a shell, but
 * spawn(shell:false) doesn't expand it. */
function expandHome(p: string): string {
  if (p === '~') {return os.homedir();}
  if (p.startsWith('~/')) {return path.join(os.homedir(), p.slice(2));}
  return p;
}

const MAX_SEARCH_BYTES = 16 * 1024;   // 16 KB of search results
const MAX_COMMAND_BYTES = 32 * 1024;  // 32 KB of command output
const SEARCH_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;

/** Dirs to skip in searches and listings by default. */
const IGNORED_DIRS = ['node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', 'coverage'];

// Convert a ripgrep-style glob (`src/**/*.{ts,tsx,js,jsx}`) into the
// `(includes, subDir)` shape grep understands:
//  - `subDir` is any non-wildcard prefix — passed as the positional dir
//    argument so grep restricts its -r traversal to that subtree.
//  - `includes` is the leaf pattern, expanded from a single `{a,b,c}`
//    alternation into one basename per comma-separated value. Each value
//    is handed to grep as a separate `--include` (grep ORs them).
// Only handles the one-level `prefix/**/leaf` shape our agents emit —
// more exotic globs degrade to "no prefix, leaf only" rather than crashing.
function expandGlobForGrep(glob: string): { includes: string[]; subDir: string } {
  const braceExpand = (leaf: string): string[] => {
    const m = leaf.match(/^(.*?)\{([^}]+)\}(.*)$/);
    if (!m) {return [leaf];}
    const [, pre, body, post] = m;
    return body.split(',').map(v => `${pre}${v.trim()}${post}`);
  };

  const m = glob.match(/^([^*{}]+?)\/\*\*\/(.+)$/);
  if (m) {
    const [, prefix, leaf] = m;
    return { includes: braceExpand(leaf), subDir: prefix };
  }
  return { includes: braceExpand(glob), subDir: '' };
}

export class NodeToolExecutionContext implements ToolExecutionContext {
  // Per-context (per-turn) set of files the model has actually called
  // read_file on. apply_edit, replace_range, and write_file (overwrite) check this to
  // refuse blind edits.
  private readonly _readFiles = new Set<string>();

  public readonly requestUserInput?: (request: UserInputRequest) => Promise<UserInputResponse>;

  constructor(
    public readonly workspaceRoot: string,
    public readonly languageAdapters?: ILanguageAdapterRegistry,
    options: NodeToolContextOptions = {}
  ) {
    this.requestUserInput = options.requestUserInput;
  }

  markFileRead(absolutePath: string): void {
    this._readFiles.add(absolutePath);
  }

  hasFileBeenRead(absolutePath: string): boolean {
    return this._readFiles.has(absolutePath);
  }

  // ── File I/O ────────────────────────────────────────────────────────────────

  async readFile(absolutePath: string): Promise<string> {
    return fs.promises.readFile(absolutePath, 'utf-8');
  }

  async writeFile(absolutePath: string, content: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, content, 'utf-8');
  }

  async deleteFile(absolutePath: string): Promise<void> {
    // Workspace containment check — reject paths outside the workspace
    // root so a malicious / hallucinated absolute path can't `unlink`
    // anything outside the project. Resolve to absolute first to catch
    // `..`-traversal attempts.
    const resolved = path.resolve(absolutePath);
    const root = path.resolve(this.workspaceRoot);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(`Refusing to delete outside workspace: ${absolutePath}`);
    }
    await fs.promises.unlink(resolved);
  }

  // ── File listing ────────────────────────────────────────────────────────────

  async listFiles(pattern: string, cwd?: string): Promise<string[]> {
    const base = cwd ?? this.workspaceRoot;
    // Use VS Code's findFiles so workspace .gitignore / .vscodeignore rules apply.
    const relPattern = new vscode.RelativePattern(base, pattern);
    const excludePattern = `{${IGNORED_DIRS.map(d => `**/${d}/**`).join(',')}}`;
    const uris = await vscode.workspace.findFiles(relPattern, excludePattern, 200);
    return uris.map(u => u.fsPath).sort();
  }

  async listDirectoryEntries(cwd: string): Promise<string[]> {
    const expanded = cwd.startsWith('~/')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ? path.join(require('os').homedir(), cwd.slice(2))
      : cwd;
    const entries = await fs.promises.readdir(expanded, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      // Skip dotfiles — they dominate home-dir listings and users who
      // want them can use `ls -a` via run_command. Mirrors standard ls.
      if (entry.name.startsWith('.')) {continue;}
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        // Resolve symlinks — iCloud-synced Desktop/Documents paths
        // should still report correctly as directories.
        try {
          const stat = await fs.promises.stat(path.join(expanded, entry.name));
          isDir = stat.isDirectory();
        } catch {
          isDir = false;
        }
      }
      out.push(isDir ? `${entry.name}/` : entry.name);
    }
    return out.sort();
  }

  // ── Code search ─────────────────────────────────────────────────────────────

  async searchCode(pattern: string, cwd?: string, fileGlob?: string): Promise<string> {
    const dir = cwd ?? this.workspaceRoot;
    // Try ripgrep first (bundled with VS Code / common in PATH), fall back to grep.
    return this.runRipgrep(pattern, dir, fileGlob).catch(() =>
      this.runGrep(pattern, dir, fileGlob)
    );
  }

  // ── Shell command execution ──────────────────────────────────────────────────

  async runCommand(
    cmd: string,
    args: string[],
    cwd?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Tilde expansion: spawn(shell:false) doesn't expand ~, so
    // `mkdir ~/Desktop/Foo` would create a literal "~" directory in
    // the workspace. Models emit ~ verbatim because users type it.
    const expandedArgs = args.map(expandHome);
    const expandedCwd = cwd ? expandHome(cwd) : this.workspaceRoot;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      // Windows: route .cmd/.bat shims (npm, npx, pnpm, yarn, tsc)
      // through cmd.exe — spawn(shell:false) can't resolve them.
      const proc = cp.spawn(cmd, expandedArgs, {
        cwd: expandedCwd,
        shell: process.platform === 'win32',
        env: { ...process.env }
      });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({
          stdout: stdout.slice(0, MAX_COMMAND_BYTES),
          stderr: stderr + '\n[process timed out]',
          exitCode: 124
        });
      }, COMMAND_TIMEOUT_MS);

      proc.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
        if (stdout.length > MAX_COMMAND_BYTES) {proc.kill('SIGTERM');}
      });
      proc.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout: stdout.slice(0, MAX_COMMAND_BYTES),
          stderr: stderr.slice(0, 4 * 1024),
          exitCode: code ?? 0
        });
      });

      proc.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        // ENOENT = executable not found on PATH. Surface a recovery
        // hint so the model can suggest a fix (or the user understands
        // the cause) instead of looping on the same call. Common
        // trigger: VS Code launched outside an interactive shell so
        // nvm/asdf/volta shim PATH wasn't sourced.
        if (err.code === 'ENOENT') {
          resolve({
            stdout: '',
            stderr: `spawn ${cmd} ENOENT — '${cmd}' not found on PATH. Verify the tool is installed (\`which ${cmd}\` in a fresh terminal). If you use nvm/asdf/volta, VS Code may not have inherited the shim PATH; restarting VS Code from a terminal that has \`${cmd}\` on PATH usually fixes it.`,
            exitCode: 127
          });
          return;
        }
        resolve({ stdout: '', stderr: err.message, exitCode: 1 });
      });
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private runRipgrep(pattern: string, dir: string, fileGlob?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--color=never',
        '--line-number',
        '--max-count=25',
        '--max-filesize=1M',
        ...IGNORED_DIRS.map(d => ['--glob', `!${d}`]).flat(),
      ];
      if (fileGlob) {
        args.push('--glob', fileGlob);
      }
      args.push(pattern, dir);

      let output = '';
      const proc = cp.spawn('rg', args, { shell: false });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve(output.slice(0, MAX_SEARCH_BYTES));
      }, SEARCH_TIMEOUT_MS);

      proc.stdout?.on('data', (d: Buffer) => {
        output += d.toString();
        if (output.length > MAX_SEARCH_BYTES) {proc.kill('SIGTERM');}
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        // rg exits 0 = matches found, 1 = no matches, 2+ = error
        if (code != null && code >= 2 && output.length === 0) {
          reject(new Error(`rg exited with code ${code}`));
        } else {
          resolve(output.slice(0, MAX_SEARCH_BYTES));
        }
      });

      proc.on('error', reject);
    });
  }

  private runGrep(pattern: string, dir: string, fileGlob?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const excludeDirArgs = IGNORED_DIRS.map(d => ['--exclude-dir', d]).flat();
      // grep's --include matches file BASENAMES only and does not support
      // `**` recursion or `{a,b,c}` alternation. Passing `src/**/*.{ts,tsx}`
      // to grep as-is produces ZERO matches — which is exactly the bug that
      // made the extension look broken on pburg-bowl (rg was missing from
      // PATH in the Electron env → fell back to grep → every search came
      // back empty → model concluded the target file didn't exist → wandered
      // the repo and hallucinated a code-fence answer). We expand the glob
      // into the basename-only form grep understands and pin the directory
      // prefix via the positional argument instead.
      const expanded = fileGlob ? expandGlobForGrep(fileGlob) : { includes: [], subDir: '' };
      const includeArgs = expanded.includes.flatMap(i => ['--include', i]);
      const effectiveDir = expanded.subDir ? `${dir}/${expanded.subDir}` : dir;
      const args = [
        '-rn',
        '-E',  // extended regex so `a|b|c` alternation works
        '--color=never',
        ...excludeDirArgs,
        ...includeArgs,
        pattern,
        effectiveDir
      ];

      let output = '';
      const proc = cp.spawn('grep', args, { shell: false });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve(output.slice(0, MAX_SEARCH_BYTES));
      }, SEARCH_TIMEOUT_MS);

      proc.stdout?.on('data', (d: Buffer) => {
        output += d.toString();
        if (output.length > MAX_SEARCH_BYTES) {proc.kill('SIGTERM');}
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        // grep exits 0 = matches, 1 = no matches, 2 = error
        if (code != null && code >= 2 && output.length === 0) {
          reject(new Error(`grep exited with code ${code}`));
        } else {
          resolve(output.slice(0, MAX_SEARCH_BYTES));
        }
      });

      proc.on('error', reject);
    });
  }
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import type { ToolExecutionContext, ILanguageAdapterRegistry, UserInputRequest, UserInputResponse } from '@burtson-labs/agent-core';

/** Expand leading `~` / `~/` to the user's home dir. Models often emit paths
 * like "~/Desktop" verbatim; resolving here saves an extra tool round-trip. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const MAX_SEARCH_BYTES = 16 * 1024;
const MAX_COMMAND_BYTES = 32 * 1024;
const SEARCH_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_LIST_RESULTS = 200;

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', 'coverage',
  'target', '__pycache__', '.venv', 'venv'
]);

function expandGlobForGrep(glob: string): { includes: string[]; subDir: string } {
  const braceExpand = (leaf: string): string[] => {
    const m = leaf.match(/^(.*?)\{([^}]+)\}(.*)$/);
    if (!m) return [leaf];
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

export interface CliToolContextOptions {
  /** Called before any writeFile. Return false to abort the write. */
  approveWrite?: (absolutePath: string, content: string) => Promise<boolean>;
  /** Custom repo roots from `~/.bandit/config.json: repos.roots`. The
   *  find_directory tool reads ToolExecutionContext.customRepoRoots
   *  to extend its scan list. Tilde-prefixed paths are accepted; the
   *  context's listDirectoryEntries handles ~ expansion. */
  customRepoRoots?: string[];
  /** Host callback the `ask_user` tool uses to pose questions and await
   *  answers. Wired only for interactive (TTY) sessions; absent in
   *  piped/CI runs so the tool degrades to "ask in plain text". */
  requestUserInput?: (request: UserInputRequest) => Promise<UserInputResponse>;
}

export class CliToolExecutionContext implements ToolExecutionContext {
  // Per-context (per-turn) set of files the model has actually called
  // read_file on. apply_edit, replace_range, and write_file (overwrite) check this to
  // refuse blind edits — the model can't accurately reconstruct file
  // content from training memory and `find` strings end up mismatching
  // whitespace/imports it never saw. Normalized via expandHome so the
  // same logical path tracked through all entry points.
  private readonly _readFiles = new Set<string>();

  public readonly customRepoRoots: string[] | undefined;
  public readonly requestUserInput?: (request: UserInputRequest) => Promise<UserInputResponse>;

  constructor(
    public readonly workspaceRoot: string,
    public readonly languageAdapters?: ILanguageAdapterRegistry,
    private readonly options: CliToolContextOptions = {}
  ) {
    this.customRepoRoots = options.customRepoRoots && options.customRepoRoots.length > 0
      ? options.customRepoRoots
      : undefined;
    this.requestUserInput = options.requestUserInput;
  }

  markFileRead(absolutePath: string): void {
    this._readFiles.add(expandHome(absolutePath));
  }

  hasFileBeenRead(absolutePath: string): boolean {
    return this._readFiles.has(expandHome(absolutePath));
  }

  async readFile(absolutePath: string): Promise<string> {
    return fs.promises.readFile(expandHome(absolutePath), 'utf-8');
  }

  async writeFile(absolutePath: string, content: string): Promise<void> {
    const resolved = expandHome(absolutePath);
    if (this.options.approveWrite) {
      const ok = await this.options.approveWrite(resolved, content);
      if (!ok) {
        throw new Error(`Write to ${resolved} rejected by user`);
      }
    }
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, content, 'utf-8');
  }

  async deleteFile(absolutePath: string): Promise<void> {
    // Workspace containment — same guard as the extension host. ~ is
    // expanded first so `~/Desktop/foo` resolves correctly under the
    // user's home, then we ensure the resolved path is inside
    // workspaceRoot. The CLI runs against a per-invocation workspace
    // (the cwd `bandit` was started from), so this is the correct
    // sandbox boundary.
    const resolved = path.resolve(expandHome(absolutePath));
    const root = path.resolve(this.workspaceRoot);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(`Refusing to delete outside workspace: ${absolutePath}`);
    }
    await fs.promises.unlink(resolved);
  }

  async listFiles(pattern: string, cwd?: string): Promise<string[]> {
    const base = expandHome(cwd ?? this.workspaceRoot);
    const matcher = compileGlob(pattern);
    const results: string[] = [];
    await walk(base, base, matcher, results);
    return results.slice(0, MAX_LIST_RESULTS).sort();
  }

  async listDirectoryEntries(cwd: string): Promise<string[]> {
    const base = expandHome(cwd);
    const entries = await fs.promises.readdir(base, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      // Hidden files (dotfiles) stay out of the default listing — they
      // dominate $HOME and most home directory listings aren't what
      // users asked about. A user who wants them can use ls -a in
      // run_command. Mirrors standard ls behavior.
      if (entry.name.startsWith('.')) continue;
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        // Resolve symlinks so iCloud-synced Desktop/Documents still
        // report as directories. The target may not exist; in that
        // case, fall back to treating it as a file.
        try {
          const stat = await fs.promises.stat(path.join(base, entry.name));
          isDir = stat.isDirectory();
        } catch {
          isDir = false;
        }
      }
      out.push(isDir ? `${entry.name}/` : entry.name);
    }
    return out.sort();
  }

  async searchCode(pattern: string, cwd?: string, fileGlob?: string): Promise<string> {
    const dir = expandHome(cwd ?? this.workspaceRoot);
    return this.runRipgrep(pattern, dir, fileGlob).catch(() =>
      this.runGrep(pattern, dir, fileGlob)
    );
  }

  async runCommand(
    cmd: string,
    args: string[],
    cwd?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Tilde expansion: `mkdir ~/Desktop/Foo` — the model emits ~ verbatim
    // because that's what users type in a shell, but spawn(shell:false)
    // doesn't expand it (~ is a shell-only feature). Without this,
    // mkdir creates a literal directory named "~" in the CWD instead of
    // the user's home dir. expandHome only touches a leading ~/, so flag
    // values like `--prefix=~/foo` still need the model to write the
    // path absolute — acceptable since the common case is positional.
    const expandedArgs = args.map(expandHome);
    const expandedCwd = cwd ? expandHome(cwd) : this.workspaceRoot;

    // Env-var precedence cleanup for credential-aware tools. gh in
    // particular resolves auth in this order: GH_TOKEN > GITHUB_TOKEN
    // env vars > stored config from `gh auth login`. If the user's
    // shell has GITHUB_TOKEN set (very common — gh auth login sets it
    // on some installs, leftover from a prior run, or set manually
    // for local scripting) gh uses THAT and silently ignores the
    // user's freshly-completed `gh auth login` session. Symptom:
    // `gh auth status` shows "authenticated" but every gh command
    // hits 401 / Bad credentials. We strip empty-string and
    // whitespace-only tokens unconditionally (they're definitely not
    // valid credentials), and pass through real values unchanged so
    // the user can opt in to env-var auth when they want it.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    const baseCmd = cmd.split(/[\\/]/).pop() ?? cmd;
    if (baseCmd === 'gh') {
      for (const key of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
        const raw = childEnv[key];
        if (typeof raw === 'string' && raw.trim() === '') {
          delete childEnv[key];
        }
      }
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      // On Windows, npm-shipped binaries are batch shims (`npx.cmd`,
      // `npm.cmd`, `pnpm.cmd`, `tsc.cmd`, `yarn.cmd`). Node's spawn with
      // `shell: false` cannot resolve those — it only spawns native
      // executables — so calls to `npx ...` / `npm ...` return ENOENT
      // and the agent surfaces "command not found" even though the
      // tool is on the user's PATH. Setting `shell: true` on win32
      // routes through `cmd.exe /d /s /c` which DOES resolve `.cmd` /
      // `.bat` shims. We don't enable shell on POSIX because run_command
      // already filters destructive shell metacharacters (BLOCKED_PATTERNS
      // in core-tools) and we'd rather pass args verbatim to argv[].
      const proc = cp.spawn(cmd, expandedArgs, {
        cwd: expandedCwd,
        shell: process.platform === 'win32',
        env: childEnv
      });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({
          stdout: stdout.slice(0, MAX_COMMAND_BYTES),
          stderr: stderr + '\n[process timed out]',
          exitCode: 124
        });
      }, COMMAND_TIMEOUT_MS);

      // Live-stream stdout/stderr to the user's terminal as bytes
      // arrive — without this, long commands like `npm install`
      // (~20s) or `watch_command npm run dev` (60s) look frozen
      // because Bandit only hands buffered output to the model after
      // the process exits. Stream is dim + carriage-returned so it
      // doesn't fight the spinner's `\r\x1b[2K` redraw on the bottom
      // line; the spinner re-paints below incoming output on its
      // next 80ms tick. Skipped on non-TTY (CI, piped stdin) so we
      // don't leak duplicate output into eval/integration runs that
      // already read the captured `stdout` field.
      const STREAM_TO_USER = process.stdout.isTTY === true;
      const writeLive = (chunk: string, errStream: boolean) => {
        if (!STREAM_TO_USER) return;
        // \r\x1b[2K wipes whatever the spinner painted on the
        // current line; \x1b[2m...\x1b[0m dims the chunk so it
        // visually subordinates to the agent's own messages.
        const target = errStream ? process.stderr : process.stdout;
        target.write('\r\x1b[2K\x1b[2m' + chunk + '\x1b[0m');
      };
      proc.stdout?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        stdout += chunk;
        writeLive(chunk, false);
        if (stdout.length > MAX_COMMAND_BYTES) proc.kill('SIGTERM');
      });
      proc.stderr?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        writeLive(chunk, true);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        const outBytes = stdout.slice(0, MAX_COMMAND_BYTES);
        // Interactive-scaffolder detection. Modern create-vite, create-
        // react-app's clack ports, create-next-app, ng new, vue create,
        // pnpm create, etc. detect a non-TTY stdin and self-abort with
        // "Operation cancelled" + exit code 0. Bandit always captures
        // stdout/stderr (so the model can read the result), which means
        // stdin to the child is not a TTY. Without translating that
        // result into a clear "needs interactive stdin" signal, models
        // see "exit 0, no error" and loop the same call assuming the
        // user pressed Esc. Convert it to an isError=true result with
        // a verbatim retry path the model can hand back to the user.
        const looksCancelledByNoTty = code === 0
          && /Operation cancelled/i.test(outBytes)
          && /(create-vite|create-react-app|create-next|create-svelte|create-astro|create-remix|@clack)/i.test(`${cmd} ${expandedArgs.join(' ')} ${outBytes}`);
        if (looksCancelledByNoTty) {
          const fullCmd = [cmd, ...expandedArgs].join(' ');
          resolve({
            stdout: outBytes,
            stderr: `Interactive scaffolder detected — \`${cmd}\` aborted with "Operation cancelled" because Bandit captures stdout/stderr (no TTY on stdin) and modern scaffolders refuse to start without one. Tell the user to run this directly in their shell: \`!${fullCmd}\`. The \`!\`-prefix runs through their terminal with real stdin, so the scaffolder's prompts work. After they finish, you can pick up from the resulting filesystem state. Do NOT retry the same command — it will loop forever.`,
            exitCode: 1
          });
          return;
        }
        resolve({
          stdout: outBytes,
          stderr: stderr.slice(0, 4 * 1024),
          exitCode: code ?? 0
        });
      });

      proc.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        // ENOENT here means the executable wasn't found on PATH. The
        // raw "spawn npx ENOENT" is opaque to both the model and the
        // user — they assume the tool is broken when really PATH just
        // doesn't include the npm bin dir (common with nvm/asdf when
        // the CLI is launched outside an interactive shell). Surface
        // a recovery hint so the model can suggest a fix instead of
        // looping on the same call.
        if (err.code === 'ENOENT') {
          resolve({
            stdout: '',
            stderr: `spawn ${cmd} ENOENT — '${cmd}' not found on PATH. Verify the tool is installed (\`which ${cmd}\` in a fresh terminal). If you use nvm/asdf/volta, your shim PATH may not be inherited; relaunching this CLI from the same terminal session that has \`${cmd}\` on PATH usually fixes it.`,
            exitCode: 127
          });
          return;
        }
        resolve({ stdout: '', stderr: err.message, exitCode: 1 });
      });
    });
  }

  /**
   * Spawn a process and capture stdout/stderr for `durationMs`. SIGTERMs
   * the process at the deadline if it's still running. Used by the
   * `watch_command` tool so the agent can run a dev server / log tailer
   * for a bounded window and react to what came out — distinct from
   * runCommand which expects the process to exit on its own.
   *
   * Buffer + shell semantics mirror runCommand for consistency. The one
   * meaningful difference is that we send SIGTERM (then SIGKILL after
   * a 1s grace period) rather than relying on the process to exit —
   * watch_command's whole point is processes that wouldn't exit on
   * their own.
   */
  async watchCommand(
    cmd: string,
    args: string[],
    cwd: string | undefined,
    durationMs: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; endedEarly: boolean }> {
    // Tilde expansion — same rationale as runCommand. spawn(shell:false)
    // doesn't expand ~, and watch_command is also commonly pointed at
    // ~/some-project directories.
    const expandedArgs = args.map(expandHome);
    const expandedCwd = cwd ? expandHome(cwd) : this.workspaceRoot;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let endedEarly = false;
      let resolved = false;

      const proc = cp.spawn(cmd, expandedArgs, {
        cwd: expandedCwd,
        shell: process.platform === 'win32',
        env: { ...process.env }
      });

      const finish = (exitCode: number | null) => {
        if (resolved) return;
        resolved = true;
        resolve({
          stdout: stdout.slice(0, MAX_COMMAND_BYTES),
          stderr: stderr.slice(0, 4 * 1024),
          exitCode,
          endedEarly
        });
      };

      const watchTimer = setTimeout(() => {
        // Grace period: SIGTERM, then SIGKILL after 1s if still alive.
        // Without the SIGKILL fallback, processes that ignore SIGTERM
        // (some node child processes, infinite-loop scripts) would hold
        // the watch_command call hostage indefinitely.
        try { proc.kill('SIGTERM'); } catch { /* may already be dead */ }
        const killTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* may already be dead */ }
          finish(null);
        }, 1000);
        proc.once('close', (code) => {
          clearTimeout(killTimer);
          finish(typeof code === 'number' ? code : null);
        });
      }, durationMs);

      // Same live-stream-to-user pattern as runCommand above. Watch
      // commands run for 60s+ by design (dev servers, log tailers),
      // so streaming is even more important here — without it the
      // user sits looking at a frozen spinner for the entire window
      // even though vite is happily logging "ready in 319 ms".
      const STREAM_TO_USER = process.stdout.isTTY === true;
      const writeLive = (chunk: string, errStream: boolean) => {
        if (!STREAM_TO_USER) return;
        const target = errStream ? process.stderr : process.stdout;
        target.write('\r\x1b[2K\x1b[2m' + chunk + '\x1b[0m');
      };
      proc.stdout?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        stdout += chunk;
        writeLive(chunk, false);
        if (stdout.length > MAX_COMMAND_BYTES) {
          // Output cap hit. Stop the process — keeping it alive past the
          // cap just spends user CPU on bytes the agent will never see.
          try { proc.kill('SIGTERM'); } catch { /* may already be dead */ }
        }
      });
      proc.stderr?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        writeLive(chunk, true);
      });

      proc.on('close', (code) => {
        if (resolved) return;
        clearTimeout(watchTimer);
        endedEarly = true;
        finish(typeof code === 'number' ? code : null);
      });

      proc.on('error', (err) => {
        if (resolved) return;
        clearTimeout(watchTimer);
        endedEarly = true;
        stderr += err.message;
        finish(1);
      });
    });
  }

  private runRipgrep(pattern: string, dir: string, fileGlob?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--color=never',
        '--line-number',
        '--max-count=25',
        '--max-filesize=1M',
        ...[...IGNORED_DIRS].map(d => ['--glob', `!${d}`]).flat(),
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
        if (output.length > MAX_SEARCH_BYTES) proc.kill('SIGTERM');
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
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
      const excludeDirArgs = [...IGNORED_DIRS].map(d => ['--exclude-dir', d]).flat();
      // See nodeToolContext.ts — grep's --include only matches basenames
      // and does not support `**` / brace expansion. Rewrite the glob into
      // per-extension includes + a subdirectory positional so the CLI's
      // grep fallback behaves the same as ripgrep when rg is absent.
      const expanded = fileGlob ? expandGlobForGrep(fileGlob) : { includes: [], subDir: '' };
      const includeArgs = expanded.includes.flatMap(i => ['--include', i]);
      const effectiveDir = expanded.subDir ? `${dir}/${expanded.subDir}` : dir;
      const args = [
        '-rn',
        '-E',
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
        if (output.length > MAX_SEARCH_BYTES) proc.kill('SIGTERM');
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
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

// ── Glob helpers ────────────────────────────────────────────────────────────
// A tiny, dependency-free glob → regex. Supports **, *, ?, and {a,b,c}.
// Matches the relative path against the full pattern.

function compileGlob(pattern: string): (relPath: string) => boolean {
  const regex = globToRegex(pattern);
  return (rel: string) => regex.test(rel.replace(/\\/g, '/'));
}

function globToRegex(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { out += '\\{'; continue; }
      const opts = glob.slice(i + 1, end).split(',').map(escapeRegex).join('|');
      out += `(?:${opts})`;
      i = end;
    } else if (/[.+^$()|\\]/.test(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function walk(
  dir: string,
  rootBase: string,
  match: (rel: string) => boolean,
  out: string[]
): Promise<void> {
  if (out.length >= MAX_LIST_RESULTS) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_LIST_RESULTS) return;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(rootBase, full);
    if (entry.isDirectory()) {
      await walk(full, rootBase, match, out);
    } else if (entry.isFile() && match(rel)) {
      out.push(full);
    }
  }
}

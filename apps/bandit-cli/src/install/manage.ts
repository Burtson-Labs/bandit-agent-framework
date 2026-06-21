/**
 * Install management for the `bandit` CLI: `bandit doctor` (find and consolidate
 * multiple installs) and `bandit upgrade` (self-update the standalone binary).
 *
 * Bandit can be installed two ways — a standalone binary (curl installer) and
 * the npm package — and the two can coexist, with PATH order silently deciding
 * which one runs. These commands surface that and let the user consolidate.
 *
 * Memory and settings live in ~/.bandit, independent of the executable, so
 * removing an install never touches user data — we only ever delete a binary or
 * run `npm uninstall`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execFileSync } from 'child_process';

const REPO = 'Burtson-Labs/bandit-agent-framework';
const SCOPED_PKG = '@burtson-labs/bandit-stealth-cli';
const CONFIG_DIR = '~/.bandit';

const isWindows = process.platform === 'win32';
/** True when running as a bun-compiled standalone binary (vs the npm node script). */
const isBinaryRuntime = !!(process.versions as Record<string, string | undefined>).bun;
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code: string, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string): string => c('2', s);
const bold = (s: string): string => c('1', s);
const green = (s: string): string => c('32', s);
const yellow = (s: string): string => c('33', s);
const cyan = (s: string): string => c('36', s);

export interface InstallContext {
  /** The running CLI's own version (from package.json). */
  version: string;
}

export interface BanditInstall {
  /** Path as found on PATH (the bin entry; may be a symlink). */
  path: string;
  /** Symlinks resolved. */
  realPath: string;
  version: string | null;
  method: 'binary' | 'npm' | 'unknown';
  /** First on PATH — the one `bandit` actually runs. */
  active: boolean;
  /** The currently-running process. */
  self: boolean;
}

function realPathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Inspect the file to decide how it was installed. */
function methodOf(realPath: string): 'binary' | 'npm' | 'unknown' {
  if (realPath.endsWith('.js') || realPath.includes(`${path.sep}node_modules${path.sep}`)) {
    return 'npm';
  }
  if (isWindows && (realPath.endsWith('.cmd') || realPath.endsWith('.ps1'))) {
    return 'npm';
  }
  try {
    const fd = fs.openSync(realPath, 'r');
    const head = Buffer.alloc(2);
    const n = fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (n === 2 && head[0] === 0x23 && head[1] === 0x21) {
      return 'npm'; // "#!" shebang → a node script shim
    }
    // bun --compile binaries are large standalone executables (~70 MB).
    if (fs.statSync(realPath).size > 5_000_000) {
      return 'binary';
    }
  } catch {
    /* fall through */
  }
  return 'unknown';
}

function versionOf(p: string): string | null {
  try {
    const out = execFileSync(p, ['--version'], {
      timeout: 7000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
    return m ? m[1] : out.trim() || null;
  } catch {
    return null;
  }
}

/** Resolved path of the executable/script currently running. */
function selfRealPath(): string {
  // A bun-compiled binary IS process.execPath. Under node/npm the script is argv[1].
  if (isBinaryRuntime) {
    return realPathSafe(process.execPath);
  }
  return realPathSafe(process.argv[1] ?? process.execPath);
}

/** Walk up from a file to the nearest bandit package.json and return its name. */
function npmPackageNameFor(realPath: string): string | null {
  let dir = path.dirname(realPath);
  for (let i = 0; i < 6; i += 1) {
    const pj = path.join(dir, 'package.json');
    try {
      if (fs.existsSync(pj)) {
        const name = JSON.parse(fs.readFileSync(pj, 'utf8')).name;
        if (typeof name === 'string' && /bandit/.test(name)) {
          return name;
        }
      }
    } catch {
      /* ignore unreadable package.json */
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/** Every `bandit` on PATH, in PATH order (first entry is the active one). */
export function detectInstalls(): BanditInstall[] {
  const names = isWindows ? ['bandit.exe', 'bandit.cmd', 'bandit'] : ['bandit'];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const self = selfRealPath();
  const seen = new Set<string>();
  const found: BanditInstall[] = [];

  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (!fs.statSync(full).isFile()) {
          continue;
        }
      } catch {
        continue;
      }
      const real = realPathSafe(full);
      if (seen.has(real)) {
        continue;
      }
      seen.add(real);
      found.push({
        path: full,
        realPath: real,
        version: versionOf(full),
        method: methodOf(real),
        active: false,
        self: real === self,
      });
    }
  }
  if (found.length > 0) {
    // The first match in PATH order is what `bandit` resolves to.
    found[0].active = true;
  }
  return found;
}

export function isNewer(current: string, candidate: string): boolean {
  const parse = (v: string): number[] => v.split('.').map((n) => parseInt(n, 10) || 0);
  const [a1, a2, a3] = parse(current);
  const [b1, b2, b3] = parse(candidate);
  return b1 > a1 || (b1 === a1 && b2 > a2) || (b1 === a1 && b2 === a2 && b3 > a3);
}

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false; // non-interactive (piped / CI) → decline, never hang
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function removeInstall(install: BanditInstall): boolean {
  try {
    if (install.method === 'npm') {
      const pkg = npmPackageNameFor(install.realPath) ?? SCOPED_PKG;
      process.stdout.write(dim(`  running: npm uninstall -g ${pkg}\n`));
      execFileSync('npm', ['uninstall', '-g', pkg], { stdio: 'inherit', shell: isWindows });
    } else {
      // Binary / unknown: remove the bin entry (and its real target if separate).
      fs.rmSync(install.path, { force: true });
      if (install.realPath !== install.path) {
        fs.rmSync(install.realPath, { force: true });
      }
    }
    return true;
  } catch (err) {
    process.stderr.write(yellow(`  could not remove ${install.path}: ${(err as Error).message}\n`));
    return false;
  }
}

function label(install: BanditInstall): string {
  const ver = install.version ? `v${install.version}` : 'version unknown';
  const tags = [install.active ? green('active') : '', install.self ? cyan('running') : '']
    .filter(Boolean)
    .join(', ');
  return `${install.path}  ${dim(`${ver} · ${install.method}`)}${tags ? `  (${tags})` : ''}`;
}

export async function runDoctor(args: string[], ctx: InstallContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'Usage: bandit doctor [--yes] [--json]\n\n' +
        'Lists every bandit install on your PATH and offers to remove the extras so a\n' +
        'single one runs. Your memory and settings in ~/.bandit are never touched.\n\n' +
        '  --yes, -y   remove the extras without prompting\n' +
        '  --json      print the detected installs as JSON and exit\n'
    );
    return;
  }

  const installs = detectInstalls();

  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({ configDir: CONFIG_DIR, installs }, null, 2) + '\n');
    return;
  }

  process.stdout.write(bold('\nBandit installs on your PATH:\n\n'));
  if (installs.length === 0) {
    process.stdout.write(`  ${yellow('none found')} (running v${ctx.version})\n`);
    return;
  }
  for (const install of installs) {
    process.stdout.write(`  ${install.active ? green('●') : dim('○')} ${label(install)}\n`);
  }
  process.stdout.write(dim(`\n  Memory and settings live in ${CONFIG_DIR} and are never touched by cleanup.\n`));

  if (installs.length === 1) {
    process.stdout.write(green('\n✓ Single install — nothing to clean up.\n'));
    return;
  }

  // Recommend keeping the standalone binary (the direction the curl installer
  // moves people toward); otherwise keep whichever is active. Break ties on the
  // newest version.
  const pick = (candidates: BanditInstall[]): BanditInstall =>
    candidates.reduce((best, x) =>
      x.version && best.version && isNewer(best.version, x.version) ? x : best
    );
  const binaries = installs.filter((i) => i.method === 'binary');
  const keeper = binaries.length > 0 ? pick(binaries) : installs.find((i) => i.active) ?? installs[0];

  process.stdout.write(
    yellow(`\n! ${installs.length} installs found — only the active one runs.\n`) +
      `  Recommended: keep ${bold(keeper.path)} ${dim(keeper.version ? `(v${keeper.version}, ${keeper.method})` : '')} and remove the rest.\n\n`
  );

  const assumeYes = args.includes('--yes') || args.includes('-y');
  const toRemove = installs.filter((i) => i.realPath !== keeper.realPath);
  let removed = 0;
  for (const install of toRemove) {
    const ok = assumeYes || (await promptYesNo(`Remove ${install.path} (${install.method})?`));
    if (!ok) {
      process.stdout.write(dim(`  skipped ${install.path}\n`));
      continue;
    }
    if (removeInstall(install)) {
      removed += 1;
    }
  }

  if (removed === 0) {
    process.stdout.write(dim('\nNothing removed.\n'));
    return;
  }
  process.stdout.write(green(`\n✓ Removed ${removed} install${removed === 1 ? '' : 's'}. `));
  if (!keeper.active) {
    const keeperDir = path.dirname(keeper.path);
    process.stdout.write(
      `${keeper.path} will run now` +
        (process.env.PATH?.split(path.delimiter).includes(keeperDir)
          ? '.\n'
          : `, once ${cyan(keeperDir)} is on your PATH:\n  export PATH="${keeperDir}:$PATH"\n`)
    );
  } else {
    process.stdout.write('\n');
  }
}

export function assetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  const os =
    platform === 'darwin'
      ? 'darwin'
      : platform === 'linux'
        ? 'linux'
        : platform === 'win32'
          ? 'windows'
          : null;
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!os || !cpu) {
    return null;
  }
  if (os === 'windows') {
    return cpu === 'x64' ? 'bandit-windows-x64.exe' : null;
  }
  return `bandit-${os}-${cpu}`;
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: ctrl.signal,
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'bandit-cli' },
    });
    clearTimeout(timer);
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { tag_name?: string };
    return body.tag_name ? body.tag_name.replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

export async function runUpgrade(args: string[], ctx: InstallContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'Usage: bandit upgrade\n\n' +
        'Updates the standalone bandit binary to the latest release in place.\n' +
        'If you installed via npm, it tells you the npm command to run instead.\n'
    );
    return;
  }

  // The npm install is managed by npm — don't try to self-replace a node_modules file.
  if (!isBinaryRuntime) {
    process.stdout.write(
      `You're running the npm install of bandit (v${ctx.version}).\n` +
        `Upgrade it with:\n\n  ${cyan(`npm install -g ${SCOPED_PKG}@latest`)}\n\n`
    );
    return;
  }

  const asset = assetName();
  if (!asset) {
    process.stderr.write(yellow(`No prebuilt binary for ${process.platform}/${process.arch}.\n`));
    process.exitCode = 1;
    return;
  }

  process.stdout.write(dim('Checking for the latest release…\n'));
  const latest = await fetchLatestVersion();
  if (!latest) {
    process.stderr.write(yellow('Could not reach the release server. Try again later.\n'));
    process.exitCode = 1;
    return;
  }
  if (!isNewer(ctx.version, latest)) {
    process.stdout.write(green(`✓ bandit is already up to date (v${ctx.version}).\n`));
    return;
  }

  process.stdout.write(`Updating bandit ${dim(`v${ctx.version}`)} → ${bold(`v${latest}`)}…\n`);
  const url = `https://github.com/${REPO}/releases/download/v${latest}/${asset}`;
  const selfPath = realPathSafe(process.execPath);
  const tmp = `${selfPath}.new-${process.pid}`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'bandit-cli' } });
    if (!res.ok) {
      throw new Error(`download failed (HTTP ${res.status})`);
    }
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });

    // Verify the freshly downloaded binary runs and reports the new version.
    const check = execFileSync(tmp, ['--version'], { timeout: 15000, encoding: 'utf8' });
    if (!check.includes(latest)) {
      throw new Error(`downloaded binary reported "${check.trim()}", expected v${latest}`);
    }

    if (isWindows) {
      // A running .exe can't be overwritten on Windows; rotate it aside first.
      fs.rmSync(`${selfPath}.old`, { force: true });
      fs.renameSync(selfPath, `${selfPath}.old`);
      fs.renameSync(tmp, selfPath);
    } else {
      fs.renameSync(tmp, selfPath); // atomic; the running process keeps the old inode
    }
    process.stdout.write(green(`\n✓ Updated to v${latest}. Restart bandit to use it.\n`));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    process.stderr.write(yellow(`\n✗ Upgrade failed: ${(err as Error).message}\n`));
    process.stderr.write(dim(`  Re-run the installer instead:\n  curl -fsSL https://burtson.ai/bandit-stealth-cli/install.sh | sh\n`));
    process.exitCode = 1;
  }
}

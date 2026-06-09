/**
 * Cross-platform clipboard image reader.
 *
 * Each platform ships a native CLI tool that can dump the clipboard image
 * as PNG bytes to stdout. We shell out rather than pull in a binary
 * dependency (which would be platform-specific anyway and double the
 * install footprint).
 *
 *   macOS   → osascript (built-in)
 *   Linux   → xclip (X11) with wl-paste (Wayland) fallback
 *   Windows → PowerShell (built-in; uses System.Windows.Forms.Clipboard)
 *
 * Returns the path to a freshly written PNG in the OS tempdir on success,
 * or null if the clipboard doesn't hold an image. Callers are responsible
 * for eventually deleting the tempfile (or just letting the OS clean it
 * up on the next tmp sweep — the bytes are small).
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

function freshTempPath(): string {
  const id = crypto.randomBytes(4).toString('hex');
  return path.join(os.tmpdir(), `bandit-paste-${Date.now()}-${id}.png`);
}

/**
 * Run a shell pipeline, swallowing the exit code. Used for tools like
 * `xclip -selection clipboard -t image/png -o` that exit non-zero when
 * the clipboard doesn't hold an image — we want to treat that as "no
 * image" rather than an error.
 */
function tryExec(command: string, args: string[], options: cp.SpawnSyncOptions = {}): { stdout: Buffer; code: number | null } {
  try {
    const result = cp.spawnSync(command, args, { ...options, encoding: undefined });
    return {
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ''),
      code: result.status
    };
  } catch {
    return { stdout: Buffer.alloc(0), code: null };
  }
}

export interface ClipboardImage {
  path: string;
  sizeBytes: number;
}

/** Attempt to read the clipboard as a PNG. Returns null if no image is present. */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  if (process.platform === 'darwin') {
    return readDarwin();
  }
  if (process.platform === 'linux') {
    return readLinux();
  }
  if (process.platform === 'win32') {
    return readWin32();
  }
  return null;
}

function readDarwin(): ClipboardImage | null {
  // osascript with the «class PNGf» clipboard coercion writes raw PNG
  // bytes — pipe through stdout to a tempfile. If the clipboard doesn't
  // hold an image, osascript errors and we return null.
  const target = freshTempPath();
  const script = `set pngData to (the clipboard as «class PNGf»)\n` +
    `set outFile to (open for access (POSIX file "${target}") with write permission)\n` +
    `write pngData to outFile\n` +
    `close access outFile`;
  const { code } = tryExec('osascript', ['-e', script]);
  if (code !== 0) {
    try { fs.unlinkSync(target); } catch { /* already gone */ }
    return null;
  }
  try {
    const stat = fs.statSync(target);
    if (stat.size === 0) {
      fs.unlinkSync(target);
      return null;
    }
    return { path: target, sizeBytes: stat.size };
  } catch {
    return null;
  }
}

function readLinux(): ClipboardImage | null {
  // Wayland first (wl-paste is the modern replacement); fall back to
  // xclip on X11. Either returns raw PNG bytes on stdout.
  const wayland = tryExec('wl-paste', ['-t', 'image/png']);
  if (wayland.code === 0 && wayland.stdout.length > 0) {
    return writeBytes(wayland.stdout);
  }
  const xclip = tryExec('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']);
  if (xclip.code === 0 && xclip.stdout.length > 0) {
    return writeBytes(xclip.stdout);
  }
  return null;
}

function readWin32(): ClipboardImage | null {
  const target = freshTempPath();
  // Two-step: Get-Clipboard -Format Image returns a Bitmap object which
  // we save via .Save(path, Png). -NoProfile keeps cold start fast.
  const psScript = [
    'Add-Type -AssemblyName System.Drawing;',
    '$img = Get-Clipboard -Format Image;',
    `if ($img -eq $null) { exit 1 };`,
    `$img.Save("${target.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)`
  ].join(' ');
  const { code } = tryExec('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
  if (code !== 0) {
    try { fs.unlinkSync(target); } catch { /* already gone */ }
    return null;
  }
  try {
    const stat = fs.statSync(target);
    if (stat.size === 0) {
      fs.unlinkSync(target);
      return null;
    }
    return { path: target, sizeBytes: stat.size };
  } catch {
    return null;
  }
}

function writeBytes(bytes: Buffer): ClipboardImage {
  const target = freshTempPath();
  fs.writeFileSync(target, bytes);
  return { path: target, sizeBytes: bytes.length };
}

/**
 * Heuristic: does this line look like a single absolute path pointing at
 * an image file? When the user drags a file from Finder/Explorer into a
 * terminal it pastes the shell-escaped path as a single token. Treat
 * that as an image attachment instead of a prompt.
 */
export function looksLikeImagePath(line: string): string | null {
  const trimmed = line.trim().replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ');
  if (!trimmed) return null;
  if (!path.isAbsolute(trimmed)) return null;
  if (!/\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(trimmed)) return null;
  try {
    const stat = fs.statSync(trimmed);
    if (!stat.isFile()) return null;
    return trimmed;
  } catch {
    return null;
  }
}

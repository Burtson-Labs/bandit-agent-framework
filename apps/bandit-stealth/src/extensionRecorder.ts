/**
 * Extension-side microphone capture.
 *
 * Webviews in VS Code run inside a sandboxed iframe with a stable
 * `vscode-webview://<id>` origin, and Chromium caches permission
 * decisions per origin in the editor's `Preferences` file. Once a
 * "denied" verdict is cached there, even a fresh OS-level TCC allow
 * doesn't get the webview microphone working again — a window reload
 * doesn't help, the verdict survives. The only reliable recoveries are
 * deleting the Preferences file by hand or reinstalling the extension.
 *
 * That's a bad user-facing fix. The real fix is to never go through the
 * webview's mic at all: the extension itself runs in VS Code's main
 * Node process, which has full TCC permission once the user grants
 * "Visual Studio Code wants mic access" exactly once. From there,
 * spawning a recording binary (ffmpeg, sox) inherits VS Code's verdict
 * with no Chromium origin involved.
 *
 * This module wraps that path. It probes for an available recorder at
 * extension activation, exposes start()/stop() that produce a Buffer of
 * recorded audio, and surfaces a friendly diagnostic when no recorder
 * is installed. The wire format on stop() is a single WAV blob the
 * gateway transcribe endpoint already accepts.
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type RecorderKind = 'bundled' | 'ffmpeg' | 'sox' | 'arecord';

/** Path to a recorder binary shipped INSIDE the extension's VSIX. Set
 * once at extension activation via `setBundledRecorderPath`. When set,
 * it sits at the top of the probe order so users don't need any
 * external recorder installed for the mic to Just Work. */
let bundledRecorderPath: string | null = null;

/**
 * Called by the extension activate() with the absolute path to the
 * platform-specific recorder bundled in the extension's `media/recorders/`
 * directory. Pass null if no binary ships for this platform — the probe
 * falls through to the existing system-tool detection (arecord on Linux,
 * ffmpeg/sox elsewhere).
 *
 * Best-effort chmod +x on the binary. The marketplace install pipeline
 * (and some VSIX unzip implementations) strip the executable bit, so
 * even though we ship the binary with mode 0755 the extracted file
 * lands at 0644. spawn() then fails with EACCES at first mic use. We
 * fix it here at activation time so users never hit that error path.
 */
export function setBundledRecorderPath(absPath: string | null): void {
  bundledRecorderPath = absPath;
  if (absPath) {
    try {
      const stat = fs.statSync(absPath);
      // Check the owner-execute bit (0o100). If missing, chmod 0755.
      // Skip if the bit is already set so we don't churn permissions
      // on every activation.
      if ((stat.mode & 0o100) === 0) {
        fs.chmodSync(absPath, 0o755);
      }
    } catch {
      // Binary missing or not statable — probe will fall through to
      // ffmpeg/sox detection and surface a friendly install message.
    }
  }
  // Reset the cached probe so the next probeRecorder() call sees the
  // bundled path. Activation runs before any webview probe so this is
  // mostly defensive.
  cachedProbe = null;
}

/** Per-platform install hint used by the "one-click install" flow.
 * `command` is what we run in the user's integrated terminal when
 * they click "Install" on the missing-recorder notification. */
export interface InstallHint {
  manager: 'brew' | 'apt' | 'winget' | null;
  command: string;
  friendlyName: string;
}

export interface RecorderProbe {
  available: boolean;
  kind?: RecorderKind;
  binary?: string;
  /** Human-readable note for the user when no recorder is available. */
  message: string;
}

interface ActiveRecording {
  kind: RecorderKind;
  proc: cp.ChildProcess;
  outFile: string;
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
  /** True after stop() asked the recorder to finish so the close handler
   * can distinguish a clean stop from an unexpected exit. */
  stopping: boolean;
}

let active: ActiveRecording | null = null;
let cachedProbe: RecorderProbe | null = null;

/**
 * Look for a working recorder binary on PATH. Cached after the first
 * call — recorders aren't installed mid-session in any realistic flow.
 * The probe is allowed to be slightly slow; it runs once at first use.
 */
export function probeRecorder(): RecorderProbe {
  if (cachedProbe) {return cachedProbe;}
  const which = (bin: string): string | null => {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const result = cp.spawnSync(cmd, [bin], { encoding: 'utf-8' });
      if (result.status === 0) {
        const first = (result.stdout || '').split(/\r?\n/).find(Boolean);
        if (first) {return first.trim();}
      }
    } catch { /* ENOENT etc. — fall through */ }
    return null;
  };

  // Bundled recorder (currently macOS only — bandit-mic, a tiny Swift
  // AVFoundation binary). When present it's preferred over everything
  // else: zero install for the user, no PATH lookup, no Chromium origin
  // permission cache in the loop.
  if (bundledRecorderPath && fs.existsSync(bundledRecorderPath)) {
    cachedProbe = {
      available: true,
      kind: 'bundled',
      binary: bundledRecorderPath,
      message: `bundled recorder at ${bundledRecorderPath}`
    };
    return cachedProbe;
  }

  // arecord is part of alsa-utils — preinstalled on basically every
  // desktop Linux distro (Ubuntu, Debian, Fedora, Arch GNOME/KDE
  // images all ship it). Probe it FIRST on Linux so the common case
  // is "Just Works" with no install.
  if (process.platform === 'linux') {
    const arecord = which('arecord');
    if (arecord) {
      cachedProbe = { available: true, kind: 'arecord', binary: arecord, message: `arecord detected at ${arecord}` };
      return cachedProbe;
    }
  }
  const ffmpeg = which('ffmpeg');
  if (ffmpeg) {
    cachedProbe = { available: true, kind: 'ffmpeg', binary: ffmpeg, message: `ffmpeg detected at ${ffmpeg}` };
    return cachedProbe;
  }
  // sox ships a separate `rec` binary on the same install, but plain
  // `sox` is what's reliably on PATH after `brew install sox`.
  const sox = which('rec') ?? which('sox');
  if (sox) {
    cachedProbe = { available: true, kind: 'sox', binary: sox, message: `sox/rec detected at ${sox}` };
    return cachedProbe;
  }

  const hint = getInstallHint();
  cachedProbe = {
    available: false,
    message: hint.manager
      ? `No microphone recorder found. Install one with: ${hint.command}`
      : `No microphone recorder found. ${hint.command}`
  };
  return cachedProbe;
}

/**
 * Per-platform install hint for the missing-recorder one-click flow.
 * Detects whether a known package manager is available so the
 * extension can offer "Install for me" vs just "here's the URL."
 *
 * macOS: prefers Homebrew (~95% of dev macs have it).
 * Linux: prefers apt (Debian/Ubuntu) — other distros fall through to
 * a generic message. We don't pretend to support every distro
 * package manager here; users on dnf/pacman/zypper get a
 * copy-paste command instead of the auto-install button.
 * Windows: prefers winget (preinstalled on Windows 10 21H2+, 11).
 */
export function getInstallHint(): InstallHint {
  const which = (bin: string): boolean => {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const r = cp.spawnSync(cmd, [bin], { encoding: 'utf-8' });
      return r.status === 0 && Boolean(r.stdout?.trim());
    } catch { return false; }
  };
  if (process.platform === 'darwin') {
    if (which('brew')) {
      return { manager: 'brew', command: 'brew install ffmpeg', friendlyName: 'Homebrew' };
    }
    return {
      manager: null,
      command: 'Install Homebrew from https://brew.sh, then run: brew install ffmpeg',
      friendlyName: 'Homebrew'
    };
  }
  if (process.platform === 'linux') {
    if (which('apt')) {
      // alsa-utils gives us arecord which is the simplest path on
      // Linux — no transcoding, just raw WAV. ffmpeg is a fallback if
      // alsa-utils isn't available for some reason.
      return { manager: 'apt', command: 'sudo apt install -y alsa-utils', friendlyName: 'apt' };
    }
    return {
      manager: null,
      command: 'Install alsa-utils via your distro\'s package manager (provides arecord), or ffmpeg from https://ffmpeg.org.',
      friendlyName: 'package manager'
    };
  }
  // Windows
  if (which('winget')) {
    return { manager: 'winget', command: 'winget install -e --id Gyan.FFmpeg', friendlyName: 'winget' };
  }
  return {
    manager: null,
    command: 'Install ffmpeg from https://ffmpeg.org/download.html and add it to PATH.',
    friendlyName: 'manual install'
  };
}

/**
 * Build the platform-specific argv for the recorder. The output file is
 * a 16 kHz mono WAV — the gateway transcription endpoint accepts that
 * directly. We pin the format so transcript quality doesn't drift with
 * default-device sample rates.
 */
function buildRecorderArgs(kind: RecorderKind, outFile: string): string[] {
  if (kind === 'bundled') {
    // bandit-mic takes a single positional arg: the output WAV path.
    // Format is pinned (16 kHz mono 16-bit PCM) inside the binary so
    // we don't pass anything else.
    return [outFile];
  }
  if (kind === 'ffmpeg') {
    // -nostdin: don't read from our stdin (it'd consume the webview channel
    // on platforms that pipe stdio through). -loglevel error: stay quiet
    // so the extension log isn't full of progress bars. Mic device varies:
    // macOS: avfoundation -i ":0" (default mic, video index :0)
    // linux: alsa -i default
    // windows: dshow -i audio="Microphone" — best-effort; users with a
    // non-English Windows or a renamed device may need to
    // configure this. Document in the friendly error.
    if (process.platform === 'darwin') {
      return [
        '-nostdin', '-loglevel', 'error',
        '-f', 'avfoundation', '-i', ':0',
        '-ar', '16000', '-ac', '1',
        '-y', outFile
      ];
    }
    if (process.platform === 'linux') {
      return [
        '-nostdin', '-loglevel', 'error',
        '-f', 'alsa', '-i', 'default',
        '-ar', '16000', '-ac', '1',
        '-y', outFile
      ];
    }
    // Windows
    return [
      '-nostdin', '-loglevel', 'error',
      '-f', 'dshow', '-i', 'audio=Microphone',
      '-ar', '16000', '-ac', '1',
      '-y', outFile
    ];
  }
  if (kind === 'arecord') {
    // arecord is the alsa-utils default recorder on Linux. -D default
    // picks the user's default ALSA capture device. -f S16_LE -r 16000
    // -c 1 produces 16 kHz mono signed-16-bit-little-endian WAV — same
    // shape ffmpeg writes, so the gateway transcribe path is unchanged.
    return [
      '-D', 'default',
      '-f', 'S16_LE',
      '-r', '16000',
      '-c', '1',
      '-t', 'wav',
      outFile
    ];
  }
  // sox / rec — sox uses `-d` for default audio device on POSIX. On
  // Windows sox is rare and the default device flag is finicky; in
  // practice ffmpeg covers Windows users so this branch is mostly
  // exercised on macOS/Linux.
  return [
    '-d',
    '-r', '16000',
    '-c', '1',
    outFile
  ];
}

/**
 * Begin recording. Returns once the recorder process has been spawned.
 * Throws if a recording is already active or no recorder is installed.
 */
export async function startRecording(): Promise<void> {
  if (active) {throw new Error('A recording is already in progress.');}
  const probe = probeRecorder();
  if (!probe.available || !probe.kind || !probe.binary) {
    throw new Error(probe.message);
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bandit-mic-'));
  const outFile = path.join(tmpDir, 'recording.wav');
  const args = buildRecorderArgs(probe.kind, outFile);
  const proc = cp.spawn(probe.binary, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Hold the close-handler promise so stopRecording() can await it.
  // We resolve with the file bytes once the recorder finishes writing
  // and exits cleanly.
  const completed = new Promise<Buffer>((resolve, reject) => {
    let stderrBuf = '';
    proc.stderr?.on('data', (d: Buffer) => { stderrBuf += d.toString(); });
    proc.on('error', (err) => {
      reject(new Error(`Recorder failed to spawn: ${err.message}`));
    });
    proc.on('close', async (code, signal) => {
      // ffmpeg exits with 255 on SIGINT (the graceful stop signal we
      // send below). sox / arecord / bandit-mic exit 0 on SIGTERM.
      // Treat both as success when stop() initiated the close — the
      // WAV file is written.
      const stopped = active?.stopping ?? false;
      const cleanExit = code === 0 || (stopped && (code === 255 || signal === 'SIGINT' || signal === 'SIGTERM'));
      const stderrTail = stderrBuf.trim();
      // bandit-mic + exit codes that carry a self-explanatory
      // stderr message: 5 = file missing post-stop, 6 = header-only WAV,
      // 7 = TCC permission denied at startup. For these, the binary's
      // stderr IS the user-facing error — wrap it directly instead of
      // prepending the generic "Recorder produced no audio" line.
      if (probe.kind === 'bundled' && typeof code === 'number' && [5, 6, 7].includes(code) && stderrTail) {
        reject(new Error(stderrTail.replace(/^bandit-mic:\s*/gm, '').split('\n').filter(l => l.trim()).join('\n')));
        return;
      }
      if (!cleanExit && !stopped) {
        reject(new Error(`Recorder exited with code ${code}${stderrTail ? `: ${stderrTail}` : ''}`));
        return;
      }
      try {
        const stat = await fs.promises.stat(outFile).catch(() => null);
        if (!stat) {
          // File doesn't exist. Most common cause on macOS: AVAudioRecorder
          // returned true from record() but never received any audio
          // samples (silent TCC denial, or no input device routed to the
          // mic), so the WAV file was never opened. Anything in stderr
          // belongs in the surfaced error so the user has a chance to
          // see what actually went wrong.
          const platformHint = process.platform === 'darwin'
            ? `\nLikely a macOS microphone permission issue. Check System Settings → Privacy & Security → Microphone and ensure ${process.env.TERM_PROGRAM ?? 'your editor'} is allowed. Quit + reopen the editor after granting.`
            : '';
          reject(new Error(
            `Recorder produced no audio file (process exited cleanly but ${path.basename(outFile)} was never written).` +
            (stderrTail ? `\nStderr: ${stderrTail}` : '') +
            platformHint
          ));
          return;
        }
        // 44-byte WAV header with no PCM data = silent recording. Treat
        // as failure too — uploading an empty WAV burns a transcribe
        // request just to get back an empty string.
        if (stat.size <= 64) {
          reject(new Error(
            `Recorder produced an empty WAV (${stat.size} bytes — header only). The microphone wasn't capturing audio. ${stderrTail ? `\nStderr: ${stderrTail}` : ''}`
          ));
          return;
        }
        const buf = await fs.promises.readFile(outFile);
        resolve(buf);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reject(new Error(`${msg}${stderrTail ? `\nStderr: ${stderrTail}` : ''}`));
      } finally {
        // Best-effort cleanup of the tmp dir.
        fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  });

  active = {
    kind: probe.kind,
    proc,
    outFile,
    stopping: false,
    // Filled in by stopRecording when it awaits completion.
    resolve: () => undefined,
    reject: () => undefined
  };
  // Stash the in-flight Promise on the active record so stopRecording
  // can await it without re-creating handlers.
  (active as ActiveRecording & { completed: Promise<Buffer> }).completed = completed;
}

/**
 * Signal the recorder to finish. Returns the recorded WAV bytes.
 * Resolves once the recorder process has exited and the file is
 * fully on disk.
 */
export async function stopRecording(): Promise<Buffer> {
  const current = active;
  if (!current) {throw new Error('No recording in progress.');}
  current.stopping = true;
  // ffmpeg writes a valid WAV header only when it gets SIGINT — SIGTERM
  // truncates the file and the resulting WAV is unreadable. sox,
  // arecord, and our bundled bandit-mic all tolerate SIGTERM and
  // finalize the WAV header on exit (bandit-mic's signal handler calls
  // AVAudioRecorder.stop() which writes the header before exit).
  try {
    if (current.kind === 'ffmpeg') {
      current.proc.kill('SIGINT');
    } else {
      current.proc.kill('SIGTERM');
    }
  } catch {
    /* may already be dead */
  }
  const completed = (current as ActiveRecording & { completed: Promise<Buffer> }).completed;
  try {
    return await completed;
  } finally {
    if (active === current) {active = null;}
  }
}

/**
 * Cancel an in-flight recording without producing audio. Used when the
 * user dismisses the mic UI or the webview goes away mid-recording.
 */
export function cancelRecording(): void {
  if (!active) {return;}
  try { active.proc.kill('SIGKILL'); } catch { /* best effort */ }
  // Don't await the file — we're abandoning this recording. The close
  // handler will tidy up the tmp dir on its own when the process exits.
  active = null;
}

export function isRecording(): boolean {
  return active !== null;
}

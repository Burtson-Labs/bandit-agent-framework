/**
 * Sandbox execution seam — the boundary that lets Bandit run a command inside
 * a hard isolation boundary (a Firecracker microVM) instead of directly on the
 * host filesystem.
 *
 * WHY: Bandit's safety today is BEHAVIORAL — host-kit's decidePermission gates
 * whether a command runs, but if it runs, it runs on your real machine. That's
 * fine with a human at the keyboard; it is NOT fine for the autonomy we now
 * ship (remote control, graph auto-routing) where nobody is watching. A microVM
 * is a HARD boundary: a compromised model output, a prompt-injection, or a bad
 * tool call physically cannot reach the host. This seam is what a caller routes
 * `runCommand` through so that boundary is swappable.
 *
 * The interface is deliberately tiny and backend-agnostic. Today only the local
 * backend exists (no isolation — current behavior). The microVM backend targets
 * the `anton` control plane (Firecracker microVMs on son-of-anton), but anton's
 * current API deploys web apps (Caddy rootfs + bundle→serve) and does NOT yet
 * expose command-exec-with-output — see ANTON_EXEC_CONTRACT below for exactly
 * what it must add. Until then, selecting the anton backend fails loudly rather
 * than silently running on the host.
 */

export interface SandboxExecOptions {
  /** Working directory for the command (inside the sandbox's mounted workspace). */
  cwd?: string;
  /** Hard timeout in ms. A sandbox MUST kill the command at this bound. */
  timeoutMs?: number;
  /** Extra environment for the command. Secrets should NOT be passed here for
   *  untrusted work — that's part of the point of the boundary. */
  env?: Record<string, string>;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the command was killed at timeoutMs. */
  timedOut?: boolean;
}

/**
 * Runs a command somewhere. `local` = the host (no isolation). `microvm` = a
 * one-command-scoped Firecracker VM via anton (hard boundary). Callers depend
 * on this interface, never on a concrete backend, so the boundary is a config
 * switch, not a rewrite.
 */
export interface SandboxExecutor {
  readonly kind: 'local' | 'microvm';
  exec(command: string, opts?: SandboxExecOptions): Promise<SandboxExecResult>;
  /** Release any per-executor resources (VM teardown, etc.). */
  dispose?(): Promise<void>;
}

/**
 * The HTTP contract anton must implement for microVM exec (it doesn't yet).
 * Documented here as the single source of truth for the two-repo work:
 *
 *   POST {antonBaseUrl}/sessions              → { id }                  (create VM)
 *   POST {antonBaseUrl}/sessions/{id}/exec    { command, cwd?, env?, timeoutMs? }
 *                                             → { stdout, stderr, exitCode, timedOut? }
 *   DELETE {antonBaseUrl}/sessions/{id}                                 (teardown)
 *
 * Auth: Burtson JWT (same bearer the CLI/extension already hold). The VM mounts
 * ONLY the workspace, has NO host mount, and NO network egress by default.
 */
export const ANTON_EXEC_CONTRACT = 'POST /sessions/{id}/exec {command,cwd?,env?,timeoutMs?} -> {stdout,stderr,exitCode}';

/** The host backend — no isolation, current behavior. A microVM backend
 *  implements the same interface against anton once its exec endpoint lands. */
export class LocalSandboxExecutor implements SandboxExecutor {
  readonly kind = 'local' as const;

  async exec(command: string, opts: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    const { spawn } = await import('child_process');
    return new Promise<SandboxExecResult>((resolve) => {
      const child = spawn(command, {
        shell: true,
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = opts.timeoutMs
        ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs)
        : null;
      child.stdout?.on('data', (d) => { stdout += d.toString(); });
      child.stderr?.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? (timedOut ? 124 : 1), timedOut });
      });
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr: stderr + String(err), exitCode: 127 });
      });
    });
  }
}

export interface SandboxConfig {
  /** 'local' (default) or 'microvm'. */
  mode?: 'local' | 'microvm';
  /** anton node-agent base URL, required for 'microvm'. */
  antonBaseUrl?: string;
  /** Bearer token for anton (Burtson JWT). */
  token?: string;
}

/**
 * Pick a backend from config. Defaults to local. `microvm` is accepted but the
 * anton backend is not implemented yet, so this throws with a precise reason
 * rather than degrading to local (silent degrade would defeat the safety goal —
 * you'd think you were sandboxed and not be).
 */
export function createSandboxExecutor(
  config: SandboxConfig = {},
  localFactory: () => SandboxExecutor = () => new LocalSandboxExecutor()
): SandboxExecutor {
  const mode = config.mode ?? 'local';
  if (mode === 'local') return localFactory();
  throw new Error(
    `sandbox mode "microvm" is not available yet: anton needs the exec endpoint (${ANTON_EXEC_CONTRACT}). ` +
    `Falling back would run on the host without isolation, so this fails instead. Use mode "local" for now.`
  );
}

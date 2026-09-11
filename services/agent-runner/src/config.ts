/**
 * Runner configuration, resolved once at startup — and the place the
 * fail-closed bind policy lives (SEC-001):
 *
 *  - `AGENT_RUNNER_TOKEN` set   → bearer auth is enforced on every endpoint
 *    except `/healthz`, and the server binds `AGENT_RUNNER_HOST`
 *    (default `0.0.0.0`, the container case).
 *  - `AGENT_RUNNER_TOKEN` unset → development instance: the server binds
 *    loopback ONLY. Asking for a non-loopback host without a token is a
 *    configuration error and the process refuses to start — an
 *    unauthenticated runner must never be reachable off-box by default.
 */

export interface RunnerConfig {
  port: number;
  /** Interface to bind. Loopback unless a token is configured. */
  host: string;
  /** Bearer token required on every non-`/healthz` request.
   *  Unset = loopback-only dev mode. */
  token?: string;
  /** Containment root every `workspacePath` must resolve inside (SEC-002).
   *  Unset = every turn request is rejected with a clear message. */
  workspaceRoot?: string;
  /** Allowlisted provider hosts (SEC-002). Unset = any http(s) host. */
  allowedProviderHosts?: string[];
}

export type RunnerEnv = Record<string, string | undefined>;

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(h) ||
    /^::ffff:127(\.\d{1,3}){3}$/.test(h)
  );
}

export function loadRunnerConfig(env: RunnerEnv = process.env): RunnerConfig {
  const port = Number(env.PORT ?? 8790);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid PORT '${String(env.PORT)}' — expected an integer between 0 and 65535`);
  }

  const token = env.AGENT_RUNNER_TOKEN?.trim() || undefined;
  const requestedHost = env.AGENT_RUNNER_HOST?.trim() || undefined;

  if (!token && requestedHost && !isLoopbackHost(requestedHost)) {
    throw new Error(
      `AGENT_RUNNER_HOST=${requestedHost} is not a loopback address and AGENT_RUNNER_TOKEN is not set. ` +
        'Refusing to expose an unauthenticated runner beyond localhost — set AGENT_RUNNER_TOKEN ' +
        '(and keep an authenticating gateway in front), or bind 127.0.0.1.'
    );
  }

  const host = requestedHost ?? (token ? '0.0.0.0' : '127.0.0.1');

  const workspaceRoot = env.AGENT_RUNNER_WORKSPACE_ROOT?.trim() || undefined;
  const allowedProviderHosts = env.AGENT_RUNNER_ALLOWED_PROVIDER_HOSTS?.trim()
    ? env.AGENT_RUNNER_ALLOWED_PROVIDER_HOSTS.split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
    : undefined;

  return { port, host, token, workspaceRoot, allowedProviderHosts };
}

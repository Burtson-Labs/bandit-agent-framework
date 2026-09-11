/**
 * Request-input policy (SEC-002): the two caller-controlled values that can
 * point the runner somewhere it must not go, constrained at the HTTP
 * boundary — before a turn starts.
 *
 *  - `workspacePath` chooses the jail root the whole turn operates in, so
 *    the caller must NOT get to choose it freely: it has to resolve inside
 *    `AGENT_RUNNER_WORKSPACE_ROOT`, lexically (no `..` escapes) AND after
 *    `realpath` (no symlink escapes). No root configured = no turns; the
 *    runner never falls back to "trust the caller".
 *  - `provider.baseUrl` is a server-side request target (SSRF surface): it
 *    must be http(s), and when `AGENT_RUNNER_ALLOWED_PROVIDER_HOSTS` is set
 *    its host must be on that list.
 */
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { ContractError, type TurnProvider } from './contract.js';

const inside = (p: string, root: string): boolean => p === root || p.startsWith(root + path.sep);

/**
 * Validate a caller-supplied workspace path against the configured root and
 * return its canonical (realpath) form — the jail root the turn will use.
 * Throws `ContractError` on any violation; never silently re-roots.
 */
export function resolveWorkspacePath(requested: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) {
    throw new ContractError(
      'RUNNER_MISCONFIGURED',
      'AGENT_RUNNER_WORKSPACE_ROOT is not set — the runner refuses caller-supplied workspace paths without a configured containment root',
    );
  }
  const root = path.resolve(workspaceRoot);
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    throw new ContractError(
      'RUNNER_MISCONFIGURED',
      `AGENT_RUNNER_WORKSPACE_ROOT does not exist: ${workspaceRoot}`,
    );
  }

  // Lexical containment first — rejects `..` and absolute escapes before
  // touching the filesystem. Both root spellings are accepted because macOS
  // tmpdirs arrive as /var/... for the /private/var/... realpath.
  const requestedAbs = path.resolve(requested);
  if (!inside(requestedAbs, root) && !inside(requestedAbs, rootReal)) {
    throw new ContractError(
      'BAD_REQUEST',
      'workspacePath must resolve inside the configured workspace root',
    );
  }

  // The contract says the workspace is ALREADY prepared, so it must exist —
  // which lets us realpath it and re-check containment, closing the
  // symlink-inside-the-root-pointing-outside escape.
  let real: string;
  try {
    real = realpathSync(requestedAbs);
  } catch {
    throw new ContractError('BAD_REQUEST', `workspacePath does not exist: ${requested}`);
  }
  if (!inside(real, rootReal)) {
    throw new ContractError(
      'BAD_REQUEST',
      'workspacePath resolves (via symlink) outside the configured workspace root',
    );
  }
  return real;
}

/**
 * Validate the provider spec's network target. `deterministic` has none.
 * Allowlist entries match the URL's hostname; an entry containing `:`
 * matches host:port instead (IPv6 hosts keep their brackets, as in
 * `new URL(...).hostname`).
 */
export function validateProvider(provider: TurnProvider, allowedHosts: string[] | undefined): void {
  if (provider.kind === 'deterministic') return;

  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    throw new ContractError('BAD_REQUEST', `provider.baseUrl is not a valid URL: ${provider.baseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ContractError('BAD_REQUEST', `provider.baseUrl must be http(s), got '${url.protocol}'`);
  }
  if (allowedHosts && allowedHosts.length > 0) {
    const hostname = url.hostname.toLowerCase();
    const hostPort = url.host.toLowerCase();
    const ok = allowedHosts.some((entry) => (entry.includes(':') ? entry === hostPort : entry === hostname));
    if (!ok) {
      throw new ContractError(
        'BAD_REQUEST',
        `provider.baseUrl host '${url.host}' is not in AGENT_RUNNER_ALLOWED_PROVIDER_HOSTS`,
      );
    }
  }
}

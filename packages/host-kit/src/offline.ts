/**
 * Offline mode: one switch that leaves the model server you configured as the
 * only host Bandit contacts.
 *
 * Turned on by any of:
 *   - `BANDIT_OFFLINE=1` in the environment;
 *   - `"offline": true` in `~/.bandit/settings.json` or the project's
 *     `.bandit/settings.json` / `.bandit/settings.local.json`;
 *   - `"network": { "offline": true }` in the machine policy file
 *     (`/etc/bandit/policy.json`, `/Library/Application Support/Bandit/policy.json`,
 *     `C:\ProgramData\Bandit\policy.json`). A policy file that exists but cannot
 *     be read or parsed also turns it on, so a broken rollout fails closed.
 *
 * Any one source turns it on; none of the others can turn it off.
 *
 * What each host does with it is the host's job (the CLI and the VS Code
 * extension both: no update check, no models.dev, no web/image/artifact tools,
 * no Bandit Cloud features, network tools refused). The fetch guard below is
 * the backstop: once installed, any `fetch` to a host other than loopback or
 * the configured model server fails at once with a clear message instead of
 * leaving the machine.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isIP } from 'net';
import { isPrivateAddress, normalizeIPv4Numeric } from './tools/ssrfGuard';

export const OFFLINE_ENV = 'BANDIT_OFFLINE';

export type OfflineSource = 'policy' | 'env' | 'settings';

export interface OfflineMode {
  offline: boolean;
  /** Which source turned it on (the strongest one when several did). */
  source?: OfflineSource;
  /** Human-readable origin, for messages: "BANDIT_OFFLINE=1", a file path. */
  detail?: string;
  /** Set when the policy file exists but could not be used (fail closed). */
  policyError?: string;
}

/** The machine policy path the desktop app reads, for this platform. */
export function machinePolicyPath(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env
): string {
  if (platform === 'darwin') return '/Library/Application Support/Bandit/policy.json';
  if (platform === 'win32') return path.win32.join(env.ProgramData || 'C:\\ProgramData', 'Bandit', 'policy.json');
  return '/etc/bandit/policy.json';
}

export function envTurnsOfflineOn(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env[OFFLINE_ENV] ?? '').trim());
}

/**
 * Read `network.offline` from a policy file. Missing file: not offline.
 * Present but unreadable, not JSON, or `network.offline` not a boolean:
 * offline, with the reason (fail closed).
 */
export function readPolicyOffline(file: string): { offline: boolean; error?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { offline: false };
    return { offline: true, error: `could not read ${file}: ${code ?? String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { offline: true, error: `${file} is not valid JSON` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { offline: true, error: `${file} is not a JSON object` };
  }
  const network = (parsed as { network?: unknown }).network;
  if (network === undefined) return { offline: false };
  if (!network || typeof network !== 'object' || Array.isArray(network)) {
    return { offline: true, error: `network in ${file} must be an object` };
  }
  const value = (network as { offline?: unknown }).offline;
  if (value === undefined) return { offline: false };
  if (typeof value !== 'boolean') return { offline: true, error: `network.offline in ${file} must be true or false` };
  return { offline: value };
}

export interface ResolveOfflineInput {
  env?: Record<string, string | undefined>;
  /** `offline` from the merged settings files (loadHookSettings). */
  settingsOffline?: boolean;
  /** Where the settings value came from, for messages. */
  settingsDetail?: string;
  /** Policy file to read. Default: machinePolicyPath(). `null` skips it (tests). */
  policyFile?: string | null;
}

export function resolveOfflineMode(input: ResolveOfflineInput = {}): OfflineMode {
  const env = input.env ?? process.env;
  const policyFile = input.policyFile === undefined ? machinePolicyPath(process.platform, env) : input.policyFile;
  if (policyFile) {
    const policy = readPolicyOffline(policyFile);
    if (policy.offline) {
      return {
        offline: true,
        source: 'policy',
        detail: policy.error ? `${policyFile} (invalid: offline until fixed)` : policyFile,
        ...(policy.error ? { policyError: policy.error } : {})
      };
    }
  }
  if (envTurnsOfflineOn(env)) return { offline: true, source: 'env', detail: `${OFFLINE_ENV}=1` };
  if (input.settingsOffline === true) {
    return { offline: true, source: 'settings', detail: input.settingsDetail ?? '"offline": true in .bandit/settings.json' };
  }
  return { offline: false };
}

/** "Bandit is in offline mode (BANDIT_OFFLINE=1): <what> is turned off." */
export function offlineMessage(mode: OfflineMode, what: string): string {
  const from = mode.detail ? ` (${mode.detail})` : '';
  return `Bandit is in offline mode${from}: ${what} is turned off. Offline mode allows connections only to the model server you configured.`;
}

/** True for loopback names and addresses. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIP(h) === 6) return h === '::1' || /^::ffff:127\./.test(h) || /^::ffff:7f/.test(h);
  const v4 = isIP(h) === 4 ? h : normalizeIPv4Numeric(h);
  return !!v4 && v4.startsWith('127.');
}

/**
 * True when a host is plainly on this machine or the local network without a
 * DNS lookup: loopback, private/link-local literals, `.local`/`.lan`/
 * `.internal`/`.home.arpa` names, and single-label names (`gpu-node`).
 * Used to skip third-party lookups (models.dev) for a self-hosted model server.
 */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (isLoopbackHost(h)) return true;
  if (isIP(h) || normalizeIPv4Numeric(h)) return isPrivateAddress(h);
  if (/\.(local|lan|internal|intranet|home\.arpa|localdomain)$/.test(h)) return true;
  return !h.includes('.');
}

export class OfflineBlockedError extends Error {
  readonly code = 'BANDIT_OFFLINE';
  constructor(message: string) {
    super(message);
    this.name = 'OfflineBlockedError';
  }
}

function urlOf(input: unknown): URL | null {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    if (input && typeof input === 'object' && typeof (input as { url?: unknown }).url === 'string') {
      return new URL((input as { url: string }).url);
    }
  } catch {
    // Relative or malformed: let fetch report it.
  }
  return null;
}

export interface OfflineFetchGuardOptions {
  mode: OfflineMode;
  /** Origins (or full URLs) of the configured model server(s). */
  allowedOrigins: string[];
  /** Called with each refused URL (for a log line). */
  onBlocked?: (url: URL) => void;
}

/**
 * Wrap `globalThis.fetch` so that, in offline mode, a request to any host
 * other than loopback or the configured model server is refused at once.
 * Returns an uninstall function. A no-op when `mode.offline` is false.
 */
export function installOfflineFetchGuard(opts: OfflineFetchGuardOptions): () => void {
  if (!opts.mode.offline || typeof globalThis.fetch !== 'function') return () => undefined;
  const allowed = new Set<string>();
  for (const o of opts.allowedOrigins) {
    try {
      allowed.add(new URL(o).origin);
    } catch {
      // Ignore an unparsable entry.
    }
  }
  const original = globalThis.fetch;
  const guarded = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = urlOf(input);
    if (url && !isLoopbackHost(url.hostname) && !allowed.has(url.origin)) {
      opts.onBlocked?.(url);
      throw new OfflineBlockedError(
        `${offlineMessage(opts.mode, `the connection to ${url.origin}`)}`
      );
    }
    return original(input, init);
  }) as typeof fetch;
  globalThis.fetch = guarded;
  return () => {
    if (globalThis.fetch === guarded) globalThis.fetch = original;
  };
}

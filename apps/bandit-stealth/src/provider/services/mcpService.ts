/**
 * `McpService` owns the session-scoped MCP client pool lifecycle:
 * lazy instantiation behind a trust gate, hydration from disk,
 * reload-on-demand, the sync API key cache for URL-based remote
 * servers, snapshot building for flushState, and pool teardown on
 * extension dispose.
 *
 * Why lazy: spawning an MCP server is unrestricted code execution
 * via `child_process`. We don't construct the pool — or even
 * import its provider — until something actually asks for it. A
 * failure in the pool's module-load path or in
 * `@modelcontextprotocol/sdk`'s runtime resolution degrades the
 * extension to "no MCP" mode (the getter returns a fresh, empty
 * pool) instead of blocking activation.
 *
 * Trust gate: first-spawn of an unapproved server config opens a
 * VS Code modal. "Always allow" persists the fingerprint to
 * `~/.bandit/mcp-trust.json` so the next session doesn't re-prompt.
 *
 * Pre-extraction (≤ v1.7.349) this was one ~80-line lazy getter +
 * three fields + two methods on the provider. Pulling it out keeps
 * the trust-gate prompt + auth resolution + hydration in one place
 * with a tight interface (`pool`, `ensureHydrated`, `reloadFromDisk`,
 * `setBanditApiKey`, `buildSnapshot`, `dispose`).
 */
import * as vscode from 'vscode';
import {
  McpClientPool,
  fingerprintServerConfig
} from '@burtson-labs/agent-core';
import {
  approveMcpFingerprint,
  loadApprovedMcpFingerprints,
  registerMcpServersFromDisk
} from '@burtson-labs/host-kit';
import { buildMcpSnapshot } from '../../helpers/mcpLifecycle';
import type { ProviderContext } from '../context';

export class McpService {
  private instance: McpClientPool | null = null;
  private hydrated = false;
  private failed = false;
  /** Pre-resolved Bandit Cloud API key for URL-based remote MCP
   *  servers. Memory-local so the pool's synchronous
   *  `resolveAuthToken` callback can return it without an async
   *  SecretStorage round-trip per request. Refreshed from
   *  `flushState` when the slow-state cache repopulates. */
  private cachedBanditApiKey: string | undefined;

  constructor(private readonly ctx: ProviderContext) {
    void this.ctx;
  }

  /**
   * Lazily-instantiated pool. First access constructs the real pool
   * behind the trust gate; the `getMcpPool() failed` path returns
   * fresh empty pools so callers behave as if MCP wasn't configured
   * (no register, no snapshot, no agent tools surfaced).
   */
  get pool(): McpClientPool {
    if (this.instance) {return this.instance;}
    if (this.failed) {
      return new McpClientPool();
    }
    try {
      this.instance = new McpClientPool({
        resolveAuthToken: (kind) => {
          if (kind !== 'bandit-api-key') {return undefined;}
          // SecretStorage reads are async but the pool's resolver
          // callback is sync. The cache is filled by `setBanditApiKey`
          // from flushState. When no key is stored we return undefined
          // and the pool connects without auth — the server will
          // 401 and the error surfaces normally.
          return this.cachedBanditApiKey ?? undefined;
        },
        trustGate: async (params) => {
          try {
            // URL-based remote MCP gets a different prompt shape than
            // stdio (which still has the spawn-a-process warning).
            const fingerprint = params.kind === 'url'
              ? fingerprintServerConfig(params.name, {
                  url: params.url,
                  auth: params.authKind === 'bandit-api-key' ? 'bandit' : undefined
                })
              : fingerprintServerConfig(params.name, {
                  command: params.command,
                  args: params.args,
                  env: Object.fromEntries(params.envKeys.map((k: string) => [k, '']))
                });
            const approved = await loadApprovedMcpFingerprints().catch(() => new Set<string>());
            if (approved.has(fingerprint)) {return true;}
            const detail = params.kind === 'url'
              ? [
                  `Server: ${params.name}`,
                  `URL: ${params.url}`,
                  `Auth: ${params.authKind}`
                ].join('\n')
              : [
                  `Server: ${params.name}`,
                  `Command: ${params.command}${params.args.length ? ' ' + params.args.join(' ') : ''}`,
                  params.envKeys.length ? `Env keys: ${params.envKeys.join(', ')}` : ''
                ].filter(Boolean).join('\n');
            const banner = params.kind === 'url'
              ? 'Bandit is about to open a Streamable HTTP connection to a remote MCP server.'
              : 'Bandit is about to spawn an MCP server. This runs arbitrary code on your machine.';
            const choice = await vscode.window.showWarningMessage(
              `${banner}\n\n${detail}\n\nAllow?`,
              { modal: true },
              'Allow once',
              'Always allow'
            );
            if (choice === 'Always allow') {
              await approveMcpFingerprint(fingerprint).catch(() => { /* best effort */ });
              return true;
            }
            return choice === 'Allow once';
          } catch (err) {
            console.warn('[bandit][mcp] trust gate failed', err);
            return false;
          }
        }
      });
    } catch (err) {
      console.warn('[bandit][mcp] pool init failed; MCP disabled for this session', err);
      this.failed = true;
      this.instance = null;
      return new McpClientPool();
    }
    return this.instance;
  }

  /**
   * Pre-cache the Bandit Cloud API key for the synchronous
   * `resolveAuthToken` callback above. Called from `flushState` each
   * time the slow-state cache repopulates with a fresh secret read.
   */
  setBanditApiKey(value: string | undefined): void {
    this.cachedBanditApiKey = value;
  }

  /**
   * Read every workspace's `.bandit/mcp-servers.json` and register
   * the declared servers into the pool. Called once at the first
   * turn of a session (lazy — agents that don't use tools don't pay
   * the file-system probe cost) and on every `reloadFromDisk`.
   *
   * Defensive: `registerMcpServersFromDisk` swallows per-file
   * errors itself, so reaching the catch here means something
   * deeper went wrong. We leave `hydrated = true` so we don't
   * retry every turn — the user can re-trigger via the
   * Connections "Reload" action.
   */
  async ensureHydrated(workspaceRoot: string): Promise<void> {
    if (this.hydrated) {return;}
    this.hydrated = true;
    try {
      await registerMcpServersFromDisk(workspaceRoot, this.pool);
    } catch (err) {
      console.warn('[mcp] hydrate failed', err);
    }
  }

  /**
   * Re-read the mcp-servers.json files from disk. Used by the
   * Connections "Reload" action and the CLI's `/mcp reload` analog.
   * Returns the count of servers registered after the reload.
   */
  async reloadFromDisk(workspaceRoot: string): Promise<number> {
    this.hydrated = false;
    await this.ensureHydrated(workspaceRoot);
    return this.pool.list().length;
  }

  /** Build the snapshot the slow-state cache holds for flushState.
   *  Convenience wrapper that keeps the `buildMcpSnapshot` import
   *  out of the provider. */
  async buildSnapshot(): Promise<Awaited<ReturnType<typeof buildMcpSnapshot>>> {
    return buildMcpSnapshot(this.pool);
  }

  /** Tear down the pool on extension dispose. No-op if MCP was
   *  never initialized this session. */
  dispose(): void {
    if (this.instance) {
      void this.instance.dispose().catch(() => { /* ignore */ });
    }
  }
}

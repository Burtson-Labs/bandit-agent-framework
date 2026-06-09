/**
 * MCP lifecycle handlers (reload, reconnect, disconnect, set
 * activation, revoke trust) extracted from extension.ts.
 *
 * Why: extension.ts crossed 9k lines and bandit's self-evaluation
 * flagged it as monolithic. These five handlers all share the same
 * shape — read or mutate the live pool, persist a side effect, post
 * a notification, sync state — and were each 5-15 lines of inline
 * `if (message.type === 'mcpX')` branches in the message dispatcher.
 * Pulling them out as standalone functions keeps the dispatcher
 * skinny and lets the handlers be unit-tested in isolation.
 *
 * The four "add server" wizards live next door in
 * `helpers/mcpWizards.ts`; the split keeps wizard / lifecycle
 * concerns separate (different dependencies, different test surface).
 */
import type { McpClientPool } from '@burtson-labs/agent-core';
import { fingerprintServerConfig, inferProviderHint } from '@burtson-labs/agent-core';
import { loadApprovedMcpFingerprints, persistMcpActivation, revokeMcpFingerprint } from '@burtson-labs/host-kit';
import type { WebviewState } from '../agentTypes';

type McpSnapshotEntry = NonNullable<WebviewState['mcpSnapshot']>[number];

/**
 * Build the MCP snapshot the Connections settings panel renders.
 * Only `command` + `args` are echoed for visibility — `env` values
 * stay in the host process because they hold tokens. Each entry is
 * annotated with a `trusted` boolean so the UI can offer a "Revoke
 * trust" affordance exactly when there's something to revoke. Returns
 * an empty array when the user has no mcp-servers.json configured.
 */
export async function buildMcpSnapshot(mcpPool: McpClientPool): Promise<McpSnapshotEntry[]> {
  const approvedFingerprints = await loadApprovedMcpFingerprints().catch(() => new Set<string>());
  return mcpPool.snapshot().map((s): McpSnapshotEntry => {
    const fingerprint = fingerprintServerConfig(s.name, s.config);
    const trusted = approvedFingerprints.has(fingerprint);
    // URL-based remote servers (v1.7.333+) surface `url` + `authKind`
    // instead of `command` + `args`. The Connections panel switches its
    // rendered shape on which one is set. Both shapes share trusted /
    // activation / providerHint so the rest of the card UI stays
    // common.
    const base: Omit<McpSnapshotEntry, 'state' | 'toolCount' | 'errorMessage'> = s.config.url
      ? {
          name: s.name,
          url: s.config.url,
          authKind: typeof s.config.auth === 'string'
            ? s.config.auth
            : (s.config.auth?.type ?? 'none'),
          args: [],
          trusted,
          activation: (s.config.activation ?? 'always') as 'always' | 'on-mention',
          providerHint: inferProviderHint(s.name)
        }
      : {
          name: s.name,
          command: s.config.command,
          args: s.config.args ?? [],
          trusted,
          activation: (s.config.activation ?? 'always') as 'always' | 'on-mention',
          providerHint: inferProviderHint(s.name)
        };
    if (s.status.state === 'connected') {
      return { ...base, state: 'connected' as const, toolCount: s.status.toolCount };
    }
    if (s.status.state === 'error') {
      return { ...base, state: 'error' as const, errorMessage: s.status.message };
    }
    return { ...base, state: s.status.state };
  });
}

export interface McpLifecycleContext {
  mcpPool: McpClientPool;
  workspaceRoot: string;
  /** Reload mcp-servers.json from disk. Returns the number of servers
   *  registered after the reload (used by `handleMcpReload` for the
   *  "X servers configured" notification). */
  reloadFromDisk(workspaceRoot: string): Promise<number>;
  postMessage(message: { type: 'notification'; message: string }): void;
  /** Re-render the webview state after a pool mutation. */
  syncState(): Promise<void>;
}

export async function handleMcpReload(ctx: McpLifecycleContext): Promise<void> {
  const count = await ctx.reloadFromDisk(ctx.workspaceRoot);
  ctx.postMessage({ type: 'notification', message: `MCP: ${count} server${count === 1 ? '' : 's'} configured.` });
  await ctx.syncState();
}

export async function handleMcpReconnect(ctx: McpLifecycleContext, name: string): Promise<void> {
  const ok = await ctx.mcpPool.reconnect(name);
  ctx.postMessage({
    type: 'notification',
    message: ok ? `MCP: connected "${name}".` : `MCP: could not connect "${name}". Check server logs.`
  });
  await ctx.syncState();
}

/**
 * "Disconnect" by re-registering the server with its existing config.
 * The pool's register() disposes any prior process and resets the
 * entry to idle so the next agent turn re-spawns lazily on demand.
 * Same shape the CLI's `/mcp disconnect` uses — the server is not
 * removed from disk, just released from this session.
 */
export async function handleMcpDisconnect(ctx: McpLifecycleContext, name: string): Promise<void> {
  const snap = ctx.mcpPool.snapshot().find((s) => s.name === name);
  if (snap) {
    ctx.mcpPool.register(name, snap.config);
    ctx.postMessage({
      type: 'notification',
      message: `MCP: disconnected "${name}" (will lazy-reconnect on next use).`
    });
  }
  await ctx.syncState();
}

/**
 * Flip activation mode in the live pool AND persist to disk so the
 * change survives extension reloads. Writes target the WORKSPACE
 * config (.bandit/mcp-servers.json) when one exists, otherwise the
 * global ~/.bandit/mcp-servers.json — same precedence as load.
 * Writes are best-effort: a config edit failure still updates the
 * in-memory pool so the user sees the immediate effect.
 */
export async function handleMcpSetActivation(
  ctx: McpLifecycleContext,
  name: string,
  activation: 'always' | 'on-mention'
): Promise<void> {
  const snap = ctx.mcpPool.snapshot().find((s) => s.name === name);
  if (snap) {
    const updated = { ...snap.config, activation };
    ctx.mcpPool.register(name, updated);
    try {
      await persistMcpActivation(ctx.workspaceRoot, name, activation);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.postMessage({
        type: 'notification',
        message: `MCP: in-memory activation updated, but disk write failed: ${msg}`
      });
    }
  }
  await ctx.syncState();
}

/**
 * Remove the fingerprint from the persisted trust file. The server
 * keeps running this session — the fingerprint just gets re-prompted
 * on the next first-spawn (e.g. after a disconnect → reconnect, or
 * in the next session).
 */
export async function handleMcpRevokeTrust(ctx: McpLifecycleContext, name: string): Promise<void> {
  const snap = ctx.mcpPool.snapshot().find((s) => s.name === name);
  if (snap) {
    const fingerprint = fingerprintServerConfig(snap.name, snap.config);
    try {
      await revokeMcpFingerprint(fingerprint);
      ctx.postMessage({ type: 'notification', message: `MCP: trust revoked for "${name}".` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.postMessage({ type: 'notification', message: `MCP: revoke failed: ${msg}` });
    }
  }
  await ctx.syncState();
}

/**
 * MCP client pool — manages spawn / handshake / lifecycle for N
 * configured MCP servers. Each entry corresponds to one mcp-servers.json
 * stanza. The pool is intentionally small surface:
 *
 *   register(name, config) — store config (no spawn yet)
 *   ensureConnected(name)   — spawn + handshake + cache. Idempotent.
 *   discoverTools(name)     — list tools from a connected server (cached
 *                             after first call until disconnect)
 *   callTool(name, tool, args) — proxy through to server.callTool()
 *   snapshot()              — status view for /mcp and the IDE Connections tab
 *   dispose()               — close every spawned process. Idempotent.
 *
 * Lazy spawn: nothing happens at register-time. The first ensureConnected
 * triggers the actual child_process. Avoids paying spawn cost for servers
 * the user configures but never invokes in this session.
 *
 * Failure isolation: a spawn/handshake error is recorded as the server's
 * status and never thrown to the caller. discoverTools returns [] for
 * failed servers. The agent loop continues with native tools only —
 * one bad server doesn't kill the session.
 */

import * as crypto from 'crypto';
import type { McpServerConfig, McpServerSnapshot, McpServerStatus } from './types';

/**
 * Trust gate. Spawning an MCP server is unconstrained code execution
 * via child_process. The host (CLI / extension) supplies a callback
 * that decides whether a never-seen-before server config is allowed
 * to spawn. Decision is made on `(name, command, args, env-keys)` —
 * env VALUES are intentionally NOT part of the fingerprint so a token
 * rotation doesn't re-trigger the prompt.
 *
 * Returning `true` allows the spawn for this session. Persisting the
 * "always allow" decision to disk is the host's responsibility — the
 * pool only sees the boolean answer.
 *
 * When no gate is wired (default), every config is allowed — backwards
 * compatible with hosts that don't yet implement trust prompts.
 */
/**
 * Trust gate input — one shape for stdio servers (existing) and one for
 * URL-based remote servers (v1.7.333+). The discriminator is the
 * `kind` field so existing handlers that destructure
 * `{name, command, args, envKeys}` keep working on stdio entries — they
 * just need to check `kind === 'url'` and surface a URL-shaped prompt
 * when one arrives.
 */
export type McpTrustGate = (params:
  | {
      kind: 'stdio';
      name: string;
      command: string;
      args: string[];
      envKeys: string[];
    }
  | {
      kind: 'url';
      name: string;
      url: string;
      /** Short label for the auth strategy, e.g. "bandit-api-key" / "bearer" /
       *  "header(X-Foo)" / "none". The gate decides whether to show / how to
       *  phrase the auth in the trust prompt. */
      authKind: string;
    }
) => Promise<boolean>;

/**
 * Stable fingerprint of a server config. Used by hosts to remember
 * "the user already approved this exact shape" across sessions.
 * env VALUES are excluded — only env KEYS count — so rotating a token
 * doesn't re-trigger the trust prompt.
 */
export function fingerprintServerConfig(name: string, config: McpServerConfig): string {
  // URL-based remote servers fingerprint on (name, url, authKind). The
  // token VALUE isn't mixed in so rotating a bearer or the Bandit API
  // key doesn't re-trigger the trust prompt — same shape rule as the
  // stdio envKeys-not-envValues policy.
  if (config.url) {
    const payload = {
      name,
      kind: 'url' as const,
      url: config.url,
      authKind: describeAuth(config.auth)
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
  }
  const payload = {
    name,
    kind: 'stdio' as const,
    command: config.command ?? '',
    args: config.args ?? [],
    envKeys: Object.keys(config.env ?? {}).sort()
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

// SDK imports are deferred to spawn time (see loadMcpSdk below) so a
// dependency-resolution failure inside @modelcontextprotocol/sdk never
// runs at module-load time. This matters for VS Code extensions: the
// installed VSIX's node_modules can have broken transitive symlinks
// (pnpm's symlinked layout doesn't always survive packaging), and a
// failing require at module top would block extension activation
// entirely. Deferring means a misconfigured SDK only takes down MCP
// itself — the rest of the extension keeps working.

// Cached references to the SDK's classes after the first successful
// load. Reused on subsequent spawns so we don't pay the require cost
// repeatedly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedClient: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedStdioTransport: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedHttpTransport: any = null;

function loadMcpSdk(): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Client: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  StdioClientTransport: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  StreamableHTTPClientTransport: any;
} {
  if (!cachedClient) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const clientMod = require('@modelcontextprotocol/sdk/client/index.js');
    cachedClient = clientMod.Client;
  }
  if (!cachedStdioTransport) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const stdioMod = require('@modelcontextprotocol/sdk/client/stdio.js');
    cachedStdioTransport = stdioMod.StdioClientTransport;
  }
  if (!cachedHttpTransport) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const httpMod = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    cachedHttpTransport = httpMod.StreamableHTTPClientTransport;
  }
  return {
    Client: cachedClient,
    StdioClientTransport: cachedStdioTransport,
    StreamableHTTPClientTransport: cachedHttpTransport
  };
}

/**
 * Short label describing the auth strategy for trust-gate display +
 * fingerprinting. Stable across a config's lifetime — env values aren't
 * mixed in so rotating a bearer token doesn't re-trigger the trust
 * prompt (mirrors the stdio fingerprint's "envKeys not envValues" rule).
 */
function describeAuth(auth: McpServerConfig['auth']): string {
  if (!auth) {return 'none';}
  if (auth === 'bandit') {return 'bandit-api-key';}
  if (auth.type === 'bandit-api-key') {return 'bandit-api-key';}
  if (auth.type === 'bearer') {return 'bearer';}
  if (auth.type === 'header') {return `header(${auth.name})`;}
  return 'unknown';
}

/** Tool definition as advertised by an MCP server's listTools response.
 *  Exposed so hosts that persist the tool list (see McpClientPoolOptions.
 *  onToolsDiscovered) can round-trip the right shape into
 *  `primeDiscoveryCache` on the next session. */
export interface RemoteToolDef {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

interface ServerEntry {
  config: McpServerConfig;
  status: McpServerStatus;
  // SDK Client and Transport instances are kept any-typed so a future
  // SDK major bump doesn't ripple through every call site. The only
  // surfaces we hit (connect, callTool, listTools, close) are stable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transport?: any;
  /** Cached tools from listTools(). Cleared on disconnect. */
  cachedTools?: RemoteToolDef[];
  /** Set during connect to coalesce concurrent ensureConnected() calls. */
  pendingConnect?: Promise<void>;
}

/** Fired once after the pool successfully fetches a server's tool list
 *  from a live spawn — so the host can persist the result and prime
 *  future sessions without paying the spawn cost just to enumerate. */
export type McpToolsDiscoveredCallback = (
  name: string,
  fingerprint: string,
  tools: RemoteToolDef[]
) => void;

export interface McpClientPoolOptions {
  /** Optional trust gate — see McpTrustGate. When omitted, every
   *  server config is allowed to spawn (current behavior). When
   *  provided, the gate is consulted before each first-spawn and the
   *  spawn is rejected with a "trust_denied" status if the gate
   *  returns false. */
  trustGate?: McpTrustGate;
  /** Optional disk-cache hook. Fired once per (name, fingerprint) after
   *  the first successful listTools — hosts persist the result here so
   *  subsequent sessions can `primeDiscoveryCache` and skip the
   *  enumeration spawn entirely (which is what fires the trust gate
   *  even on prompts that never use any MCP tool). */
  onToolsDiscovered?: McpToolsDiscoveredCallback;
  /** Resolve an opaque auth token by kind, for URL-based remote MCP
   *  servers (v1.7.333+). Today only `'bandit-api-key'` is asked for —
   *  the host should return the configured Bandit Cloud API key (env
   *  BANDIT_API_KEY → ~/.bandit/config.json `bandit.apiKey`). Returns
   *  undefined when no key is configured; the pool then connects to
   *  the server without an Authorization header and surfaces whatever
   *  401/403 the server returns. Future kinds (`oauth-bandit`, etc.)
   *  slot in here without a breaking change. */
  resolveAuthToken?: (kind: string) => string | undefined;
}

/**
 * Pool managing the lifetime of every configured MCP server.
 * Single instance per Bandit session (extension or CLI process).
 */
export class McpClientPool {
  private readonly entries = new Map<string, ServerEntry>();
  private readonly trustGate?: McpTrustGate;
  private readonly trustedFingerprints = new Set<string>();
  private readonly onToolsDiscovered?: McpToolsDiscoveredCallback;
  private readonly resolveAuthToken?: (kind: string) => string | undefined;

  constructor(options: McpClientPoolOptions = {}) {
    this.trustGate = options.trustGate;
    this.onToolsDiscovered = options.onToolsDiscovered;
    this.resolveAuthToken = options.resolveAuthToken;
  }

  /** Pre-populate the in-memory tool cache for a named server from a
   *  prior session's disk cache, keyed by config fingerprint. When the
   *  fingerprint matches the currently-registered server's config,
   *  `discoverTools(name)` short-circuits to these tools WITHOUT
   *  spawning — which is the whole point: no spawn means no trust-gate
   *  prompt on prompts that never use MCP. When the fingerprint doesn't
   *  match, the prime is silently dropped (config changed; we have to
   *  re-spawn to learn the new tool list). */
  primeDiscoveryCache(name: string, fingerprint: string, tools: RemoteToolDef[]): void {
    const entry = this.entries.get(name);
    if (!entry) {return;}
    const current = fingerprintServerConfig(name, entry.config);
    if (current !== fingerprint) {return;}
    entry.cachedTools = tools;
    // Status stays `idle` — we haven't actually spawned the server.
    // The cache exists purely so the enumeration path can answer
    // "what tools does this server expose?" without a child process.
  }

  /** Mark a server fingerprint as trusted for this session — bypasses
   *  the gate on subsequent spawns. Hosts call this after the user
   *  approves "always allow" so re-prompting doesn't happen mid-session. */
  trustFingerprint(fingerprint: string): void {
    this.trustedFingerprints.add(fingerprint);
  }

  /** Register a server's config without spawning it. Idempotent — a
   *  second register for the same name updates the config and forces a
   *  reconnect on next ensureConnected. */
  register(name: string, config: McpServerConfig): void {
    const existing = this.entries.get(name);
    if (existing) {
      // Config changed — close any open process and treat the entry
      // as fresh. The caller is responsible for re-invoking
      // ensureConnected after the config change if they need it
      // immediately.
      this.disposeOne(name);
    }
    const status: McpServerStatus = config.disabled
      ? { state: 'disabled' }
      : { state: 'idle' };
    this.entries.set(name, { config, status });
  }

  /** Server names currently registered (not necessarily connected). */
  list(): string[] {
    return [...this.entries.keys()];
  }

  /** True when this server has a tool list cached in memory — either
   *  from a prior live `discoverTools` this session or from
   *  `primeDiscoveryCache` on boot. Callers use this to decide whether
   *  enumerating the server would require a spawn (and therefore fire
   *  the trust gate). Returns false for unknown or disabled servers. */
  hasCachedTools(name: string): boolean {
    const entry = this.entries.get(name);
    return Boolean(entry?.cachedTools && entry.cachedTools.length > 0);
  }

  /** Snapshot of every registered server for status views. */
  snapshot(): McpServerSnapshot[] {
    return [...this.entries.entries()].map(([name, entry]) => ({
      name,
      config: entry.config,
      status: entry.status
    }));
  }

  /**
   * Spawn + handshake the named server if it isn't already connected.
   * Returns successfully when the server's `initialize` handshake has
   * completed. Returns false when the server is disabled, missing, or
   * a previous spawn failed and we don't retry on every call.
   */
  async ensureConnected(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry) {return false;}
    if (entry.status.state === 'disabled') {return false;}
    if (entry.status.state === 'connected') {return true;}
    if (entry.pendingConnect) {
      await entry.pendingConnect;
      // Cast widens the narrowed type — entry.status mutates inside the
      // pending promise's catch handler but TypeScript's narrowing
      // doesn't follow that.
      return (entry.status as McpServerStatus).state === 'connected';
    }
    if (entry.status.state === 'error') {
      // Don't auto-retry errored servers — the user has to explicitly
      // reconnect after fixing whatever was wrong (token rotated,
      // server not installed, etc). Saves us from a thundering-herd
      // of failed spawns on every tool invocation.
      return false;
    }
    entry.status = { state: 'connecting' };
    entry.pendingConnect = this.spawnAndHandshake(name, entry).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      entry.status = { state: 'error', message };
    }).finally(() => {
      entry.pendingConnect = undefined;
    });
    await entry.pendingConnect;
    return (entry.status as McpServerStatus).state === 'connected';
  }

  /**
   * Force a reconnect for a previously errored or disconnected server.
   * Used by the `/mcp connect <name>` slash command after the user
   * fixes config / installs the server / sets the right env var.
   */
  async reconnect(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry) {return false;}
    if (entry.status.state === 'connected' || entry.status.state === 'connecting') {
      this.disposeOne(name);
      // Re-create the entry shell after dispose (which removed it).
      this.register(name, entry.config);
    } else if (entry.status.state === 'error') {
      entry.status = { state: 'idle' };
    }
    return this.ensureConnected(name);
  }

  /** Tools advertised by a connected server. Returns [] for unknown,
   *  disabled, errored, or never-connected servers.
   *
   *  Short-circuits to the in-memory cache (populated either by a prior
   *  live listTools or by `primeDiscoveryCache`) without spawning the
   *  child process. The trust gate sits inside `spawnAndHandshake`, so
   *  bypassing the spawn here means the gate doesn't fire just because
   *  the host wanted to enumerate the registry — it now only fires
   *  when the agent actually invokes a tool via `callTool`. */
  async discoverTools(name: string): Promise<RemoteToolDef[]> {
    const entry = this.entries.get(name);
    if (!entry) {return [];}
    // Cache hit: hand back the cached list without spawning.
    if (entry.cachedTools) {return entry.cachedTools;}
    const ok = await this.ensureConnected(name);
    if (!ok) {return [];}
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (entry.client as any).listTools();
      const tools: RemoteToolDef[] = Array.isArray(result?.tools) ? result.tools : [];
      entry.cachedTools = tools;
      entry.status = { state: 'connected', toolCount: tools.length };
      // Notify the host so it can persist this tool list — next session
      // primes from disk and never spawns just to enumerate.
      if (this.onToolsDiscovered) {
        try {
          this.onToolsDiscovered(name, fingerprintServerConfig(name, entry.config), tools);
        } catch {
          // Host cache write must never break the agent loop.
        }
      }
      return tools;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.status = { state: 'error', message };
      return [];
    }
  }

  /**
   * Invoke a tool on a connected server. The pool ensures the server
   * is up before the call. Returns the structured result; throws on
   * RPC error so the caller's try/catch surfaces the failure to the
   * agent's loop with a clear message instead of a silent empty
   * result.
   */
  async callTool(name: string, toolName: string, args: Record<string, unknown>): Promise<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }> {
    const entry = this.entries.get(name);
    if (!entry) {throw new Error(`MCP server "${name}" is not registered.`);}
    const ok = await this.ensureConnected(name);
    if (!ok) {
      const reason = entry.status.state === 'error'
        ? entry.status.message
        : `state=${entry.status.state}`;
      throw new Error(`MCP server "${name}" is not connected (${reason}).`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = entry.client as any;
    return await client.callTool({ name: toolName, arguments: args });
  }

  /** Close every spawned process. Idempotent. */
  async dispose(): Promise<void> {
    for (const name of [...this.entries.keys()]) {
      this.disposeOne(name);
    }
  }

  /** Close one server's process. Removes the entry. Idempotent. */
  private disposeOne(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) {return;}
    try { entry.transport?.close?.(); } catch { /* ignore */ }
    try { entry.client?.close?.(); } catch { /* ignore */ }
    this.entries.delete(name);
  }

  private async spawnAndHandshake(name: string, entry: ServerEntry): Promise<void> {
    // Lazy-load the SDK only when we actually need to spawn. Any
    // dependency-resolution failure inside @modelcontextprotocol/sdk
    // surfaces here as a normal error (caught by the pool's status-
    // tracking wrapper) instead of crashing module load — a hard
    // requirement for the VS Code extension whose host can't tolerate
    // a throw at top-level require time.
    const { Client, StdioClientTransport, StreamableHTTPClientTransport } = loadMcpSdk();

    // URL-based remote server — Streamable HTTP transport. This is the
    // path Bandit Cloud-hosted MCP servers (mcp.burtson.ai and friends)
    // use; the SDK speaks the JSON-RPC-over-HTTP envelope and we just
    // attach the right auth header so the server can identify the user.
    if (entry.config.url) {
      if (this.trustGate) {
        const fingerprint = fingerprintServerConfig(name, entry.config);
        if (!this.trustedFingerprints.has(fingerprint)) {
          const allowed = await this.trustGate({
            kind: 'url',
            name,
            url: entry.config.url,
            authKind: describeAuth(entry.config.auth)
          });
          if (!allowed) {
            throw new Error(
              `Trust denied: connecting to remote MCP "${entry.config.url}" requires user approval. Approve in the Connections panel (extension) or via /mcp trust ${name} (CLI).`
            );
          }
          this.trustedFingerprints.add(fingerprint);
        }
      }
      const headers = this.buildAuthHeaders(entry.config.auth);
      const transport = new StreamableHTTPClientTransport(
        new URL(entry.config.url),
        { requestInit: { headers } }
      );
      const client = new Client(
        { name: 'bandit', version: '1.0.0' },
        { capabilities: {} }
      );
      await client.connect(transport);
      entry.client = client;
      entry.transport = transport;
      entry.status = { state: 'connected', toolCount: 0 };
      return;
    }

    // Stdio path — original behavior, unchanged.
    if (this.trustGate) {
      const fingerprint = fingerprintServerConfig(name, entry.config);
      if (!this.trustedFingerprints.has(fingerprint)) {
        const allowed = await this.trustGate({
          kind: 'stdio',
          name,
          command: entry.config.command ?? '',
          args: entry.config.args ?? [],
          envKeys: Object.keys(entry.config.env ?? {})
        });
        if (!allowed) {
          throw new Error(
            `Trust denied: spawning "${entry.config.command} ${(entry.config.args ?? []).join(' ')}" requires user approval. Approve in the Connections panel (extension) or via /mcp trust ${name} (CLI).`
          );
        }
        this.trustedFingerprints.add(fingerprint);
      }
    }
    if (!entry.config.command) {
      throw new Error(`MCP server "${name}" config is missing both \`command\` (stdio) and \`url\` (remote) — one of the two is required.`);
    }
    const transport = new StdioClientTransport({
      command: entry.config.command,
      args: entry.config.args ?? [],
      env: entry.config.env ?? undefined,
      // pipe stderr so a misbehaving server doesn't dump bytes into
      // the user's terminal — surfaces only when we explicitly read it.
      stderr: 'pipe'
    });
    const client = new Client(
      { name: 'bandit', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    entry.client = client;
    entry.transport = transport;
    entry.status = { state: 'connected', toolCount: 0 };
  }

  /**
   * Build the HTTP headers for a remote MCP request based on the server's
   * auth config. `bandit-api-key` resolves through the host-provided
   * resolveAuthToken callback (env BANDIT_API_KEY → ~/.bandit/config.json
   * `bandit.apiKey`). Returns an empty object when no auth is configured
   * — the server will respond 401 if it needs auth, which surfaces as a
   * normal MCP error the user can act on.
   */
  private buildAuthHeaders(auth: McpServerConfig['auth']): Record<string, string> {
    if (!auth) {return {};}
    const normalized = typeof auth === 'string' ? { type: 'bandit-api-key' as const } : auth;
    if (normalized.type === 'bandit-api-key') {
      const token = this.resolveAuthToken?.('bandit-api-key');
      if (!token) {return {};}
      // mcp.burtson.ai accepts both `X-API-Key: <key>` and
      // `Authorization: Bearer <jwt>`. We send X-API-Key because the
      // Bandit Cloud key is a raw API key, not a JWT.
      return { 'X-API-Key': token };
    }
    if (normalized.type === 'bearer') {
      return { Authorization: `Bearer ${normalized.token}` };
    }
    if (normalized.type === 'header') {
      return { [normalized.name]: normalized.value };
    }
    return {};
  }
}

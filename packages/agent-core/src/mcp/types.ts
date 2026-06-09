/**
 * MCP — Model Context Protocol — types.
 *
 * Bandit speaks MCP as a CLIENT. Each configured server runs as a
 * separate child process; we open a JSON-RPC channel over stdio,
 * enumerate the server's tools, and register them in the existing
 * AgentTool registry with namespaced names (`<server>.<tool>`).
 *
 * Config shape uses the standard MCP `mcpServers` schema so users can
 * port a working config to / from other MCP-speaking clients without
 * rewriting it.
 */

/**
 * Auth strategy for remote (URL-based) MCP servers. Stdio servers don't
 * use this — they're trusted via fingerprint + the trust gate.
 *
 * - `'bandit'` (string shorthand) → equivalent to `{ type: 'bandit-api-key' }`,
 *   resolves to the host's configured Bandit Cloud API key at request time.
 *   Sent as `X-API-Key: <key>`.
 * - `{ type: 'bandit-api-key' }` → explicit form of the above.
 * - `{ type: 'bearer'; token: '...' }` → static bearer token. Sent as
 *   `Authorization: Bearer <token>`.
 * - `{ type: 'header'; name: 'X-Foo'; value: '...' }` → arbitrary custom
 *   header. Use for connectors with bespoke auth headers.
 *
 * The pool resolves a string token from the host via
 * McpClientPoolOptions.resolveAuthToken when the type is bandit-api-key.
 */
export type McpAuthConfig =
  | 'bandit'
  | { type: 'bandit-api-key' }
  | { type: 'bearer'; token: string }
  | { type: 'header'; name: string; value: string };

/**
 * One server entry in the user's mcp-servers.json. Matches the standard
 * MCP config schema for stdio servers AND the emerging Streamable HTTP
 * remote-server shape for URL-based servers. An entry is one OR the
 * other — `command` and `url` are mutually exclusive. `url` wins when
 * both are set.
 */
export interface McpServerConfig {
  /** Stdio mode: executable name or absolute path. e.g. "npx", "node",
   *  "/usr/local/bin/mcp-server". Mutually exclusive with `url`. */
  command?: string;
  /** Stdio mode arguments. */
  args?: string[];
  /** Stdio mode environment variables merged into the child process. NOT logged. */
  env?: Record<string, string>;

  /** Remote mode: full URL of the MCP endpoint (Streamable HTTP), e.g.
   *  `https://mcp.burtson.ai/mcp`. When set, this entry uses the remote
   *  transport — command/args/env are ignored. The Bandit MCP client
   *  speaks Streamable HTTP via @modelcontextprotocol/sdk's
   *  StreamableHTTPClientTransport. */
  url?: string;
  /** Auth for the remote URL — see McpAuthConfig. Omit for public URLs.
   *  Most user-facing entries will be `auth: 'bandit'` (Bandit Cloud key)
   *  since that's how `mcp.burtson.ai` and similar hosted servers
   *  authenticate. */
  auth?: McpAuthConfig;
  /**
   * Optional disable flag — set to true to keep the server in the
   * config (so the user doesn't lose their tokens) without spawning
   * it. Mirrors the standard MCP `disabled` field.
   */
  disabled?: boolean;
  /**
   * Activation mode. Defaults to "always" (current behavior — every
   * configured server's tools are registered every turn). When set
   * to "on-mention", the server's tools are only registered when
   * the user's prompt mentions one of the server's triggers (the
   * server name itself + any explicit `triggers` + auto-derived
   * triggers for well-known providers like slack/github/gmail/etc).
   *
   * Use "on-mention" to keep the system prompt small when you have
   * many servers configured. A user with 10 servers using "always"
   * pays for 60+ tool definitions in every prompt; "on-mention"
   * lets you summon Slack tools by typing "slack" without bloating
   * your code-review prompts.
   */
  activation?: 'always' | 'on-mention';
  /**
   * Extra keywords that activate this server when activation is
   * "on-mention". The server name is always a trigger; explicit
   * triggers stack on top. For well-known servers (slack, github,
   * gmail, drive, calendar, outlook, teams) Bandit auto-supplies
   * sensible defaults so users don't need to think about it.
   */
  triggers?: string[];
}

/**
 * The full mcp-servers.json file. Loaded from `~/.bandit/mcp-servers.json`
 * (global) and `.bandit/mcp-servers.json` (workspace, takes precedence).
 */
export interface McpServersFile {
  mcpServers: Record<string, McpServerConfig>;
}

/** Per-server runtime status. Surfaced in the CLI `/mcp` listing and the IDE Connections tab. */
export type McpServerStatus =
  | { state: 'idle' }                         // configured but not yet spawned (lazy)
  | { state: 'connecting' }                   // spawn requested, handshake in flight
  | { state: 'connected'; toolCount: number } // ready, N tools registered
  | { state: 'error'; message: string }       // spawn or handshake failed; logged once
  | { state: 'disabled' };                    // disabled: true in config

/** Snapshot of one server for status views (CLI and IDE). */
export interface McpServerSnapshot {
  name: string;
  config: McpServerConfig;
  status: McpServerStatus;
}

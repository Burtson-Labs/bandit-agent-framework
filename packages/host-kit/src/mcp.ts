/**
 * MCP — read mcp-servers.json from disk and load it into a pool.
 *
 * Mirrors the loadMemory() pattern: workspace config takes precedence
 * over global, missing files are ignored silently. Either file's
 * presence opts the user into MCP; absence means zero behavior change.
 *
 * Schema is the standard MCP `mcpServers` shape:
 * `{ "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }`.
 * Users porting from another MCP-speaking client can paste the same
 * stanza in. See docs/integration-playlist/mcp-roadmap.md for design rules.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { McpClientPool, McpServerConfig, McpServersFile } from '@burtson-labs/agent-core';

// Resolved lazily (not at module load) so a stubbed/changed HOME is respected —
// e.g. tests that point HOME at a temp dir, or a process that rewrites HOME.
const globalMcpPath = () => path.join(os.homedir(), '.bandit', 'mcp-servers.json');
const banditConfigPath = () => path.join(os.homedir(), '.bandit', 'config.json');

/**
 * Pull the user's Burtson Labs API key out of `~/.bandit/config.json`
 * (`bandit.apiKey`). Used by the auto-inject path below — when an MCP
 * server config doesn't already specify `BANDIT_API_KEY` in its env
 * block, we backfill from the user's Bandit cloud config so a single
 * sign-in covers BOTH provider auth and MCP server auth. Solo users
 * almost always want one key everywhere; multi-tenant setups can opt
 * out by explicitly setting `BANDIT_API_KEY` in the env block, which
 * we never override.
 *
 * Returns null when the config file is missing, malformed, or has no
 * `bandit.apiKey` set — the caller then leaves the env block alone
 * and the user falls back to manual `env: { BANDIT_API_KEY }`.
 */
async function resolveBanditApiKey(): Promise<string | null> {
  try {
    const raw = await fs.promises.readFile(banditConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw) as { bandit?: { apiKey?: string } };
    const key = parsed.bandit?.apiKey?.trim();
    return key && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective server config for a workspace by merging
 * `~/.bandit/mcp-servers.json` (global, lower precedence) with
 * `.bandit/mcp-servers.json` (workspace, higher precedence). Workspace
 * entries override global entries with the same name. Returns an
 * empty record when neither file exists or both are unparseable —
 * MCP is opt-in, missing config = no behavior change.
 */
export async function loadMcpServersConfig(cwd: string): Promise<McpServersFile['mcpServers']> {
  const merged: McpServersFile['mcpServers'] = {};
  const candidates = [
    globalMcpPath(),
    path.resolve(cwd, '.bandit', 'mcp-servers.json')
  ];
  for (const file of candidates) {
    try {
      const raw = await fs.promises.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<McpServersFile>;
      if (parsed && typeof parsed === 'object' && parsed.mcpServers) {
        for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
          if (!cfg || typeof cfg !== 'object') continue;
          // An entry is valid when EITHER:
          //   - `command` is a string (stdio transport — original shape), OR
          //   - `url` is a string (Streamable HTTP transport, v1.7.333+).
          // Pre-v1.7.333 the loader only accepted stdio and silently
          // dropped URL-only entries, which surfaced as "no servers
          // configured" even though the file was correctly written.
          const hasStdio = typeof cfg.command === 'string';
          const hasUrl = typeof cfg.url === 'string';
          if (hasStdio || hasUrl) {
            merged[name] = cfg;
          }
        }
      }
    } catch {
      // Missing or invalid — skip silently. MCP is best-effort opt-in.
    }
  }

  // Auto-inject BANDIT_API_KEY into each STDIO server's env block when
  // the user has a Bandit cloud key configured AND the server hasn't
  // already pinned one. URL-based remote servers (v1.7.333+) use the
  // pool's `resolveAuthToken` callback instead of env injection —
  // that auth path is wired by the host (`auth: "bandit"` on the
  // server entry tells the pool to attach `X-API-Key`), so this
  // env-mutation is a no-op for them and we skip it.
  const banditApiKey = await resolveBanditApiKey();
  if (banditApiKey) {
    for (const cfg of Object.values(merged)) {
      // Skip URL entries — they auth via the pool's resolveAuthToken,
      // not via env on a child process that doesn't exist.
      if (typeof cfg.url === 'string') continue;
      const env = cfg.env ?? {};
      if (!env.BANDIT_API_KEY) {
        cfg.env = { ...env, BANDIT_API_KEY: banditApiKey };
      }
    }
  }

  return merged;
}

/**
 * Convenience: load mcp-servers.json (global + workspace) and register
 * every entry with the given pool. Returns the count of servers
 * registered. Lazy spawn — the pool defers actual child_process
 * creation until the first tool invocation per server.
 */
export async function registerMcpServersFromDisk(
  cwd: string,
  pool: McpClientPool
): Promise<number> {
  const servers = await loadMcpServersConfig(cwd);
  let count = 0;
  for (const [name, cfg] of Object.entries(servers)) {
    pool.register(name, cfg);
    count++;
  }
  return count;
}

/** Path to the global mcp-servers.json — exposed so the CLI's `/mcp`
 *  command can echo it back to the user. */
export function globalMcpServersPath(): string {
  return globalMcpPath();
}

/**
 * Append (or replace) a server entry in mcp-servers.json. Used by the
 * connector wizards (GitHub, Slack, etc.) to drop a fully-formed
 * config in without making the user hand-edit JSON. Writes to the
 * workspace file (`.bandit/mcp-servers.json`) when one exists at
 * `cwd`, otherwise the global file at `~/.bandit/mcp-servers.json` —
 * same precedence as load. Re-using an existing name overwrites the
 * old entry (the user is typically rotating a token or replacing a
 * server they already have).
 *
 * Returns the absolute path that was written so callers can echo it
 * to the user. Throws on write failure.
 */
export async function addMcpServerToConfig(
  cwd: string,
  name: string,
  config: McpServerConfig
): Promise<string> {
  const workspacePath = path.resolve(cwd, '.bandit', 'mcp-servers.json');
  // Prefer workspace config when one already exists; otherwise create
  // it so per-project servers (which the user is most likely picking
  // when they hit a wizard from inside a project) live with the project.
  let target = workspacePath;
  let workspaceExists = false;
  try {
    await fs.promises.access(workspacePath);
    workspaceExists = true;
  } catch {
    // No workspace config yet — fall through to creating one if cwd
    // looks like a real workspace, else use the global path.
    workspaceExists = false;
  }
  if (!workspaceExists) {
    // If there's NO workspace config but a global config DOES exist,
    // append to global so the user's existing setup stays in one
    // place. If neither exists, create the workspace one (per-project
    // setup is the common wizard case).
    try {
      await fs.promises.access(globalMcpPath());
      target = globalMcpPath();
    } catch {
      target = workspacePath;
    }
  }

  let file: McpServersFile;
  try {
    const raw = await fs.promises.readFile(target, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<McpServersFile>;
    file = {
      mcpServers: parsed.mcpServers && typeof parsed.mcpServers === 'object'
        ? { ...parsed.mcpServers }
        : {}
    };
  } catch {
    file = { mcpServers: {} };
  }
  file.mcpServers[name] = config;

  const dir = path.dirname(target);
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  await fs.promises.writeFile(target, JSON.stringify(file, null, 2) + '\n', 'utf-8');
  return target;
}

/**
 * Update one server's activation mode on disk. Writes to the
 * workspace config (`.bandit/mcp-servers.json`) when one exists at
 * `cwd`; otherwise updates the global file. Mirrors the load-time
 * precedence so the change lands in the same file the user is most
 * likely to be editing. The rest of the entry's fields are preserved
 * verbatim — we only touch the `activation` field.
 *
 * Returns the absolute path that was written so callers can echo it
 * to the user. Throws on write failure (caller decides whether to
 * surface or swallow).
 */
export async function persistMcpActivation(
  cwd: string,
  serverName: string,
  activation: 'always' | 'on-mention'
): Promise<string> {
  const workspacePath = path.resolve(cwd, '.bandit', 'mcp-servers.json');
  let target = workspacePath;
  try {
    await fs.promises.access(workspacePath);
  } catch {
    // Workspace config doesn't exist — fall through to global.
    target = globalMcpPath();
  }

  let file: McpServersFile;
  try {
    const raw = await fs.promises.readFile(target, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<McpServersFile>;
    file = {
      mcpServers: parsed.mcpServers && typeof parsed.mcpServers === 'object'
        ? { ...parsed.mcpServers }
        : {}
    };
  } catch {
    // Target file missing — initialize a new one. Only happens when
    // the user toggled activation through the UI before ever
    // creating an mcp-servers.json (unlikely; the server has to be
    // registered for the toggle to appear).
    file = { mcpServers: {} };
  }

  const existing = file.mcpServers[serverName];
  if (!existing) {
    throw new Error(`MCP server "${serverName}" not found in ${target}`);
  }
  file.mcpServers[serverName] = { ...existing, activation };

  const dir = path.dirname(target);
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  await fs.promises.writeFile(target, JSON.stringify(file, null, 2) + '\n', 'utf-8');
  return target;
}

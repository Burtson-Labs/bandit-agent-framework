/**
 * MCP tool-list cache — persists each server's discovered tool list
 * keyed by config fingerprint so subsequent Bandit sessions don't have
 * to spawn the server just to enumerate. The agent's per-turn registry
 * build calls `discoverTools` for every registered server; when the
 * cache primes the pool's in-memory copy, that call returns instantly
 * without touching the child process — which is what fires the trust
 * gate even on prompts that never use any MCP tool.
 *
 * Stored at `~/.bandit/mcp-tool-cache.json`. The file is non-sensitive
 * (just tool metadata), so it's written with normal permissions —
 * unlike `mcp-trust.json` which carries a security decision and lives
 * at 0600. If the cache file is missing, corrupted, or stale (config
 * fingerprint no longer matches), the pool falls back to a live spawn
 * + listTools — same path as a fresh install. No correctness risk.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { McpRemoteToolDef } from '@burtson-labs/agent-core';

/**
 * Resolved per-call rather than cached at module load so tests that
 * mutate `process.env.HOME` actually hit the tmp directory they set
 * up — and so a long-running host that's had HOME re-pointed for any
 * reason doesn't go on writing to a stale path.
 */
function cacheFilePath(): string {
  return path.join(os.homedir(), '.bandit', 'mcp-tool-cache.json');
}

interface CacheEntry {
  /** Server name at the time of caching — used for debugging only;
   *  the fingerprint is the authoritative key. */
  name: string;
  /** Config fingerprint that produced these tools. Mismatch on load
   *  means the user changed the config and we have to re-spawn. */
  fingerprint: string;
  /** Tool definitions returned by listTools(). Shape mirrors the MCP
   *  inputSchema we round-trip through `mcpToolToAgentTool`. */
  tools: McpRemoteToolDef[];
  /** ISO timestamp of last refresh — useful for /mcp tools-cache list. */
  updatedAt: string;
}

interface CacheFile {
  version: 1;
  entries: CacheEntry[];
}

async function readCacheFile(): Promise<CacheFile> {
  try {
    const raw = await fs.promises.readFile(cacheFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CacheFile>;
    if (parsed.version === 1 && Array.isArray(parsed.entries)) {
      return {
        version: 1,
        entries: parsed.entries.filter(
          (e): e is CacheEntry =>
            typeof e === 'object' && e !== null &&
            typeof (e as CacheEntry).fingerprint === 'string' &&
            Array.isArray((e as CacheEntry).tools)
        )
      };
    }
  } catch {
    // Missing or malformed — return empty. The pool will re-spawn on
    // first discoverTools and we'll repopulate from there.
  }
  return { version: 1, entries: [] };
}

async function writeCacheFile(file: CacheFile): Promise<void> {
  const dir = path.dirname(cacheFilePath());
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  await fs.promises.writeFile(cacheFilePath(), JSON.stringify(file, null, 2), 'utf-8');
}

/**
 * Load every cached tool list as a Map keyed by fingerprint. Callers
 * iterate registered servers and prime the pool when a fingerprint
 * match exists. Missing-file / malformed-file paths return an empty
 * map silently — Bandit must boot even when the cache is broken.
 */
export async function loadMcpToolCache(): Promise<Map<string, McpRemoteToolDef[]>> {
  const file = await readCacheFile();
  const map = new Map<string, McpRemoteToolDef[]>();
  for (const entry of file.entries) {
    map.set(entry.fingerprint, entry.tools);
  }
  return map;
}

/**
 * Persist one server's tool list. Replaces the entry that shares the
 * same fingerprint; never grows unbounded because fingerprint changes
 * map to fresh entries and the old fingerprint's entry is dropped
 * (covered by `pruneStale` when the host knows the current fingerprints).
 *
 * Failures are swallowed so a write-permission issue on `~/.bandit/`
 * doesn't crash the turn — the pool will just re-discover next session.
 */
export async function saveMcpToolEntry(
  name: string,
  fingerprint: string,
  tools: McpRemoteToolDef[]
): Promise<void> {
  try {
    const file = await readCacheFile();
    const next = file.entries.filter((e) => e.fingerprint !== fingerprint);
    next.push({ name, fingerprint, tools, updatedAt: new Date().toISOString() });
    await writeCacheFile({ version: 1, entries: next });
  } catch {
    // Best-effort cache — agent loop continues regardless.
  }
}

/**
 * Drop cache entries whose fingerprints aren't in the currently-active
 * set. Called on boot after the pool registers every server so stale
 * entries from removed or reconfigured servers don't accumulate.
 */
export async function pruneMcpToolCache(activeFingerprints: Set<string>): Promise<void> {
  try {
    const file = await readCacheFile();
    const kept = file.entries.filter((e) => activeFingerprints.has(e.fingerprint));
    if (kept.length === file.entries.length) return;
    await writeCacheFile({ version: 1, entries: kept });
  } catch {
    // Best-effort cleanup.
  }
}

/** Path to the cache file — exposed for /mcp tools-cache commands. */
export function mcpToolCachePath(): string {
  return cacheFilePath();
}

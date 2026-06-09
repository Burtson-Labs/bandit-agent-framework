/**
 * Disk-backed companion to the in-memory `toolCallDetails` Map.
 *
 * Why: until , tool-call detail (full input/output) lived only
 * in a per-session Map. Reload VS Code and every historical chat card
 * showed "expired" because the Map started empty. The runIds embedded
 * in past chat history's `bandit-tl` cards were random strings whose
 * keys pointed at vanished state. With this store, each detail entry
 * is also written to `.bandit/tool-details/<runId>.json` at capture
 * time, and the click handler falls back to disk when the Map misses.
 * Cards survive reload, fresh sessions, and the in-memory 1000-entry
 * eviction.
 *
 * Constraints:
 * - Writes are fire-and-forget — caller doesn't await them. A tool
 * result must reach the chat panel without disk I/O on the critical
 * path; the store catches its own errors so a write failure can't
 * break the turn.
 * - Reads are awaited (the click handler can wait a few ms for disk).
 * - Eviction policy: bounded by `MAX_DISK_ENTRIES` per workspace. A
 * full sweep runs lazily — on first read after boot — so the
 * happy path stays cheap.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolCallDetail } from './toolDetail';

const STORE_DIR = '.bandit/tool-details';
const MAX_DISK_ENTRIES = 5000;
const EVICTION_BATCH = 500; // delete this many at once when over cap

function storePath(workspaceRoot: string, runId: string): string {
  // Sanitize runId for filesystem safety. The generator uses
  // `${name}-${base36 timestamp}-${4-char rand}` so slashes / dots
  // shouldn't appear, but defend anyway.
  const safe = runId.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(workspaceRoot, STORE_DIR, `${safe}.json`);
}

function storeDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, STORE_DIR);
}

/**
 * Write a single tool-call detail to disk. Fire-and-forget — caller
 * doesn't await. Errors are swallowed so a disk-full / permission
 * problem can't break the chat panel.
 */
export function saveToolDetail(workspaceRoot: string, runId: string, detail: ToolCallDetail): void {
  if (!runId || !workspaceRoot) {return;}
  void (async () => {
    try {
      await fs.promises.mkdir(storeDir(workspaceRoot), { recursive: true });
      await fs.promises.writeFile(
        storePath(workspaceRoot, runId),
        JSON.stringify(detail, null, 0),
        'utf-8'
      );
    } catch {
      // Disk write failed — non-fatal. The in-memory Map still has the
      // detail for the current session; only cross-reload lookups will
      // miss.
    }
  })();
}

/**
 * Look up a tool-call detail on disk. Returns null on any miss
 * (file doesn't exist, parse error, etc.) — caller falls back to the
 * existing "expired" UI.
 */
export async function loadToolDetail(
  workspaceRoot: string,
  runId: string
): Promise<ToolCallDetail | null> {
  if (!runId || !workspaceRoot) {return null;}
  try {
    const raw = await fs.promises.readFile(storePath(workspaceRoot, runId), 'utf-8');
    const parsed = JSON.parse(raw);
    // Light shape check — if a future version changes the schema we
    // don't want to crash the click handler. Return null and the
    // existing "expired" toast covers the gap.
    if (typeof parsed?.tool !== 'string') {return null;}
    if (typeof parsed?.output !== 'string') {return null;}
    return parsed as ToolCallDetail;
  } catch {
    return null;
  }
}

/**
 * Trim the on-disk store to at most `MAX_DISK_ENTRIES`. Called lazily
 * from `loadToolDetail` (gated by an internal once-per-process flag so
 * a click storm doesn't trigger N sweeps). Eviction is FIFO by file
 * mtime — oldest gets the axe. Fire-and-forget; an eviction failure
 * doesn't block the lookup that triggered it.
 */
let evictionScheduled = false;
export function scheduleEvictionOnce(workspaceRoot: string): void {
  if (evictionScheduled) {return;}
  evictionScheduled = true;
  void (async () => {
    try {
      const dir = storeDir(workspaceRoot);
      const entries = await fs.promises.readdir(dir).catch(() => [] as string[]);
      if (entries.length <= MAX_DISK_ENTRIES) {return;}
      const withStat = await Promise.all(
        entries.map(async (name) => {
          try {
            const stat = await fs.promises.stat(path.join(dir, name));
            return { name, mtimeMs: stat.mtimeMs };
          } catch {
            return null;
          }
        })
      );
      const sorted = withStat
        .filter((e): e is { name: string; mtimeMs: number } => e !== null)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      const overflow = sorted.length - (MAX_DISK_ENTRIES - EVICTION_BATCH);
      if (overflow <= 0) {return;}
      const toDelete = sorted.slice(0, overflow);
      await Promise.all(
        toDelete.map((e) =>
          fs.promises.unlink(path.join(dir, e.name)).catch(() => undefined)
        )
      );
    } catch {
      // Best-effort eviction — failures don't matter, the next sweep
      // will retry. Reset the flag after a delay so the next click
      // batch can try again.
      setTimeout(() => { evictionScheduled = false; }, 60_000);
    }
  })();
}

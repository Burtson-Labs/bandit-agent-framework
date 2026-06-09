/**
 * Memory — auto-load workspace-local context files (BANDIT.md / CLAUDE.md)
 * and inline them into the system prompt so the agent follows project rules
 * without being re-told on every turn.
 *
 * ## Deduplication (v0.4)
 *
 * When a repo has more than one of BANDIT.md / CLAUDE.md / AGENTS.md (e.g.
 * a migration-in-progress state), loadMemory will skip files whose content
 * is identical — or whose entire text is already present inside a
 * previously-loaded file — so the model doesn't see duplicated context.
 *
 * ## Consolidation
 *
 * `consolidateMemory(cwd)` merges all found entry files into a single
 * canonical BANDIT.md and makes the others point at it. On macOS/Linux a
 * symlink is preferred; on Windows (or when the symlink attempt fails) it
 * writes an exact copy with a drift warning header.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadMemoryIndex,
  renderMemoryIndexBlock,
  BANDIT_MEMORY_INDEX_FILE,
  type MemoryWarnFn
} from './memoryIndex';

const CANDIDATES = [
  'BANDIT.md',
  'CLAUDE.md',
  'AGENTS.md', // OpenAI Codex / GitHub Copilot convention — load alongside BANDIT.md, don't pick one
  '.bandit/BANDIT.md',
  '.bandit/memory.md'
];
const MAX_BYTES = 32 * 1024;

export interface MemoryBundle {
  /** Combined text ready for injection. Empty string if nothing found. */
  content: string;
  sources: string[];
}

/**
 * loadMemory + topic-memory index, fused into a single bundle the host can
 * inject as the system-prompt memory block. Always-loaded files come
 * first; the index follows under its own source marker so the model
 * knows which entries are full content vs. on-demand topic pointers.
 *
 * Returns sources from BOTH passes when present — callers use this for
 * the `/memory` slash command and boot-status output.
 */
export async function loadCombinedMemory(cwd: string, warn?: MemoryWarnFn): Promise<MemoryBundle> {
  const base = await loadMemory(cwd);
  const index = await loadMemoryIndex(cwd, warn);
  const indexBlock = renderMemoryIndexBlock(index);
  if (!indexBlock) return base;
  const headed = `<!-- source: ${BANDIT_MEMORY_INDEX_FILE} -->\n${indexBlock}`;
  return {
    content: base.content ? `${base.content}\n\n${headed}` : headed,
    sources: index.source ? [...base.sources, BANDIT_MEMORY_INDEX_FILE] : base.sources
  };
}

/**
 * Read and deduplicate memory candidate files.
 *
 * Dedup strategy: after normalising whitespace, if the trimmed content of a
 * candidate is entirely contained within the already-accumulated text (or is
 * byte-identical to a previously loaded file) we skip it. This handles the
 * common case where CLAUDE.md was copied verbatim into BANDIT.md during a
 * migration, or where .bandit/memory.md echoes the root BANDIT.md.
 *
 * We do NOT try to dedupe at the paragraph/section level — that would require
 * NLP and is overkill. The simple containment check catches >90% of real-world
 * cases.
 */
export async function loadMemory(cwd: string): Promise<MemoryBundle> {
  const sections: string[] = [];
  const sources: string[] = [];
  // Accumulated normalised text for containment checks
  const seen: string[] = [];

  for (const rel of CANDIDATES) {
    const abs = path.resolve(cwd, rel);
    try {
      const raw = await fs.promises.readFile(abs);
      if (raw.byteLength === 0) continue;
      const truncated = raw.byteLength > MAX_BYTES;
      const text = raw.subarray(0, MAX_BYTES).toString('utf-8');

      // Dedup: skip if trimmed content is identical to or fully contained
      // within something we've already loaded.
      const normalised = text.trim();
      if (normalised && isDuplicate(normalised, seen)) continue;

      sections.push(`<!-- source: ${rel} -->\n${text}${truncated ? '\n… (truncated)' : ''}`);
      sources.push(rel);
      seen.push(normalised);
    } catch {
      // Not present — that's fine.
    }
  }

  return {
    content: sections.join('\n\n'),
    sources
  };
}

/**
 * Append a single fact to project memory so it survives across sessions.
 *
 * Persists to `BANDIT.md` at the workspace root (creates the file with a
 * minimal frontmatter-free header when it doesn't exist). Bullets are
 * appended under a `## Notes` heading so multiple `/remember` calls
 * accumulate without scattering. CLAUDE.md-only repos still get found
 * by loadMemory, but new facts always land in BANDIT.md to keep one
 * canonical write target.
 *
 * Returns the absolute path written so the caller can echo it back to
 * the user — visibility matters because the user typed "remember X"
 * and needs to see WHERE the fact landed.
 */
export async function appendMemory(cwd: string, fact: string): Promise<string> {
  const trimmed = fact.trim();
  if (!trimmed) throw new Error('appendMemory: fact must be a non-empty string');
  const abs = path.resolve(cwd, 'BANDIT.md');
  let existing = '';
  try {
    existing = await fs.promises.readFile(abs, 'utf-8');
  } catch {
    // File doesn't exist — start with a minimal scaffold so the file is
    // self-explanatory if the user opens it later.
    existing =
      '# Project Memory\n\n' +
      'Auto-loaded by Bandit on every prompt. Add facts the agent should\n' +
      'remember across sessions — preferences, repo locations, conventions,\n' +
      'incident notes. Use `/remember <fact>` to append a bullet under the\n' +
      'Notes heading.\n';
  }
  // First bullet under "## Notes"? Append a new section. Otherwise
  // tack the bullet onto the existing section.
  const NOTES_HEADING = '## Notes';
  const hasSection = existing.includes(`\n${NOTES_HEADING}`) || existing.startsWith(NOTES_HEADING);
  const bullet = `- ${trimmed}`;
  let next: string;
  if (hasSection) {
    // Insert at the end of the file — bullets stay chronological so the
    // most recent context lands at the bottom where it's easiest to see
    // when scrolling.
    next = existing.endsWith('\n') ? `${existing}${bullet}\n` : `${existing}\n${bullet}\n`;
  } else {
    const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    next = `${existing}${sep}${NOTES_HEADING}\n\n${bullet}\n`;
  }
  await fs.promises.writeFile(abs, next, 'utf-8');
  return abs;
}

// ── Consolidation ───────────────────────────────────────────────────────────

export type ConsolidationStrategy = 'symlink-or-copy' | 'copy';

export interface ConsolidationResult {
  /** Absolute path of the canonical file (root BANDIT.md). */
  canonical: string;
  /** Files that were made to point at the canonical (symlinked or copied). */
  redirected: string[];
  /** 'symlink' when the OS supports it, 'copy' as fallback. */
  method: 'symlink' | 'copy';
  /** Files that were already identical/symlinked (skipped). */
  skipped: string[];
}

/**
 * Consolidate multiple memory entry files (BANDIT.md / CLAUDE.md / AGENTS.md)
 * into a single canonical `BANDIT.md`. The canonical file gets the merged
 * content; each other file that previously had unique content becomes a
 * pointer (symlink or copy) to BANDIT.md.
 *
 * ## Symlink vs copy decision
 *
 * - macOS / Linux: the function attempts `fs.symlink(canonical, other)`. If
 *   it succeeds, method === 'symlink'.
 * - Windows (or when symlink creation fails with EPERM / ENOTSUP): falls back
 *   to writing an exact copy of BANDIT.md into the other file, prefixed with a
 *   comment warning that it can drift. method === 'copy'.
 * - Callers can force 'copy' via the `strategy` option to skip the symlink
 *   attempt entirely.
 *
 * **Tradeoff**: symlinks are invisible to tools that `cat` the file, so editors
 * show the canonical content transparently. Copies can drift if BANDIT.md is
 * updated without running consolidateMemory again. There is no perfect answer;
 * symlinks are preferred wherever supported.
 *
 * @param cwd       Workspace root
 * @param strategy  'symlink-or-copy' (default) | 'copy'
 */
export async function consolidateMemory(
  cwd: string,
  strategy: ConsolidationStrategy = 'symlink-or-copy'
): Promise<ConsolidationResult> {
  const ENTRY_FILES = ['BANDIT.md', 'CLAUDE.md', 'AGENTS.md'];
  const canonical = path.resolve(cwd, 'BANDIT.md');

  // Gather unique content from all present files
  const present: Array<{ rel: string; abs: string; content: string }> = [];
  for (const rel of ENTRY_FILES) {
    const abs = path.resolve(cwd, rel);
    try {
      const content = await fs.promises.readFile(abs, 'utf-8');
      if (content.trim()) present.push({ rel, abs, content });
    } catch {
      // Not present
    }
  }

  if (present.length === 0) {
    // Nothing to consolidate — return an empty result
    return { canonical, redirected: [], method: 'copy', skipped: [] };
  }

  // Check if all non-canonical files are already symlinks pointing at canonical
  const canonicalEntry = present.find((f) => f.rel === 'BANDIT.md');

  // Build merged content: deduplicate sections from all sources
  const mergedParts: string[] = [];
  const mergedSeen: string[] = [];

  for (const { rel, content } of present) {
    const normalised = content.trim();
    if (!normalised || isDuplicate(normalised, mergedSeen)) continue;
    mergedParts.push(content.trimEnd());
    mergedSeen.push(normalised);
    if (rel !== 'BANDIT.md') {
      // Add a provenance comment when merging in content from another file
      mergedParts[mergedParts.length - 1] =
        `<!-- merged from ${rel} -->\n${mergedParts[mergedParts.length - 1]}`;
    }
  }

  // If BANDIT.md doesn't exist yet, provide scaffold
  if (!canonicalEntry) {
    mergedParts.unshift('# Project Memory\n');
  }

  const merged = mergedParts.join('\n\n') + '\n';
  await fs.promises.writeFile(canonical, merged, 'utf-8');

  // Redirect other files to the canonical
  const redirected: string[] = [];
  const skipped: string[] = [];
  let method: 'symlink' | 'copy' = 'copy';
  const useSymlink = strategy === 'symlink-or-copy' && !isWindows();

  for (const { rel, abs } of present) {
    if (rel === 'BANDIT.md') continue;

    // Check if already a symlink pointing at canonical
    try {
      const lstat = await fs.promises.lstat(abs);
      if (lstat.isSymbolicLink()) {
        const target = await fs.promises.readlink(abs);
        const resolvedTarget = path.resolve(path.dirname(abs), target);
        if (resolvedTarget === canonical) {
          skipped.push(abs);
          continue;
        }
      }
    } catch {
      // Not a symlink — fall through
    }

    if (useSymlink) {
      try {
        // Remove the old file first, then create symlink
        await fs.promises.unlink(abs);
        // Use a relative symlink so the repo is portable
        const rel_target = path.relative(path.dirname(abs), canonical);
        await fs.promises.symlink(rel_target, abs);
        method = 'symlink';
        redirected.push(abs);
        continue;
      } catch {
        // Symlink failed — fall through to copy
      }
    }

    // Copy: write a copy with a drift-warning header
    const driftWarning =
      `<!-- COPY of BANDIT.md — generated by consolidateMemory.\n` +
      `     This file may drift if BANDIT.md is updated without re-running consolidation.\n` +
      `     On macOS/Linux prefer symlinks (strategy: 'symlink-or-copy'). -->\n\n`;
    const copy = await fs.promises.readFile(canonical, 'utf-8');
    await fs.promises.writeFile(abs, driftWarning + copy, 'utf-8');
    redirected.push(abs);
  }

  return { canonical, redirected, method, skipped };
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Returns true when `candidate` is already represented in `seen`:
 * either as an exact match, or as a substring of an already-loaded block.
 *
 * Normalises runs of whitespace before comparing so minor formatting
 * differences (trailing newlines, blank-line count) don't prevent dedup.
 */
function normaliseWS(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function isDuplicate(candidate: string, seen: string[]): boolean {
  const normCandidate = normaliseWS(candidate);
  for (const s of seen) {
    const normS = normaliseWS(s);
    if (normS === normCandidate || normS.includes(normCandidate)) {
      return true;
    }
  }
  return false;
}

function isWindows(): boolean {
  return os.platform() === 'win32';
}

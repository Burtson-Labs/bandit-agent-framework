/**
 * Lazy-load topic memory.
 *
 * ## Path layout (new — v0.4)
 *
 * Preferred location (new repos / post-migration):
 *   .bandit/memory/MEMORY.md   ← index file
 *   .bandit/memory/<slug>.md   ← topic files
 *
 * Legacy location (back-compat for repos that already have them):
 *   MEMORY.md                  ← index file (root)
 *   memory/<slug>.md           ← topic files (root)
 *
 * Both locations are searched at read time; entries are merged, with
 * `.bandit/memory/` winning on slug collisions. WRITES always go to
 * `.bandit/memory/`.
 *
 * ## Index entry format
 *
 *   - [Topic title](memory/file.md) — one-line hook for relevance matching
 *
 * The hook is what the agent sees and reasons about. Pick hooks that name
 * the situation ("when editing auth code", "when the user mentions X").
 *
 * Note: the link path inside MEMORY.md is ALWAYS written as `memory/file.md`
 * regardless of which physical MEMORY.md is hosting it — the `read_memory`
 * tool resolves the slug against its originating directory.
 */
import * as fs from 'fs';
import * as path from 'path';

export const MAX_INDEX_BYTES = 4 * 1024;
export const MAX_MEMORY_FILE_BYTES = 32 * 1024;

// ── Legacy root paths (back-compat) ────────────────────────────────────────
export const MEMORY_DIR = 'memory';
export const MEMORY_INDEX_FILE = 'MEMORY.md';

// ── Preferred .bandit/memory/ paths ────────────────────────────────────────
export const BANDIT_DIR = '.bandit';
export const BANDIT_MEMORY_DIR = '.bandit/memory';
export const BANDIT_MEMORY_INDEX_FILE = '.bandit/memory/MEMORY.md';

export interface MemoryIndexEntry {
  /** Slug derived from filename (e.g. "auth-conventions"). Used as the `name` arg to read_memory. */
  name: string;
  /** Human label from the markdown link. */
  title: string;
  /** One-line summary after the em-dash. */
  hook: string;
  /** Path relative to the workspace root, e.g. "memory/auth-conventions.md". */
  relPath: string;
  /** Resolved absolute path on disk. */
  absPath: string;
}

export interface MemoryIndex {
  /** The MEMORY.md content (trimmed to MAX_INDEX_BYTES). Empty when the file is missing. */
  indexContent: string;
  /** Parsed entries; dangling links are dropped (with a warning). */
  entries: MemoryIndexEntry[];
  /** Absolute path of MEMORY.md if found, else null. Prefers .bandit/memory/MEMORY.md. */
  source: string | null;
}

// Matches em-dash, en-dash, or double-hyphen as the separator.
// The link path is always `memory/<file>` regardless of which MEMORY.md hosts it.
const ENTRY_RE = /^[-*]\s*\[([^\]]+)\]\(memory\/([^)]+)\)\s*(?:[—–-]+)\s*(.+)$/;

function slugFromFilename(file: string): string {
  return file.replace(/\.md$/i, '');
}

/**
 * Optional warn sink. Defaults to a single-line stderr write so the host
 * sees dangling-link warnings without surfacing them to the model.
 */
export type MemoryWarnFn = (msg: string) => void;

const defaultWarn: MemoryWarnFn = (msg) => {
  process.stderr.write(`[memory-index] ${msg}\n`);
};

/**
 * Render a MEMORY.md index as a system-prompt block. Includes a one-line
 * nudge telling the model to call `read_memory(name=...)` when an entry's
 * hook matches the task. Returns an empty string when the index has no
 * entries so the caller can `if (block) ...` without a null check.
 */
export function renderMemoryIndexBlock(index: MemoryIndex): string {
  if (index.entries.length === 0) return '';
  const lines = index.entries.map(
    (e) => `- [${e.title}](${e.relPath}) — ${e.hook}`
  );
  return [
    '<!-- source: MEMORY.md (index — call read_memory(name="<slug>") to load a topic) -->',
    'These are topic memories — full content is NOT preloaded. Read the hook; if it matches the current task, call `read_memory(name="<slug>")` BEFORE making changes. The slug is the part after `memory/` and before `.md` in the link.',
    '',
    ...lines
  ].join('\n');
}

// ── Internal: parse one MEMORY.md file ─────────────────────────────────────

interface ParsedIndexFile {
  indexContent: string;
  entries: MemoryIndexEntry[];
  source: string;
}

async function parseIndexFile(
  abs: string,
  /** Physical directory that contains the `memory/` subfolder for this index. */
  physicalMemoryDir: string,
  /** Prefix to use in relPath (e.g. "memory" or ".bandit/memory"). */
  relDirPrefix: string,
  warn: MemoryWarnFn
): Promise<ParsedIndexFile | null> {
  let raw: Buffer;
  try {
    raw = await fs.promises.readFile(abs);
  } catch {
    return null;
  }
  if (raw.byteLength === 0) {
    return { indexContent: '', entries: [], source: abs };
  }
  const truncated = raw.byteLength > MAX_INDEX_BYTES;
  const text = raw.subarray(0, MAX_INDEX_BYTES).toString('utf-8');
  const indexContent = truncated
    ? `${text}\n… (truncated — MEMORY.md exceeds ${MAX_INDEX_BYTES} bytes; split topics into smaller files)`
    : text;

  const entries: MemoryIndexEntry[] = [];
  const seenInFile = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = ENTRY_RE.exec(line.trim());
    if (!match) continue;
    const [, title, fileRaw, hookRaw] = match;
    const file = fileRaw.trim();
    if (!file || file.includes('..') || path.isAbsolute(file)) {
      warn(`skipped entry "${title}" — invalid memory/ path "${file}"`);
      continue;
    }
    const relPath = `${relDirPrefix}/${file}`;
    const absPath = path.resolve(physicalMemoryDir, file);
    let exists = false;
    try {
      const stat = await fs.promises.stat(absPath);
      exists = stat.isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      warn(`dangling link: ${relPath} (referenced by MEMORY.md but no such file)`);
      continue;
    }
    const name = slugFromFilename(file);
    if (seenInFile.has(name)) {
      warn(`duplicate slug "${name}" — keeping first occurrence`);
      continue;
    }
    seenInFile.add(name);
    entries.push({ name, title: title.trim(), hook: hookRaw.trim(), relPath, absPath });
  }

  return { indexContent, entries, source: abs };
}

// ── Public: merged loader ───────────────────────────────────────────────────

/**
 * Load the memory index, searching both `.bandit/memory/MEMORY.md` (preferred)
 * and the legacy root `MEMORY.md`. Entries from `.bandit/memory/` win on slug
 * collisions. Returns a merged MemoryIndex.
 */
export async function loadMemoryIndex(cwd: string, warn: MemoryWarnFn = defaultWarn): Promise<MemoryIndex> {
  // 1. Try preferred location: .bandit/memory/MEMORY.md
  const banditIndexAbs = path.resolve(cwd, BANDIT_MEMORY_INDEX_FILE);
  const banditMemDirAbs = path.resolve(cwd, BANDIT_MEMORY_DIR);
  const banditResult = await parseIndexFile(banditIndexAbs, banditMemDirAbs, BANDIT_MEMORY_DIR, warn);

  // 2. Try legacy location: root MEMORY.md / memory/
  const rootIndexAbs = path.resolve(cwd, MEMORY_INDEX_FILE);
  const rootMemDirAbs = path.resolve(cwd, MEMORY_DIR);
  const rootResult = await parseIndexFile(rootIndexAbs, rootMemDirAbs, MEMORY_DIR, warn);

  // Neither found
  if (!banditResult && !rootResult) {
    return { indexContent: '', entries: [], source: null };
  }

  // Merge: preferred (.bandit/memory) wins on slug collision
  const seen = new Set<string>();
  const entries: MemoryIndexEntry[] = [];

  // Add preferred entries first
  if (banditResult) {
    for (const e of banditResult.entries) {
      if (seen.has(e.name)) {
        warn(`duplicate slug "${e.name}" — keeping first occurrence`);
        continue;
      }
      seen.add(e.name);
      entries.push(e);
    }
  }

  // Add legacy root entries (skip slugs already covered by preferred)
  if (rootResult) {
    for (const e of rootResult.entries) {
      if (seen.has(e.name)) {
        // Root has the same slug — silently skip (preferred wins)
        continue;
      }
      seen.add(e.name);
      entries.push(e);
    }
  }

  // indexContent: combine both if both exist; preferred first
  let indexContent = '';
  if (banditResult?.indexContent) {
    indexContent = banditResult.indexContent;
    if (rootResult?.indexContent) {
      indexContent += '\n\n<!-- legacy root MEMORY.md -->\n' + rootResult.indexContent;
    }
  } else if (rootResult?.indexContent) {
    indexContent = rootResult.indexContent;
  }

  // source: preferred if present, else root
  const source = banditResult?.source ?? rootResult?.source ?? null;

  return { indexContent, entries, source };
}

// ── Write helpers ───────────────────────────────────────────────────────────

/**
 * Write a new topic file + update the index. Always writes to `.bandit/memory/`.
 *
 * @param cwd     Workspace root
 * @param slug    Plain slug, e.g. "auth-conventions"
 * @param title   Human label for the index entry
 * @param hook    One-line hook (when is this relevant?)
 * @param body    Full markdown body for the topic file
 * @returns The absolute path of the written topic file
 */
export async function writeMemoryTopic(
  cwd: string,
  slug: string,
  title: string,
  hook: string,
  body: string
): Promise<string> {
  if (!slug || slug.includes('/') || slug.includes('..') || path.isAbsolute(slug)) {
    throw new Error(`writeMemoryTopic: invalid slug "${slug}"`);
  }
  const safeSlug = slug.replace(/\.md$/i, '');
  const memDir = path.resolve(cwd, BANDIT_MEMORY_DIR);
  await fs.promises.mkdir(memDir, { recursive: true });

  const topicPath = path.resolve(memDir, `${safeSlug}.md`);
  await fs.promises.writeFile(topicPath, body, 'utf-8');

  // Update the index
  const indexPath = path.resolve(cwd, BANDIT_MEMORY_INDEX_FILE);
  let existing = '';
  try {
    existing = await fs.promises.readFile(indexPath, 'utf-8');
  } catch {
    existing = '# Memory Index\n\n';
  }
  const newLine = `- [${title}](memory/${safeSlug}.md) — ${hook}`;
  // If slug already in index, replace the line; otherwise append
  const slugPattern = new RegExp(`^[-*]\\s*\\[[^\\]]*\\]\\(memory\\/${safeSlug}\\.md\\).*$`, 'm');
  let next: string;
  if (slugPattern.test(existing)) {
    next = existing.replace(slugPattern, newLine);
  } else {
    next = existing.endsWith('\n') ? `${existing}${newLine}\n` : `${existing}\n${newLine}\n`;
  }
  await fs.promises.writeFile(indexPath, next, 'utf-8');

  return topicPath;
}

// ── Migration ───────────────────────────────────────────────────────────────

/**
 * One-time, idempotent migration: moves root `MEMORY.md` + `memory/` into
 * `.bandit/memory/`. Safe to call on every startup — bails out early if:
 *   - the target `.bandit/memory/MEMORY.md` already exists, OR
 *   - the source root `MEMORY.md` does not exist.
 *
 * Steps:
 *   1. Creates `.bandit/memory/` if needed.
 *   2. Copies each `memory/<slug>.md` to `.bandit/memory/<slug>.md`.
 *   3. Copies (rewrites) `MEMORY.md` to `.bandit/memory/MEMORY.md`.
 *   4. Does NOT delete the originals (safe — caller can clean up if desired).
 *
 * @returns Array of absolute paths written (empty when migration is skipped).
 */
export async function migrateMemoryToBanditDir(cwd: string): Promise<string[]> {
  const targetIndex = path.resolve(cwd, BANDIT_MEMORY_INDEX_FILE);
  // Idempotent: already migrated
  try {
    await fs.promises.access(targetIndex);
    return []; // target exists — skip
  } catch {
    // Target doesn't exist — proceed
  }

  const sourceIndex = path.resolve(cwd, MEMORY_INDEX_FILE);
  try {
    await fs.promises.access(sourceIndex);
  } catch {
    return []; // Source doesn't exist — nothing to migrate
  }

  const targetDir = path.resolve(cwd, BANDIT_MEMORY_DIR);
  await fs.promises.mkdir(targetDir, { recursive: true });

  const written: string[] = [];

  // Copy topic files
  const sourceMemDir = path.resolve(cwd, MEMORY_DIR);
  let topicFiles: string[] = [];
  try {
    const entries = await fs.promises.readdir(sourceMemDir);
    topicFiles = entries.filter((f) => f.toLowerCase().endsWith('.md'));
  } catch {
    // No memory/ dir — fine, just copy the index
  }

  for (const file of topicFiles) {
    const src = path.resolve(sourceMemDir, file);
    const dst = path.resolve(targetDir, file);
    try {
      const content = await fs.promises.readFile(src);
      await fs.promises.writeFile(dst, content);
      written.push(dst);
    } catch {
      // Skip files we can't read
    }
  }

  // Copy the index
  const indexContent = await fs.promises.readFile(sourceIndex);
  await fs.promises.writeFile(targetIndex, indexContent);
  written.push(targetIndex);

  return written;
}

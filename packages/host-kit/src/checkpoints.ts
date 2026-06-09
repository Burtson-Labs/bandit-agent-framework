/**
 * Checkpoint store — snapshots every tool-driven file edit so the user
 * can rewind after the fact. One entry per successful write_file /
 * apply_edit; stores the full `before` text (plus metadata about the
 * edit) under `.bandit/checkpoints/<turnId>/<id>.json`, and maintains
 * a small flat index at `.bandit/checkpoints/index.json` for fast
 * listing without walking the directory.
 *
 * Honest scope:
 *   - Only reverts edits the agent made through write_file / apply_edit / replace_range / apply_patch.
 *     Manual saves the user made between turns are NOT captured.
 *   - Not a replacement for git. Meant for in-session undo when an
 *     edit goes sideways and the user wants the previous state back
 *     without hand-unwinding.
 *
 * Storage format is deliberately simple (plain JSON, one file per
 * checkpoint) so it's inspectable with cat/jq when debugging.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CheckpointEntry {
  /** Short slug id — "chk-<turnSlug>-<seq>". Used for /rewind lookup. */
  id: string;
  /** Turn this checkpoint belongs to (matches the turn-log filename stem). */
  turnId: string;
  /** Epoch ms when the checkpoint was written. */
  timestamp: number;
  /** Which tool produced the edit. */
  tool: 'write_file' | 'apply_edit' | 'replace_range' | 'apply_patch';
  /** Absolute path on disk. */
  path: string;
  /** Workspace-relative path (for display in lists). */
  relPath: string;
  /** Full content of the file BEFORE the edit. Empty string for new files. */
  before: string;
  /** Full content of the file AFTER the edit. Stored so listing can
   *  show +N/−M stats without re-reading the file (which may have
   *  been further edited since). */
  after: string;
  /** True when the edit CREATED the file — rewind should `unlink` rather
   *  than write `before`. */
  isNewFile: boolean;
  /** Iteration index within the turn (1-indexed for display). */
  iteration: number;
  /** Optional short description — first ~80 chars of the change's first
   *  line, for human-readable listing. */
  description?: string;
}

/**
 * Flat index entry. Holds only the fields needed for listing so we
 * don't have to read every checkpoint JSON when the user runs /rewind.
 */
export interface CheckpointIndexEntry {
  id: string;
  turnId: string;
  timestamp: number;
  tool: CheckpointEntry['tool'];
  relPath: string;
  iteration: number;
  description?: string;
  plus: number;
  minus: number;
}

export interface CheckpointStoreOptions {
  /** Workspace root where `.bandit/checkpoints/` lives. */
  workspaceRoot: string;
  /** Optional max number of index entries to keep. Older entries stay
   *  on disk but drop off the index. Default: 200. */
  maxIndexEntries?: number;
}

const INDEX_FILE = 'index.json';
const DEFAULT_MAX_INDEX = 200;

function lineCountDiff(before: string, after: string): { plus: number; minus: number } {
  if (before === after) return { plus: 0, minus: 0 };
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;
  // Bounded LCS — same algorithm the extension uses for diff summaries.
  if (m * n > 40000) {
    // Fallback: approximate as full replacement. Rare in practice.
    return { plus: b.length, minus: a.length };
  }
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  let i = m;
  let j = n;
  let plus = 0;
  let minus = 0;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      i--;
      j--;
    } else if (table[i][j - 1] >= table[i - 1][j]) {
      plus++;
      j--;
    } else {
      minus++;
      i--;
    }
  }
  plus += j;
  minus += i;
  return { plus, minus };
}

function describeEdit(entry: Pick<CheckpointEntry, 'before' | 'after' | 'isNewFile'>): string {
  if (entry.isNewFile) return '(new file)';
  // First non-empty line that differs — a reasonable hint of what the
  // edit did. Guards against blank leading lines throwing the heading.
  const afterLines = entry.after.split('\n');
  const beforeLines = entry.before.split('\n');
  for (let i = 0; i < afterLines.length; i++) {
    if (afterLines[i] !== beforeLines[i]) {
      const raw = (afterLines[i] ?? '').trim();
      if (raw) return raw.length > 80 ? raw.slice(0, 77) + '…' : raw;
    }
  }
  return '(whitespace-only edit)';
}

export class CheckpointStore {
  private readonly workspaceRoot: string;
  private readonly dir: string;
  private readonly maxIndexEntries: number;
  private counter = 0;

  constructor(options: CheckpointStoreOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.dir = path.join(options.workspaceRoot, '.bandit', 'checkpoints');
    this.maxIndexEntries = options.maxIndexEntries ?? DEFAULT_MAX_INDEX;
  }

  /** Create a checkpoint entry, persist it, and update the index. */
  async create(input: {
    turnId: string;
    tool: CheckpointEntry['tool'];
    absolutePath: string;
    before: string;
    after: string;
    iteration: number;
  }): Promise<CheckpointEntry> {
    await fs.promises.mkdir(path.join(this.dir, input.turnId), { recursive: true });
    this.counter++;
    const id = `chk-${input.turnId.split('-').pop() ?? 'x'}-${String(this.counter).padStart(3, '0')}`;
    const relPath = path.relative(this.workspaceRoot, input.absolutePath) || input.absolutePath;
    const isNewFile = input.before.length === 0;
    const entry: CheckpointEntry = {
      id,
      turnId: input.turnId,
      timestamp: Date.now(),
      tool: input.tool,
      path: input.absolutePath,
      relPath,
      before: input.before,
      after: input.after,
      isNewFile,
      iteration: input.iteration,
      description: describeEdit({ before: input.before, after: input.after, isNewFile })
    };
    const entryFile = path.join(this.dir, input.turnId, `${id}.json`);
    await fs.promises.writeFile(entryFile, JSON.stringify(entry, null, 2));
    await this.appendToIndex(entry);
    return entry;
  }

  /** Return the most recent N index entries (newest first). */
  async list(limit = 20): Promise<CheckpointIndexEntry[]> {
    const index = await this.readIndex();
    return index.slice(0, limit);
  }

  /** Load a full checkpoint by id. Returns null when not found. */
  async get(id: string): Promise<CheckpointEntry | null> {
    const index = await this.readIndex();
    const hit = index.find((e) => e.id === id);
    if (!hit) return null;
    const file = path.join(this.dir, hit.turnId, `${id}.json`);
    try {
      const raw = await fs.promises.readFile(file, 'utf-8');
      return JSON.parse(raw) as CheckpointEntry;
    } catch {
      return null;
    }
  }

  /**
   * Restore the file to its pre-edit state. Returns the resolved entry
   * on success, or null when the id wasn't found / couldn't be applied.
   * New-file checkpoints are handled by unlinking the file (the file
   * DIDN'T exist before, so that's the correct reverse operation).
   */
  async rewind(id: string): Promise<CheckpointEntry | null> {
    const entry = await this.get(id);
    if (!entry) return null;
    try {
      if (entry.isNewFile) {
        await fs.promises.unlink(entry.path).catch(() => undefined);
      } else {
        await fs.promises.mkdir(path.dirname(entry.path), { recursive: true });
        await fs.promises.writeFile(entry.path, entry.before);
      }
      return entry;
    } catch {
      return null;
    }
  }

  private async readIndex(): Promise<CheckpointIndexEntry[]> {
    const file = path.join(this.dir, INDEX_FILE);
    try {
      const raw = await fs.promises.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw) as CheckpointIndexEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeIndex(entries: CheckpointIndexEntry[]): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, INDEX_FILE);
    await fs.promises.writeFile(file, JSON.stringify(entries, null, 2));
  }

  private async appendToIndex(entry: CheckpointEntry): Promise<void> {
    const { plus, minus } = lineCountDiff(entry.before, entry.after);
    const indexEntry: CheckpointIndexEntry = {
      id: entry.id,
      turnId: entry.turnId,
      timestamp: entry.timestamp,
      tool: entry.tool,
      relPath: entry.relPath,
      iteration: entry.iteration,
      description: entry.description,
      plus,
      minus
    };
    const current = await this.readIndex();
    current.unshift(indexEntry);
    const trimmed = current.slice(0, this.maxIndexEntries);
    await this.writeIndex(trimmed);
  }
}

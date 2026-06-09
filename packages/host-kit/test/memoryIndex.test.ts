/**
 * Tests for the lazy-load MEMORY.md index parser. Parser correctness
 * matters because the on-demand pattern only works if (a) every valid
 * entry surfaces as a typed entry and (b) dangling links never crash
 * the host or leak unresolved paths into the model's view.
 *
 * v0.4 additions:
 * - .bandit/memory/ as preferred location (back-compat: root memory/ still works)
 * - Writes go to .bandit/memory/ via writeMemoryTopic
 * - migrateMemoryToBanditDir: idempotent one-time migration
 * - Slug collision: .bandit/memory/ wins over root memory/
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadMemoryIndex,
  writeMemoryTopic,
  migrateMemoryToBanditDir,
  MAX_INDEX_BYTES,
  BANDIT_MEMORY_DIR,
  BANDIT_MEMORY_INDEX_FILE
} from '../src/memoryIndex';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-kit-memidx-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Legacy root path (back-compat) ──────────────────────────────────────────

describe('loadMemoryIndex — legacy root memory/', () => {
  it('returns empty index when MEMORY.md is absent', async () => {
    const idx = await loadMemoryIndex(tmpRoot, () => {});
    expect(idx.indexContent).toBe('');
    expect(idx.entries).toEqual([]);
    expect(idx.source).toBeNull();
  });

  it('parses valid entries with em-dash, en-dash, and double-hyphen separators', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'memory'));
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'auth.md'), 'auth body');
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'db.md'), 'db body');
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'mcp.md'), 'mcp body');
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), [
      '# Index',
      '',
      '- [Auth conventions](memory/auth.md) — when editing src/auth/*',
      '- [DB migrations](memory/db.md) – when touching migrations',
      '- [MCP roadmap](memory/mcp.md) -- when adding MCP servers',
      ''
    ].join('\n'));

    const idx = await loadMemoryIndex(tmpRoot, () => {});
    expect(idx.source).toBe(path.resolve(tmpRoot, 'MEMORY.md'));
    expect(idx.entries).toHaveLength(3);
    expect(idx.entries[0]).toMatchObject({
      name: 'auth',
      title: 'Auth conventions',
      hook: 'when editing src/auth/*',
      relPath: 'memory/auth.md'
    });
    expect(idx.entries[1].name).toBe('db');
    expect(idx.entries[2].name).toBe('mcp');
  });

  it('drops dangling links and emits a warning', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'memory'));
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'real.md'), 'present');
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), [
      '- [Real](memory/real.md) — keep me',
      '- [Missing](memory/missing.md) — drop me'
    ].join('\n'));

    const warnings: string[] = [];
    const idx = await loadMemoryIndex(tmpRoot, (m) => warnings.push(m));
    expect(idx.entries.map((e) => e.name)).toEqual(['real']);
    expect(warnings.some((w) => w.includes('memory/missing.md'))).toBe(true);
  });

  it('rejects entries with path traversal in the link target', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'memory'));
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'),
      '- [Escape](memory/../etc/passwd) — should be skipped\n');
    const warnings: string[] = [];
    const idx = await loadMemoryIndex(tmpRoot, (m) => warnings.push(m));
    expect(idx.entries).toEqual([]);
    expect(warnings.some((w) => w.includes('invalid memory/ path'))).toBe(true);
  });

  it('caps indexContent at MAX_INDEX_BYTES and notes the truncation', async () => {
    const huge = '- [X](memory/x.md) — hook ' + 'y'.repeat(MAX_INDEX_BYTES);
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), huge);
    const idx = await loadMemoryIndex(tmpRoot, () => {});
    expect(idx.indexContent.length).toBeLessThan(MAX_INDEX_BYTES + 200);
    expect(idx.indexContent).toMatch(/truncated/);
  });

  it('returns empty entries (with source) for an empty MEMORY.md', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), '');
    const idx = await loadMemoryIndex(tmpRoot, () => {});
    expect(idx.entries).toEqual([]);
    expect(idx.source).toBe(path.resolve(tmpRoot, 'MEMORY.md'));
  });

  it('ignores non-bullet lines, comments, and headings', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'memory'));
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'real.md'), 'real');
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), [
      '# Project memory index',
      '',
      'Narrative paragraph that should not parse as an entry.',
      '',
      '## Section',
      '- [Real](memory/real.md) — when relevant',
      'random tail text'
    ].join('\n'));
    const idx = await loadMemoryIndex(tmpRoot, () => {});
    expect(idx.entries).toHaveLength(1);
    expect(idx.entries[0].name).toBe('real');
  });
});

// ── Preferred .bandit/memory/ path ──────────────────────────────────────────

describe('loadMemoryIndex — .bandit/memory/ (preferred)', () => {
  it('reads index from .bandit/memory/MEMORY.md when present', async () => {
    const banditMemDir = path.join(tmpRoot, '.bandit', 'memory');
    fs.mkdirSync(banditMemDir, { recursive: true });
    fs.writeFileSync(path.join(banditMemDir, 'auth.md'), 'auth body');
    fs.writeFileSync(path.join(banditMemDir, 'MEMORY.md'),
      '- [Auth](memory/auth.md) — when editing auth\n');

    const idx = await loadMemoryIndex(tmpRoot, () => {});
    expect(idx.source).toBe(path.resolve(tmpRoot, BANDIT_MEMORY_INDEX_FILE));
    expect(idx.entries).toHaveLength(1);
    expect(idx.entries[0].name).toBe('auth');
    expect(idx.entries[0].relPath).toBe('.bandit/memory/auth.md');
    expect(idx.entries[0].absPath).toBe(path.resolve(banditMemDir, 'auth.md'));
  });

  it('.bandit/memory/ entries resolve to .bandit/memory/<slug>.md absPath', async () => {
    const banditMemDir = path.join(tmpRoot, '.bandit', 'memory');
    fs.mkdirSync(banditMemDir, { recursive: true });
    fs.writeFileSync(path.join(banditMemDir, 'conventions.md'), 'content');
    fs.writeFileSync(path.join(banditMemDir, 'MEMORY.md'),
      '- [Conventions](memory/conventions.md) — coding style\n');

    const idx = await loadMemoryIndex(tmpRoot, () => {});
    expect(idx.entries[0].absPath).toBe(path.resolve(banditMemDir, 'conventions.md'));
  });
});

// ── Merge: both paths ───────────────────────────────────────────────────────

describe('loadMemoryIndex — merge of .bandit/memory/ and root memory/', () => {
  it('merges entries from both locations', async () => {
    // Root legacy
    fs.mkdirSync(path.join(tmpRoot, 'memory'));
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'db.md'), 'db body');
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'),
      '- [DB](memory/db.md) — when touching DB\n');

    // .bandit/memory/ preferred
    const banditMemDir = path.join(tmpRoot, '.bandit', 'memory');
    fs.mkdirSync(banditMemDir, { recursive: true });
    fs.writeFileSync(path.join(banditMemDir, 'auth.md'), 'auth body');
    fs.writeFileSync(path.join(banditMemDir, 'MEMORY.md'),
      '- [Auth](memory/auth.md) — when editing auth\n');

    const idx = await loadMemoryIndex(tmpRoot, () => {});
    const names = idx.entries.map((e) => e.name);
    expect(names).toContain('auth');
    expect(names).toContain('db');
    expect(idx.entries).toHaveLength(2);
  });

  it('.bandit/memory/ wins on slug collision (preferred over root)', async () => {
    // Root legacy — "auth" entry
    fs.mkdirSync(path.join(tmpRoot, 'memory'));
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'auth.md'), 'old auth body');
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'),
      '- [Old Auth](memory/auth.md) — old hook\n');

    // .bandit/memory/ — "auth" entry (wins)
    const banditMemDir = path.join(tmpRoot, '.bandit', 'memory');
    fs.mkdirSync(banditMemDir, { recursive: true });
    fs.writeFileSync(path.join(banditMemDir, 'auth.md'), 'new auth body');
    fs.writeFileSync(path.join(banditMemDir, 'MEMORY.md'),
      '- [New Auth](memory/auth.md) — new hook\n');

    const idx = await loadMemoryIndex(tmpRoot, () => {});
    const authEntry = idx.entries.find((e) => e.name === 'auth');
    expect(authEntry).toBeDefined();
    expect(authEntry!.title).toBe('New Auth');
    expect(authEntry!.hook).toBe('new hook');
    expect(authEntry!.relPath).toBe('.bandit/memory/auth.md');
    // Only one auth entry total
    expect(idx.entries.filter((e) => e.name === 'auth')).toHaveLength(1);
  });

  it('deduplicates by slug within a single location (first wins, emits warning)', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'memory'));
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'dup.md'), 'one');
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), [
      '- [First](memory/dup.md) — keep this hook',
      '- [Second](memory/dup.md) — drop me'
    ].join('\n'));
    const warnings: string[] = [];
    const idx = await loadMemoryIndex(tmpRoot, (m) => warnings.push(m));
    expect(idx.entries.filter((e) => e.name === 'dup')).toHaveLength(1);
    expect(idx.entries[0].title).toBe('First');
    expect(warnings.some((w) => w.includes('duplicate'))).toBe(true);
  });
});

// ── writeMemoryTopic ─────────────────────────────────────────────────────────

describe('writeMemoryTopic', () => {
  it('writes topic file to .bandit/memory/<slug>.md', async () => {
    await writeMemoryTopic(tmpRoot, 'auth-conventions', 'Auth Conventions', 'when editing auth', 'auth body');
    const topicPath = path.join(tmpRoot, '.bandit', 'memory', 'auth-conventions.md');
    expect(fs.existsSync(topicPath)).toBe(true);
    expect(fs.readFileSync(topicPath, 'utf-8')).toBe('auth body');
  });

  it('creates .bandit/memory/MEMORY.md index entry', async () => {
    await writeMemoryTopic(tmpRoot, 'auth', 'Auth', 'when editing auth', 'body');
    const indexPath = path.join(tmpRoot, '.bandit', 'memory', 'MEMORY.md');
    expect(fs.existsSync(indexPath)).toBe(true);
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).toContain('- [Auth](memory/auth.md) — when editing auth');
  });

  it('appends to existing index without duplicating', async () => {
    await writeMemoryTopic(tmpRoot, 'auth', 'Auth', 'hook1', 'body1');
    await writeMemoryTopic(tmpRoot, 'db', 'DB', 'hook2', 'body2');
    const indexPath = path.join(tmpRoot, '.bandit', 'memory', 'MEMORY.md');
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).toContain('memory/auth.md');
    expect(content).toContain('memory/db.md');
  });

  it('updates existing index entry on re-write of same slug', async () => {
    await writeMemoryTopic(tmpRoot, 'auth', 'Auth', 'old hook', 'old body');
    await writeMemoryTopic(tmpRoot, 'auth', 'Auth Updated', 'new hook', 'new body');
    const indexPath = path.join(tmpRoot, '.bandit', 'memory', 'MEMORY.md');
    const content = fs.readFileSync(indexPath, 'utf-8');
    // New hook present, old hook gone
    expect(content).toContain('new hook');
    expect(content).not.toContain('old hook');
    // Single entry
    expect((content.match(/memory\/auth\.md/g) ?? []).length).toBe(1);
  });

  it('rejects invalid slug (path traversal)', async () => {
    await expect(writeMemoryTopic(tmpRoot, '../escape', 'T', 'h', 'b')).rejects.toThrow(/invalid slug/);
  });

  it('round-trips: written topic is readable via loadMemoryIndex', async () => {
    await writeMemoryTopic(tmpRoot, 'conventions', 'Conventions', 'coding style', 'Use TypeScript strict mode.');
    const idx = await loadMemoryIndex(tmpRoot, () => {});
    const entry = idx.entries.find((e) => e.name === 'conventions');
    expect(entry).toBeDefined();
    expect(entry!.hook).toBe('coding style');
    const content = fs.readFileSync(entry!.absPath, 'utf-8');
    expect(content).toBe('Use TypeScript strict mode.');
  });
});

// ── migrateMemoryToBanditDir ─────────────────────────────────────────────────

describe('migrateMemoryToBanditDir', () => {
  it('does nothing when root MEMORY.md is absent', async () => {
    const written = await migrateMemoryToBanditDir(tmpRoot);
    expect(written).toEqual([]);
    expect(fs.existsSync(path.join(tmpRoot, '.bandit', 'memory'))).toBe(false);
  });

  it('does nothing when .bandit/memory/MEMORY.md already exists (idempotent)', async () => {
    // Pre-migrated state
    const banditMemDir = path.join(tmpRoot, '.bandit', 'memory');
    fs.mkdirSync(banditMemDir, { recursive: true });
    fs.writeFileSync(path.join(banditMemDir, 'MEMORY.md'), '# existing');
    // Also put a root MEMORY.md
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), '# original');

    const written = await migrateMemoryToBanditDir(tmpRoot);
    expect(written).toEqual([]);
    // Target unchanged
    expect(fs.readFileSync(path.join(banditMemDir, 'MEMORY.md'), 'utf-8')).toBe('# existing');
  });

  it('migrates root MEMORY.md + memory/ into .bandit/memory/', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'memory'));
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'auth.md'), 'auth body');
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'db.md'), 'db body');
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), '- [Auth](memory/auth.md) — hook\n');

    const written = await migrateMemoryToBanditDir(tmpRoot);
    // Should have written auth.md, db.md, MEMORY.md
    expect(written.length).toBeGreaterThanOrEqual(3);

    const banditMemDir = path.join(tmpRoot, BANDIT_MEMORY_DIR);
    expect(fs.existsSync(path.join(banditMemDir, 'MEMORY.md'))).toBe(true);
    expect(fs.existsSync(path.join(banditMemDir, 'auth.md'))).toBe(true);
    expect(fs.existsSync(path.join(banditMemDir, 'db.md'))).toBe(true);

    // Content preserved
    expect(fs.readFileSync(path.join(banditMemDir, 'auth.md'), 'utf-8')).toBe('auth body');
    expect(fs.readFileSync(path.join(banditMemDir, 'MEMORY.md'), 'utf-8')).toBe('- [Auth](memory/auth.md) — hook\n');
  });

  it('does NOT delete originals (safe migration)', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'memory'));
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'auth.md'), 'auth body');
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), '- [Auth](memory/auth.md) — hook\n');

    await migrateMemoryToBanditDir(tmpRoot);

    // Originals still present
    expect(fs.existsSync(path.join(tmpRoot, 'MEMORY.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'memory', 'auth.md'))).toBe(true);
  });

  it('migrates even when memory/ dir is absent (index-only)', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), '# just an index\n');

    const written = await migrateMemoryToBanditDir(tmpRoot);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('MEMORY.md');
    expect(fs.existsSync(path.join(tmpRoot, BANDIT_MEMORY_DIR, 'MEMORY.md'))).toBe(true);
  });

  it('is idempotent — calling twice is safe', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'memory'));
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'auth.md'), 'body');
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), '- [Auth](memory/auth.md) — h\n');

    await migrateMemoryToBanditDir(tmpRoot);
    const second = await migrateMemoryToBanditDir(tmpRoot);
    expect(second).toEqual([]);
  });

  it('post-migration: loadMemoryIndex finds entries via .bandit/memory/', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'memory'));
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'auth.md'), 'auth body');
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), '- [Auth](memory/auth.md) — when editing auth\n');

    await migrateMemoryToBanditDir(tmpRoot);
    // Now load — should find via .bandit/memory/
    const idx = await loadMemoryIndex(tmpRoot, () => {});
    expect(idx.entries.some((e) => e.name === 'auth')).toBe(true);
    // The preferred path wins (both exist after migration without deletion)
    const authEntry = idx.entries.find((e) => e.name === 'auth')!;
    expect(authEntry.relPath).toBe('.bandit/memory/auth.md');
  });
});

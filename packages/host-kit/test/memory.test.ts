/**
 * Contract tests for the project-memory module — auto-loading
 * BANDIT.md / CLAUDE.md / .bandit/* and the `appendMemory` helper
 * the `/remember` command writes through.
 *
 * v0.4 additions:
 * - loadMemory deduplication (identical or contained content skipped)
 * - loadCombinedMemory uses .bandit/memory/ index path
 * - consolidateMemory: merges entry files into canonical BANDIT.md
 *
 * Why pin: the auto-load path is on every agent turn; a regression
 * here would either silently drop the user's persisted rules
 * (worst-case: agent ignores known constraints) or double-load
 * them. Tests use a tmp workspace per case so file-system state
 * stays isolated.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadMemory, loadCombinedMemory, appendMemory, consolidateMemory } from '../src/memory';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-kit-memory-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadMemory', () => {
  it('returns empty bundle when no memory files exist', async () => {
    const bundle = await loadMemory(tmpRoot);
    expect(bundle.content).toBe('');
    expect(bundle.sources).toEqual([]);
  });

  it('loads BANDIT.md when present', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), '# Memory\n\nAlways prefer pnpm.\n');
    const bundle = await loadMemory(tmpRoot);
    expect(bundle.sources).toContain('BANDIT.md');
    expect(bundle.content).toContain('Always prefer pnpm');
    expect(bundle.content).toContain('source: BANDIT.md');
  });

  it('loads CLAUDE.md when present (compat with existing repos)', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), '# Memory\n\nUse Tailwind only.\n');
    const bundle = await loadMemory(tmpRoot);
    expect(bundle.sources).toContain('CLAUDE.md');
    expect(bundle.content).toContain('Use Tailwind only');
  });

  it('loads BOTH BANDIT.md and CLAUDE.md when both have different content', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), 'rule one');
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'rule two');
    const bundle = await loadMemory(tmpRoot);
    expect(bundle.sources).toContain('BANDIT.md');
    expect(bundle.sources).toContain('CLAUDE.md');
    expect(bundle.content).toContain('rule one');
    expect(bundle.content).toContain('rule two');
  });

  it('loads AGENTS.md when present (Codex / Copilot convention)', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), '# Agents memory\n\nRun lint before commit.\n');
    const bundle = await loadMemory(tmpRoot);
    expect(bundle.sources).toContain('AGENTS.md');
    expect(bundle.content).toContain('Run lint before commit');
  });

  it('loads BANDIT.md and AGENTS.md side-by-side when both exist', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), 'bandit rule');
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), 'agents rule');
    const bundle = await loadMemory(tmpRoot);
    expect(bundle.sources).toContain('BANDIT.md');
    expect(bundle.sources).toContain('AGENTS.md');
    expect(bundle.content).toContain('bandit rule');
    expect(bundle.content).toContain('agents rule');
  });

  it('loads .bandit/BANDIT.md and .bandit/memory.md when present', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.bandit'));
    fs.writeFileSync(path.join(tmpRoot, '.bandit', 'BANDIT.md'), 'inner-1');
    fs.writeFileSync(path.join(tmpRoot, '.bandit', 'memory.md'), 'inner-2');
    const bundle = await loadMemory(tmpRoot);
    expect(bundle.sources).toContain('.bandit/BANDIT.md');
    expect(bundle.sources).toContain('.bandit/memory.md');
  });

  it('skips empty files (zero-byte files do not appear in sources)', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), '');
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'has content');
    const bundle = await loadMemory(tmpRoot);
    expect(bundle.sources).toEqual(['CLAUDE.md']);
  });

  it('truncates files larger than MAX_BYTES (32 KB) and appends an ellipsis marker', async () => {
    const big = 'X'.repeat(40 * 1024); // 40 KB > 32 KB cap
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), big);
    const bundle = await loadMemory(tmpRoot);
    expect(bundle.sources).toEqual(['BANDIT.md']);
    expect(bundle.content).toMatch(/… \(truncated\)/);
    // Body length should be capped near MAX_BYTES (with header overhead).
    expect(bundle.content.length).toBeLessThan(40 * 1024);
  });

  it('does not throw when cwd does not exist (returns empty)', async () => {
    const bundle = await loadMemory(path.join(tmpRoot, 'does-not-exist'));
    expect(bundle.content).toBe('');
    expect(bundle.sources).toEqual([]);
  });

  // ── Deduplication tests ────────────────────────────────────────────────────

  it('deduplicates: skips CLAUDE.md when content is byte-identical to BANDIT.md', async () => {
    const shared = '# Memory\n\nAlways prefer pnpm.\n';
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), shared);
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), shared);
    const bundle = await loadMemory(tmpRoot);
    // BANDIT.md is loaded first; CLAUDE.md is skipped as duplicate
    expect(bundle.sources).toEqual(['BANDIT.md']);
    // Content appears only once
    expect((bundle.content.match(/Always prefer pnpm/g) ?? []).length).toBe(1);
  });

  it('deduplicates: skips a file whose content is a substring of an already-loaded file', async () => {
    // BANDIT.md contains everything from CLAUDE.md (superset)
    const claudeContent = 'rule A\nrule B';
    const banditContent = `# Project\n\n${claudeContent}\n\nrule C\n`;
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), banditContent);
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), claudeContent);
    const bundle = await loadMemory(tmpRoot);
    // CLAUDE.md content is contained in BANDIT.md — skip CLAUDE.md
    expect(bundle.sources).not.toContain('CLAUDE.md');
    expect(bundle.sources).toContain('BANDIT.md');
  });

  it('does NOT skip files with genuinely different content', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), 'unique content A');
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'unique content B');
    const bundle = await loadMemory(tmpRoot);
    expect(bundle.sources).toContain('BANDIT.md');
    expect(bundle.sources).toContain('CLAUDE.md');
    expect(bundle.content).toContain('unique content A');
    expect(bundle.content).toContain('unique content B');
  });

  it('deduplication normalises whitespace before comparing', async () => {
    // Same content, slightly different whitespace
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), 'rule  A\n\n\nrule B\n');
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'rule A\nrule B');
    const bundle = await loadMemory(tmpRoot);
    // Should deduplicate (same after whitespace normalisation)
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources).toContain('BANDIT.md');
  });
});

describe('loadCombinedMemory', () => {
  it('returns same shape as loadMemory when no MEMORY.md is present', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), 'rule one');
    const bundle = await loadCombinedMemory(tmpRoot, () => {});
    expect(bundle.sources).toEqual(['BANDIT.md']);
    expect(bundle.content).toContain('rule one');
    expect(bundle.content).not.toContain('source: .bandit/memory/MEMORY.md');
  });

  it('appends rendered index block when .bandit/memory/ index has entries', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), 'rule one');
    const banditMemDir = path.join(tmpRoot, '.bandit', 'memory');
    fs.mkdirSync(banditMemDir, { recursive: true });
    fs.writeFileSync(path.join(banditMemDir, 'auth.md'), 'auth body');
    fs.writeFileSync(path.join(banditMemDir, 'MEMORY.md'),
      '- [Auth](memory/auth.md) — when editing auth\n');
    const bundle = await loadCombinedMemory(tmpRoot, () => {});
    expect(bundle.sources).toContain('BANDIT.md');
    expect(bundle.content).toContain('rule one');
    expect(bundle.content).toMatch(/read_memory/);
  });

  it('appends rendered index block (back-compat: legacy root MEMORY.md)', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), 'rule one');
    fs.mkdirSync(path.join(tmpRoot, 'memory'));
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'auth.md'), 'auth body');
    fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'),
      '- [Auth](memory/auth.md) — when editing auth\n');
    const bundle = await loadCombinedMemory(tmpRoot, () => {});
    expect(bundle.sources).toContain('BANDIT.md');
    expect(bundle.content).toContain('rule one');
    expect(bundle.content).toContain('[Auth](memory/auth.md)');
    expect(bundle.content).toMatch(/read_memory/);
  });

  it('skips index source when index file is missing', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), 'rule one');
    const bundle = await loadCombinedMemory(tmpRoot, () => {});
    expect(bundle.sources).not.toContain('MEMORY.md');
    expect(bundle.sources).not.toContain('.bandit/memory/MEMORY.md');
  });
});

describe('appendMemory', () => {
  it('creates BANDIT.md with a scaffold + Notes section when none exists', async () => {
    const written = await appendMemory(tmpRoot, 'Always prefer pnpm');
    expect(written).toBe(path.resolve(tmpRoot, 'BANDIT.md'));
    const content = fs.readFileSync(written, 'utf-8');
    expect(content).toMatch(/# Project Memory/);
    expect(content).toMatch(/## Notes/);
    expect(content).toMatch(/- Always prefer pnpm/);
  });

  it('appends to existing BANDIT.md without duplicating the scaffold', async () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'BANDIT.md'),
      '# Project Memory\n\nExisting content.\n\n## Notes\n\n- first fact\n'
    );
    await appendMemory(tmpRoot, 'second fact');
    const content = fs.readFileSync(path.join(tmpRoot, 'BANDIT.md'), 'utf-8');
    // Both bullets present
    expect(content).toMatch(/- first fact/);
    expect(content).toMatch(/- second fact/);
    // Single Notes heading (no duplication)
    expect((content.match(/## Notes/g) ?? []).length).toBe(1);
    // Single Project Memory heading
    expect((content.match(/# Project Memory/g) ?? []).length).toBe(1);
  });

  it('adds a Notes section to an existing file without one', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), '# Custom Memory\n\nSome other content.\n');
    await appendMemory(tmpRoot, 'a new bullet');
    const content = fs.readFileSync(path.join(tmpRoot, 'BANDIT.md'), 'utf-8');
    expect(content).toMatch(/# Custom Memory/);
    expect(content).toMatch(/## Notes/);
    expect(content).toMatch(/- a new bullet/);
  });

  it('always writes to BANDIT.md even when CLAUDE.md is the loaded source', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), '# Existing Claude memory');
    await appendMemory(tmpRoot, 'fact going forward');
    expect(fs.existsSync(path.join(tmpRoot, 'BANDIT.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'CLAUDE.md'))).toBe(true);
    // Original CLAUDE.md untouched.
    const claude = fs.readFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'utf-8');
    expect(claude).toBe('# Existing Claude memory');
  });

  it('throws on empty fact', async () => {
    await expect(appendMemory(tmpRoot, '')).rejects.toThrow(/non-empty string/);
    await expect(appendMemory(tmpRoot, '   ')).rejects.toThrow(/non-empty string/);
  });

  it('preserves chronological order — newer bullets land at the bottom', async () => {
    await appendMemory(tmpRoot, 'fact A');
    await appendMemory(tmpRoot, 'fact B');
    await appendMemory(tmpRoot, 'fact C');
    const content = fs.readFileSync(path.join(tmpRoot, 'BANDIT.md'), 'utf-8');
    const idxA = content.indexOf('- fact A');
    const idxB = content.indexOf('- fact B');
    const idxC = content.indexOf('- fact C');
    expect(idxA).toBeGreaterThan(0);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
  });

  it('round-trip: appendMemory + loadMemory surface the saved fact on the next turn', async () => {
    await appendMemory(tmpRoot, 'session preference: pnpm only');
    const bundle = await loadMemory(tmpRoot);
    expect(bundle.sources).toContain('BANDIT.md');
    expect(bundle.content).toContain('session preference: pnpm only');
  });
});

// ── consolidateMemory ────────────────────────────────────────────────────────

describe('consolidateMemory', () => {
  it('does nothing (returns empty result) when no entry files exist', async () => {
    const result = await consolidateMemory(tmpRoot);
    expect(result.redirected).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.canonical).toBe(path.resolve(tmpRoot, 'BANDIT.md'));
  });

  it('when only BANDIT.md exists, no redirects needed', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), 'rule one');
    const result = await consolidateMemory(tmpRoot);
    expect(result.canonical).toBe(path.resolve(tmpRoot, 'BANDIT.md'));
    expect(result.redirected).toEqual([]);
  });

  it('merges CLAUDE.md content into BANDIT.md and redirects CLAUDE.md', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), 'bandit content');
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'claude-unique content');
    const result = await consolidateMemory(tmpRoot, 'copy');
    expect(result.canonical).toBe(path.resolve(tmpRoot, 'BANDIT.md'));
    expect(result.redirected.map((p) => path.basename(p))).toContain('CLAUDE.md');

    // Canonical should contain both pieces
    const canon = fs.readFileSync(result.canonical, 'utf-8');
    expect(canon).toContain('bandit content');
    expect(canon).toContain('claude-unique content');
  });

  it('skips duplicate content when merging (does not double-add identical content)', async () => {
    const shared = 'identical rule';
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), shared);
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), shared);
    await consolidateMemory(tmpRoot, 'copy');
    const canon = fs.readFileSync(path.resolve(tmpRoot, 'BANDIT.md'), 'utf-8');
    // "identical rule" appears only once
    expect((canon.match(/identical rule/g) ?? []).length).toBe(1);
  });

  it('creates BANDIT.md with scaffold when only CLAUDE.md exists', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'from claude');
    const result = await consolidateMemory(tmpRoot, 'copy');
    const canon = fs.readFileSync(result.canonical, 'utf-8');
    expect(canon).toContain('from claude');
  });

  it('copy strategy: other files become copies with drift warning header', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), 'canonical content');
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'other content');
    await consolidateMemory(tmpRoot, 'copy');
    const claudeContent = fs.readFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'utf-8');
    expect(claudeContent).toContain('COPY of BANDIT.md');
    expect(claudeContent).toContain('canonical content');
  });

  it('post-consolidation: BANDIT.md contains merged content from CLAUDE.md', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), 'rule from bandit');
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'rule from claude');
    await consolidateMemory(tmpRoot, 'copy');

    // After consolidation, BANDIT.md has the merged content
    const bandit = fs.readFileSync(path.join(tmpRoot, 'BANDIT.md'), 'utf-8');
    expect(bandit).toContain('rule from bandit');
    expect(bandit).toContain('rule from claude');

    // CLAUDE.md is now a copy-redirect pointing at the same content as BANDIT.md
    const claude = fs.readFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('COPY of BANDIT.md');

    // loadMemory: BANDIT.md loads; CLAUDE.md is NOT a substring of BANDIT.md
    // (it has the drift-warning header), so it's kept. But BANDIT.md content
    // IS contained in CLAUDE.md (superset) — so CLAUDE.md would be skipped.
    const bundle = await loadMemory(tmpRoot);
    expect(bundle.sources).toContain('BANDIT.md');
  });

  it('handles AGENTS.md alongside BANDIT.md and CLAUDE.md', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), 'bandit rule');
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'claude rule');
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), 'agents rule');
    const result = await consolidateMemory(tmpRoot, 'copy');
    const canon = fs.readFileSync(result.canonical, 'utf-8');
    expect(canon).toContain('bandit rule');
    expect(canon).toContain('claude rule');
    expect(canon).toContain('agents rule');
    const redirectedNames = result.redirected.map((p) => path.basename(p));
    expect(redirectedNames).toContain('CLAUDE.md');
    expect(redirectedNames).toContain('AGENTS.md');
  });

  it('symlink strategy: skips already-symlinked files', async () => {
    // Skip this test on Windows where symlinks require elevated permissions
    const isWindows = process.platform === 'win32';
    if (isWindows) return;

    fs.writeFileSync(path.join(tmpRoot, 'BANDIT.md'), 'canonical');
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'other content');

    // First consolidation creates symlink
    const r1 = await consolidateMemory(tmpRoot, 'symlink-or-copy');
    const claudeRedirected = r1.redirected.some((p) => p.includes('CLAUDE.md'));
    const claudeSkipped = r1.skipped.some((p) => p.includes('CLAUDE.md'));
    expect(claudeRedirected || claudeSkipped).toBe(true);

    // Second consolidation: CLAUDE.md is already a symlink pointing at BANDIT.md
    const r2 = await consolidateMemory(tmpRoot, 'symlink-or-copy');
    expect(r2.skipped.some((p) => p.includes('CLAUDE.md'))).toBe(true);
  });
});

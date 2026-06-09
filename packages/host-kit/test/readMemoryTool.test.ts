/**
 * Tests for the read_memory tool. The contract this pins:
 *   - resolves a valid slug to the file body, prefixed with a source comment
 *   - rejects path traversal up-front (no fs touch)
 *   - on miss, lists the available slugs so the model can self-correct
 *   - caps output at MAX_MEMORY_FILE_BYTES
 *   - v0.4: resolves slugs from .bandit/memory/ (preferred) and legacy memory/
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildReadMemoryTool } from '../src/tools/readMemoryTool';
import { MAX_MEMORY_FILE_BYTES } from '../src/memoryIndex';
import type { ToolExecutionContext } from '@burtson-labs/agent-core';

let tmpRoot: string;
let ctx: ToolExecutionContext;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-kit-readmem-'));
  ctx = {
    workspaceRoot: tmpRoot,
    async readFile() { return ''; },
    async writeFile() { return; },
    async listFiles() { return []; },
    async searchCode() { return ''; },
    async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
  };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Seed the LEGACY root memory/ index. */
function seedRootIndex(entries: Array<{ slug: string; title: string; hook: string; body: string }>): void {
  fs.mkdirSync(path.join(tmpRoot, 'memory'), { recursive: true });
  const lines: string[] = ['# Index', ''];
  for (const e of entries) {
    fs.writeFileSync(path.join(tmpRoot, 'memory', `${e.slug}.md`), e.body);
    lines.push(`- [${e.title}](memory/${e.slug}.md) — ${e.hook}`);
  }
  fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), lines.join('\n'));
}

/** Seed the preferred .bandit/memory/ index. */
function seedBanditIndex(entries: Array<{ slug: string; title: string; hook: string; body: string }>): void {
  const memDir = path.join(tmpRoot, '.bandit', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  const lines: string[] = ['# Index', ''];
  for (const e of entries) {
    fs.writeFileSync(path.join(memDir, `${e.slug}.md`), e.body);
    lines.push(`- [${e.title}](memory/${e.slug}.md) — ${e.hook}`);
  }
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), lines.join('\n'));
}

// Keep legacy name for existing tests
const seedIndex = seedRootIndex;

describe('buildReadMemoryTool', () => {
  it('has the expected shape', () => {
    const tool = buildReadMemoryTool();
    expect(tool.name).toBe('read_memory');
    expect(tool.parameters[0].name).toBe('name');
    expect(tool.parameters[0].required).toBe(true);
  });

  // ── Legacy root memory/ (back-compat) ────────────────────────────────────

  it('returns body with a source comment for a valid slug (legacy root)', async () => {
    seedIndex([{ slug: 'auth', title: 'Auth', hook: 'when editing auth', body: 'auth body here' }]);
    const tool = buildReadMemoryTool();
    const res = await tool.execute({ name: 'auth' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain('<!-- source: memory/auth.md -->');
    expect(res.output).toContain('auth body here');
  });

  it('accepts a slug with a .md suffix and strips it', async () => {
    seedIndex([{ slug: 'auth', title: 'Auth', hook: 'h', body: 'b' }]);
    const tool = buildReadMemoryTool();
    const res = await tool.execute({ name: 'auth.md' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain('b');
  });

  it('rejects empty name', async () => {
    const tool = buildReadMemoryTool();
    const res = await tool.execute({ name: '' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/name parameter is required/);
  });

  it('rejects path traversal in the slug (../etc/passwd)', async () => {
    const tool = buildReadMemoryTool();
    const res = await tool.execute({ name: '../etc/passwd' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/plain slug/);
  });

  it('rejects an absolute path', async () => {
    const tool = buildReadMemoryTool();
    const res = await tool.execute({ name: '/etc/passwd' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/plain slug/);
  });

  it('rejects backslashes', async () => {
    const tool = buildReadMemoryTool();
    const res = await tool.execute({ name: '..\\windows' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/plain slug/);
  });

  it('reports "No memory index found" when MEMORY.md is absent from both locations', async () => {
    const tool = buildReadMemoryTool();
    const res = await tool.execute({ name: 'whatever' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/No memory index found/);
  });

  it('on miss, lists available slugs', async () => {
    seedIndex([
      { slug: 'auth', title: 'A', hook: 'h', body: 'b' },
      { slug: 'db', title: 'B', hook: 'h', body: 'b' }
    ]);
    const tool = buildReadMemoryTool();
    const res = await tool.execute({ name: 'missing' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/Available: auth, db/);
  });

  it('truncates files larger than MAX_MEMORY_FILE_BYTES', async () => {
    const body = 'X'.repeat(MAX_MEMORY_FILE_BYTES + 1024);
    seedIndex([{ slug: 'big', title: 'Big', hook: 'h', body }]);
    const tool = buildReadMemoryTool();
    const res = await tool.execute({ name: 'big' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toMatch(/truncated/);
  });

  // ── Preferred .bandit/memory/ path ────────────────────────────────────────

  it('reads from .bandit/memory/ when available (preferred path)', async () => {
    seedBanditIndex([{ slug: 'auth', title: 'Auth', hook: 'when editing auth', body: 'bandit auth body' }]);
    const tool = buildReadMemoryTool();
    const res = await tool.execute({ name: 'auth' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain('<!-- source: .bandit/memory/auth.md -->');
    expect(res.output).toContain('bandit auth body');
  });

  it('.bandit/memory/ wins over root memory/ on slug collision', async () => {
    // Both have "auth" — .bandit/memory/ should win
    seedRootIndex([{ slug: 'auth', title: 'Old Auth', hook: 'old hook', body: 'old body' }]);
    seedBanditIndex([{ slug: 'auth', title: 'New Auth', hook: 'new hook', body: 'new body' }]);
    const tool = buildReadMemoryTool();
    const res = await tool.execute({ name: 'auth' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain('new body');
    expect(res.output).not.toContain('old body');
    expect(res.output).toContain('.bandit/memory/auth.md');
  });

  it('falls back to root memory/ slug when only root has it', async () => {
    // .bandit/memory/ has "conventions"; root has "db"
    seedBanditIndex([{ slug: 'conventions', title: 'Conventions', hook: 'h', body: 'conventions body' }]);
    seedRootIndex([{ slug: 'db', title: 'DB', hook: 'h', body: 'db body' }]);
    const tool = buildReadMemoryTool();

    const resConventions = await tool.execute({ name: 'conventions' }, ctx);
    expect(resConventions.isError).toBeFalsy();
    expect(resConventions.output).toContain('conventions body');

    const resDb = await tool.execute({ name: 'db' }, ctx);
    expect(resDb.isError).toBeFalsy();
    expect(resDb.output).toContain('db body');
    expect(resDb.output).toContain('memory/db.md');
  });
});

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const {
  applyEditTool,
  createDefaultLanguageAdapters
} = require('@burtson-labs/agent-core');

// Minimal CLI-style ToolExecutionContext that wires the adapters
// the same way both real hosts do. Verifies the system end-to-end —
// not a mock.
class TestCtx {
  workspaceRoot: string;
  languageAdapters: ReturnType<typeof createDefaultLanguageAdapters>;
  private readFiles = new Set<string>();
  constructor(root: string) {
    this.workspaceRoot = root;
    this.languageAdapters = createDefaultLanguageAdapters();
  }
  async readFile(p: string): Promise<string> {
    this.readFiles.add(path.resolve(p));
    return fs.readFile(p, 'utf-8');
  }
  async writeFile(p: string, content: string): Promise<void> {
    await fs.writeFile(p, content, 'utf-8');
  }
  async listFiles(): Promise<string[]> { return []; }
  async searchCode(): Promise<string> { return ''; }
  async runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Forward to a real spawn — the TypeScript adapter shells out to node.
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(cmd, args, { cwd: this.workspaceRoot, encoding: 'utf-8' });
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      exitCode: r.status ?? 1
    };
  }
  hasFileBeenRead(p: string): boolean {
    return this.readFiles.has(path.resolve(p));
  }
  markFileRead(p: string): void {
    this.readFiles.add(path.resolve(p));
  }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bandit-langadapt-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('language adapter validation — end to end', () => {
  // Uses JSON because the JSON adapter has no external dependency
  // (JSON.parse is built-in). The TypeScript adapter requires the
  // `typescript` package to be in the project's node_modules — when
  // it's missing the adapter silently skips, which is the pragmatic
  // choice for projects without TS installed but makes a temp-dir
  // test misleading. JSON exercises the same `validate(...)` →
  // `introducedNewErrors(...)` pipeline.

  it('blocks an apply_edit that introduces a NEW JSON parse error', async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, 'config.json');
      const valid = `{\n  "name": "bandit",\n  "version": "1.0.0"\n}\n`;
      await fs.writeFile(target, valid);

      const ctx = new TestCtx(dir);
      await ctx.readFile(target);  // satisfy read-before-edit guard

      // Replace the closing brace with garbage — invalid JSON.
      const broken = await applyEditTool.execute(
        { path: 'config.json', find: '"version": "1.0.0"', replace: '"version": "1.0.0",' },
        ctx
      );

      expect(broken.isError).toBe(true);
      expect(broken.output.toLowerCase()).toMatch(/json|validation|syntax/);
      // File on disk should be UNCHANGED — broken edit rejected.
      const onDisk = await fs.readFile(target, 'utf-8');
      expect(onDisk).toBe(valid);
    });
  });

  it('does NOT gate edits to a file that was already broken before the edit', async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, 'broken.json');
      // Pre-existing rot — file already has invalid JSON (trailing comma).
      const preBroken = `{\n  "name": "bandit",\n  "version": "1.0.0",\n}\n`;
      await fs.writeFile(target, preBroken);

      const ctx = new TestCtx(dir);
      await ctx.readFile(target);

      // Edit something that doesn't fix the trailing comma. The pre-
      // existing parse error is still there afterwards. introducedNewErrors
      // should see "same error before and after" and let the edit land.
      const result = await applyEditTool.execute(
        { path: 'broken.json', find: '"name": "bandit"', replace: '"name": "bandit-renamed"' },
        ctx
      );

      expect(result.isError).toBeFalsy();
      const onDisk = await fs.readFile(target, 'utf-8');
      expect(onDisk).toContain('bandit-renamed');
      // Pre-existing error still there — we never claimed to fix it.
      expect(onDisk).toContain('"version": "1.0.0",\n}');
    });
  });
});

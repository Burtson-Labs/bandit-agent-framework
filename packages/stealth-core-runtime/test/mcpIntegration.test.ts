/**
 * MCP integration test — proves the wire protocol actually works
 * end-to-end against a real MCP server (the official filesystem
 * server). Unlike mcp.test.ts which exercises pool lifecycle and
 * adapter shape with mocks, this test:
 *
 *   1. Spawns @modelcontextprotocol/server-filesystem against a temp
 *      directory we control.
 *   2. Runs the JSON-RPC handshake via our McpClientPool.
 *   3. Asks the server for its tool list and verifies we got real
 *      tools back.
 *   4. Calls one tool (read_text_file) and confirms the round-trip
 *      returns the bytes we wrote.
 *
 * If our SDK usage is subtly wrong — wrong transport options, wrong
 * connect order, wrong tool-call schema — this test catches it.
 * Connector wizards (Slack, GitHub, Office 365) inherit the same
 * client code, so a green run here is a regression gate for every
 * future MCP server we add.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpClientPool } from '@burtson-labs/agent-core';

// Resolve the server-filesystem bin via require.resolve so we don't
// hardcode a pnpm store path. The bin is `dist/index.js` per the
// package's manifest; we spawn it with `node` for portability.
function resolveFilesystemServerEntry(): string {
  // The package's main file is `dist/index.js`. require.resolve
  // returns its absolute path no matter where pnpm hoisted it.
  return require.resolve('@modelcontextprotocol/server-filesystem/dist/index.js');
}

let workspace: string;
let pool: McpClientPool;

beforeAll(async () => {
  // realpathSync resolves macOS's `/var → /private/var` symlink so the
  // allow-list path the filesystem server stores matches the path we
  // later ask it to read. Without it, every callTool returns
  // "Access denied - path outside allowed directories" on macOS.
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-mcp-integration-')));
  fs.writeFileSync(path.join(workspace, 'hello.txt'), 'Hello, MCP world!\n');
  pool = new McpClientPool();
  pool.register('fs', {
    command: process.execPath,
    args: [resolveFilesystemServerEntry(), workspace]
  });
});

afterAll(async () => {
  await pool.dispose();
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('MCP end-to-end (real server)', () => {
  it('completes the handshake and reports a connected status', async () => {
    const ok = await pool.ensureConnected('fs');
    expect(ok).toBe(true);
    const snap = pool.snapshot()[0];
    expect(snap.status.state).toBe('connected');
  }, 20000);

  it('lists tools from the real server', async () => {
    const tools = await pool.discoverTools('fs');
    expect(tools.length).toBeGreaterThan(0);
    // server-filesystem ships read/write/list/etc. Names have changed
    // across versions; we only assert the shape is sane and at least
    // one tool name contains "file" or "directory" — robust to renames.
    const names = tools.map((t) => t.name.toLowerCase());
    const matchesExpected = names.some((n) => n.includes('file') || n.includes('directory') || n.includes('read'));
    expect(matchesExpected).toBe(true);
  }, 20000);

  it('round-trips a file read through the JSON-RPC client', async () => {
    const tools = await pool.discoverTools('fs');
    // server-filesystem ≥ 2025.10 exposes "read_text_file"; older
    // versions used "read_file". Pick whichever is available so the
    // test stays green across SDK bumps.
    const reader = tools.find((t) => t.name === 'read_text_file')
      ?? tools.find((t) => t.name === 'read_file');
    expect(reader, `expected a read_*_file tool; got ${tools.map(t => t.name).join(', ')}`).toBeDefined();
    if (!reader) return; // narrowing for TS — assert above already failed
    const target = path.join(workspace, 'hello.txt');
    const result = await pool.callTool('fs', reader.name, { path: target });
    const blocks = result.content ?? [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    expect(text).toContain('Hello, MCP world!');
  }, 20000);
});

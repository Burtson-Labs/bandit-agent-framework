import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  McpClientPool,
  mcpToolToAgentTool,
  type McpServerSnapshot
} from '@burtson-labs/agent-core';
import {
  loadMcpServersConfig,
  registerMcpServersFromDisk
} from '@burtson-labs/host-kit';

// Sandboxed temp workspace + HOME so loadMcpServersConfig reads only test
// fixtures, never the developer's real global ~/.bandit/mcp-servers.json.
let workspace: string;
let homeDir: string;
beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-mcp-home-'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-mcp-test-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('McpClientPool', () => {
  it('snapshot starts empty when nothing is registered', () => {
    const pool = new McpClientPool();
    expect(pool.list()).toEqual([]);
    expect(pool.snapshot()).toEqual([]);
  });

  it('register puts a server in the idle state without spawning', () => {
    const pool = new McpClientPool();
    pool.register('demo', { command: 'echo', args: ['hello'] });
    const snap: McpServerSnapshot[] = pool.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].name).toBe('demo');
    expect(snap[0].status.state).toBe('idle');
  });

  it('disabled config produces a disabled snapshot, not idle', () => {
    const pool = new McpClientPool();
    pool.register('off', { command: 'echo', args: [], disabled: true });
    expect(pool.snapshot()[0].status.state).toBe('disabled');
  });

  it('ensureConnected on a disabled server returns false without throwing', async () => {
    const pool = new McpClientPool();
    pool.register('off', { command: 'echo', args: [], disabled: true });
    await expect(pool.ensureConnected('off')).resolves.toBe(false);
  });

  it('ensureConnected on an unknown server returns false without throwing', async () => {
    const pool = new McpClientPool();
    await expect(pool.ensureConnected('does-not-exist')).resolves.toBe(false);
  });

  it('ensureConnected with a non-existent command degrades to error state, never throws', async () => {
    const pool = new McpClientPool();
    // Picking a binary path that definitely doesn't exist on any host.
    pool.register('broken', { command: '/this/path/should/never/exist/bandit-mcp-noop', args: [] });
    const ok = await pool.ensureConnected('broken');
    expect(ok).toBe(false);
    const status = pool.snapshot()[0].status;
    expect(status.state).toBe('error');
    if (status.state === 'error') {
      expect(typeof status.message).toBe('string');
      expect(status.message.length).toBeGreaterThan(0);
    }
  });

  it('discoverTools returns empty array for failed servers (no exceptions)', async () => {
    const pool = new McpClientPool();
    pool.register('broken', { command: '/this/path/should/never/exist/bandit-mcp-noop', args: [] });
    await expect(pool.discoverTools('broken')).resolves.toEqual([]);
  });

  it('callTool throws a clear error when the server is unregistered', async () => {
    const pool = new McpClientPool();
    await expect(pool.callTool('missing', 'whatever', {})).rejects.toThrow(/not registered/);
  });

  it('callTool throws a clear error when the server failed to spawn', async () => {
    const pool = new McpClientPool();
    pool.register('broken', { command: '/nope/never', args: [] });
    await expect(pool.callTool('broken', 'whatever', {})).rejects.toThrow(/not connected/);
  });
});

describe('mcpToolToAgentTool', () => {
  it('namespaces the tool name as <server>.<tool>', () => {
    const pool = new McpClientPool();
    const wrapper = mcpToolToAgentTool('slack', { name: 'post_message' }, pool);
    expect(wrapper.name).toBe('slack.post_message');
  });

  it('preserves the MCP description and adds a server-attribution suffix', () => {
    const pool = new McpClientPool();
    const wrapper = mcpToolToAgentTool('gdrive', {
      name: 'list_files',
      description: 'List files in a Drive folder.'
    }, pool);
    expect(wrapper.description).toContain('List files in a Drive folder.');
    expect(wrapper.description).toContain('gdrive');
  });

  it('converts a JSON-Schema input shape into AgentToolParameter[]', () => {
    const pool = new McpClientPool();
    const wrapper = mcpToolToAgentTool('demo', {
      name: 'echo',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What to echo' },
          count: { type: 'number' }
        },
        required: ['message']
      }
    }, pool);
    expect(wrapper.parameters).toHaveLength(2);
    const messageParam = wrapper.parameters.find(p => p.name === 'message');
    expect(messageParam?.required).toBe(true);
    expect(messageParam?.description).toContain('What to echo');
    const countParam = wrapper.parameters.find(p => p.name === 'count');
    expect(countParam?.required).toBe(false);
  });

  it('returns a graceful ToolResult error when the server is unreachable instead of throwing', async () => {
    const pool = new McpClientPool();
    pool.register('broken', { command: '/nope/never', args: [] });
    const wrapper = mcpToolToAgentTool('broken', { name: 'noop' }, pool);
    const result = await wrapper.execute({}, { workspaceRoot: '/tmp' } as never);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/Error invoking/);
  });
});

describe('loadMcpServersConfig', () => {
  it('returns empty record when no config files exist', async () => {
    const cfg = await loadMcpServersConfig(workspace);
    expect(cfg).toEqual({});
  });

  it('parses workspace .bandit/mcp-servers.json', async () => {
    const banditDir = path.join(workspace, '.bandit');
    fs.mkdirSync(banditDir, { recursive: true });
    fs.writeFileSync(
      path.join(banditDir, 'mcp-servers.json'),
      JSON.stringify({
        mcpServers: {
          local: { command: 'node', args: ['./server.js'] }
        }
      })
    );
    const cfg = await loadMcpServersConfig(workspace);
    expect(cfg).toHaveProperty('local');
    expect(cfg.local.command).toBe('node');
    expect(cfg.local.args).toEqual(['./server.js']);
  });

  it('skips entries without a command field (defensive against truncated JSON)', async () => {
    const banditDir = path.join(workspace, '.bandit');
    fs.mkdirSync(banditDir, { recursive: true });
    fs.writeFileSync(
      path.join(banditDir, 'mcp-servers.json'),
      JSON.stringify({
        mcpServers: {
          good: { command: 'echo', args: [] },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          bogus: ({ args: ['no-command'] } as any)
        }
      })
    );
    const cfg = await loadMcpServersConfig(workspace);
    expect(cfg.good).toBeDefined();
    expect(cfg.bogus).toBeUndefined();
  });

  it('returns empty record when JSON is malformed (never throws)', async () => {
    const banditDir = path.join(workspace, '.bandit');
    fs.mkdirSync(banditDir, { recursive: true });
    fs.writeFileSync(path.join(banditDir, 'mcp-servers.json'), '{ not valid json');
    await expect(loadMcpServersConfig(workspace)).resolves.toEqual({});
  });
});

describe('registerMcpServersFromDisk', () => {
  it('returns 0 and registers nothing when no config exists', async () => {
    const pool = new McpClientPool();
    const count = await registerMcpServersFromDisk(workspace, pool);
    expect(count).toBe(0);
    expect(pool.list()).toEqual([]);
  });

  it('registers each entry found in the workspace config', async () => {
    const banditDir = path.join(workspace, '.bandit');
    fs.mkdirSync(banditDir, { recursive: true });
    fs.writeFileSync(
      path.join(banditDir, 'mcp-servers.json'),
      JSON.stringify({
        mcpServers: {
          alpha: { command: 'a' },
          beta: { command: 'b', args: ['x'] }
        }
      })
    );
    const pool = new McpClientPool();
    const count = await registerMcpServersFromDisk(workspace, pool);
    expect(count).toBe(2);
    expect(pool.list().sort()).toEqual(['alpha', 'beta']);
    // None should have been spawned — registration is lazy.
    for (const snap of pool.snapshot()) {
      expect(snap.status.state).toBe('idle');
    }
  });
});

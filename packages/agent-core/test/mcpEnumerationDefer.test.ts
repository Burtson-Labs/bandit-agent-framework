/**
 * Contract: getAllMcpAgentTools defers the FIRST-TIME spawn for
 * `always`-mode servers until the user's prompt mentions the server
 * (or one of its triggers). Without this gate, every "hi" triggers
 * a spawn → trust prompt for any configured MCP server — exactly
 * the bug v1.7.313 fixes.
 *
 * We assert against the pool's `snapshot` status: skipped enumeration
 * leaves the server's status at `idle`. A real spawn would move it
 * to `connecting` (and shortly `error` here because we don't load
 * the MCP SDK in tests).
 */
import { describe, expect, it } from 'vitest';
import {
  McpClientPool,
  getAllMcpAgentTools,
  fingerprintServerConfig
} from '../src/index';
import type { McpServerConfig } from '../src/index';

const SLACK_CFG: McpServerConfig = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-slack'],
  env: { SLACK_BOT_TOKEN: 'xoxb-1' }
};

describe('getAllMcpAgentTools first-time-spawn defer', () => {
  it('skips enumeration when no cache and prompt does NOT mention the server', async () => {
    const pool = new McpClientPool();
    pool.register('slack', SLACK_CFG);

    const tools = await getAllMcpAgentTools(pool, 'who are you?');
    expect(tools).toEqual([]);

    // The pool was NOT touched — status stays idle, never spawned.
    const snap = pool.snapshot().find((s) => s.name === 'slack');
    expect(snap?.status.state).toBe('idle');
  });

  it('enumerates from cache without spawning when cache exists', async () => {
    const pool = new McpClientPool();
    pool.register('slack', SLACK_CFG);
    const fp = fingerprintServerConfig('slack', SLACK_CFG);
    pool.primeDiscoveryCache('slack', fp, [
      { name: 'post_message', description: 'send a slack message' }
    ]);

    // Even with an unrelated prompt, cached enumeration is free.
    const tools = await getAllMcpAgentTools(pool, 'who are you?');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('slack.post_message');

    const snap = pool.snapshot().find((s) => s.name === 'slack');
    expect(snap?.status.state).toBe('idle');
  });

  it('attempts enumeration when prompt mentions the server name', async () => {
    const pool = new McpClientPool();
    pool.register('slack', SLACK_CFG);

    // No cache, but the prompt names the server — we should TRY to
    // enumerate (which will hit the spawn path; in tests it errors
    // out because the SDK isn't loaded, but the important thing is
    // the gate let us through).
    const tools = await getAllMcpAgentTools(pool, 'post a message in slack');
    expect(tools).toEqual([]); // spawn fails in test env, returns []

    const snap = pool.snapshot().find((s) => s.name === 'slack');
    // After attempted spawn the status moves OFF idle.
    expect(snap?.status.state).not.toBe('idle');
  }, 10000);

  it('attempts enumeration when prompt mentions a derived trigger (gmail → "email")', async () => {
    const pool = new McpClientPool();
    pool.register('gmail', { command: 'npx', args: ['x'] });

    const tools = await getAllMcpAgentTools(pool, 'send an email to the team');
    expect(tools).toEqual([]); // spawn fails in test env

    const snap = pool.snapshot().find((s) => s.name === 'gmail');
    expect(snap?.status.state).not.toBe('idle');
  }, 10000);

  it('disabled servers are skipped entirely regardless of prompt', async () => {
    const pool = new McpClientPool();
    pool.register('slack', { ...SLACK_CFG, disabled: true });

    const tools = await getAllMcpAgentTools(pool, 'post in slack right now');
    expect(tools).toEqual([]);

    const snap = pool.snapshot().find((s) => s.name === 'slack');
    expect(snap?.status.state).toBe('disabled');
  });
});

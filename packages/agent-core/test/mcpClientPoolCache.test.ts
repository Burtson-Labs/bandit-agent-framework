/**
 * Contract: McpClientPool's tool-list cache short-circuits enumeration
 * without spawning the child process. This is what stops the trust
 * gate from firing on every first message in a session (the agent
 * loop's per-turn registry build calls discoverTools to know what
 * tools each server exposes — until v1.7.311 that call always spawned).
 *
 * We don't actually spawn anything in these tests. We assert the
 * observable behavior:
 *   - primeDiscoveryCache + discoverTools returns the primed list
 *     while leaving server status as 'idle' (= never spawned).
 *   - primeDiscoveryCache with a mismatched fingerprint is ignored
 *     (config drift case — we MUST re-spawn to learn the new shape).
 */
import { describe, expect, it } from 'vitest';
import { McpClientPool, fingerprintServerConfig } from '../src/index';
import type { McpServerConfig } from '../src/index';

const SLACK_CFG: McpServerConfig = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-slack'],
  env: { SLACK_BOT_TOKEN: 'xoxb-1' }
};

describe('McpClientPool tool-list cache', () => {
  it('primeDiscoveryCache populates the cache when the fingerprint matches', async () => {
    const pool = new McpClientPool();
    pool.register('slack', SLACK_CFG);
    const fp = fingerprintServerConfig('slack', SLACK_CFG);

    pool.primeDiscoveryCache('slack', fp, [
      { name: 'post_message', description: 'send a slack message' }
    ]);

    const tools = await pool.discoverTools('slack');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('post_message');

    // Status MUST remain 'idle' — we returned the cached list without
    // spawning. If it transitioned to 'connecting'/'connected'/'error',
    // we spawned a child process and the whole point of the cache
    // (skipping the trust gate on enumeration) is defeated.
    const snap = pool.snapshot().find((s) => s.name === 'slack');
    expect(snap?.status.state).toBe('idle');
  });

  it('primeDiscoveryCache is silently dropped when the fingerprint mismatches', async () => {
    const pool = new McpClientPool();
    pool.register('slack', SLACK_CFG);

    // Wrong fingerprint — simulates a stale disk cache after the user
    // rotated SLACK_BOT_TOKEN (env changes the fingerprint).
    pool.primeDiscoveryCache('slack', 'fp-from-old-config', [
      { name: 'stale_tool', description: 'should be ignored' }
    ]);

    // discoverTools would now try to spawn (we have no SDK loaded —
    // expect [] from the error path, NOT the stale cached entry).
    const tools = await pool.discoverTools('slack');
    expect(tools.find((t) => t.name === 'stale_tool')).toBeUndefined();
  });

  it('primeDiscoveryCache for an unregistered server is a no-op', async () => {
    const pool = new McpClientPool();
    // No register() — should not throw.
    expect(() => pool.primeDiscoveryCache('ghost', 'fp', [{ name: 'x' }])).not.toThrow();
    expect(await pool.discoverTools('ghost')).toEqual([]);
  });

  it('discoverTools returns the cached list on every call (idempotent, never spawns)', async () => {
    const pool = new McpClientPool();
    pool.register('slack', SLACK_CFG);
    const fp = fingerprintServerConfig('slack', SLACK_CFG);
    pool.primeDiscoveryCache('slack', fp, [{ name: 'post_message' }]);

    const first = await pool.discoverTools('slack');
    const second = await pool.discoverTools('slack');
    const third = await pool.discoverTools('slack');
    expect(first).toEqual(second);
    expect(second).toEqual(third);

    // Status never moved off idle across three enumerations.
    const snap = pool.snapshot().find((s) => s.name === 'slack');
    expect(snap?.status.state).toBe('idle');
  });

  it('hasCachedTools reflects the cache state', () => {
    const pool = new McpClientPool();
    pool.register('slack', SLACK_CFG);
    expect(pool.hasCachedTools('slack')).toBe(false);
    expect(pool.hasCachedTools('unknown')).toBe(false);

    const fp = fingerprintServerConfig('slack', SLACK_CFG);
    pool.primeDiscoveryCache('slack', fp, [{ name: 'post_message' }]);
    expect(pool.hasCachedTools('slack')).toBe(true);

    // Empty tool list still counts as uncached — there'd be nothing
    // to short-circuit on (and we DO want to re-discover in case
    // the server's tool list grew).
    pool.register('gmail', { command: 'npx', args: ['x'] });
    const fp2 = fingerprintServerConfig('gmail', { command: 'npx', args: ['x'] });
    pool.primeDiscoveryCache('gmail', fp2, []);
    expect(pool.hasCachedTools('gmail')).toBe(false);
  });
});

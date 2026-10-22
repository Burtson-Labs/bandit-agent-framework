/**
 * The Bandit Cloud key goes only to MCP servers that opt in, and
 * `"local": true` on a stdio entry is what marks a server local for the
 * permission defaults.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadMcpServersConfig } from '../src/mcp';
import { evaluatePermission, emptyPolicy } from '../src/permissions';

let home: string;
let ws: string;
const realHome = process.env.HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-mcp-home-'));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-mcp-ws-'));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, '.bandit'));
  fs.writeFileSync(path.join(home, '.bandit', 'config.json'), JSON.stringify({ bandit: { apiKey: 'bai_test_not_real' } }));
});
afterEach(() => {
  process.env.HOME = realHome;
});

function writeServers(servers: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, '.bandit', 'mcp-servers.json'), JSON.stringify({ mcpServers: servers }));
}

describe('BANDIT_API_KEY injection', () => {
  it('is given only to servers that opt in', async () => {
    writeServers({
      thirdparty: { command: 'npx', args: ['-y', '@someone/server-x'] },
      optedin: { command: 'node', args: ['srv.js'], auth: 'bandit' },
      explicit: { command: 'node', args: ['srv.js'], auth: { type: 'bandit-api-key' } },
      'burtson-labs': { command: 'node', args: ['/x/dist/index.js'] },
      firstparty: { command: 'npx', args: ['-y', '@burtson-labs/mcp-server'] },
      pinned: { command: 'node', args: ['a.js'], auth: 'bandit', env: { BANDIT_API_KEY: 'own' } }
    });
    const cfg = await loadMcpServersConfig(ws);
    expect(cfg.thirdparty.env?.BANDIT_API_KEY).toBeUndefined();
    expect(cfg.optedin.env?.BANDIT_API_KEY).toBe('bai_test_not_real');
    expect(cfg.explicit.env?.BANDIT_API_KEY).toBe('bai_test_not_real');
    expect(cfg['burtson-labs'].env?.BANDIT_API_KEY).toBe('bai_test_not_real');
    expect(cfg.firstparty.env?.BANDIT_API_KEY).toBe('bai_test_not_real');
    expect(cfg.pinned.env?.BANDIT_API_KEY).toBe('own');
  });
});

describe('"local": true', () => {
  it('marks a stdio server local for the permission defaults; a URL server never is', async () => {
    writeServers({
      notes: { command: 'node', args: ['notes.js'], local: true },
      remote: { url: 'https://mcp.example/mcp', local: true },
      plain: { command: 'node', args: ['p.js'] }
    });
    await loadMcpServersConfig(ws);
    expect(evaluatePermission('notes.listNotes', '', emptyPolicy())).toBe('allow');
    expect(evaluatePermission('remote.listThings', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('plain.listThings', '', emptyPolicy())).toBe('ask');
  });
});

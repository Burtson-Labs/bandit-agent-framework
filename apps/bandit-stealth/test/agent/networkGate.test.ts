/**
 * Network tools in the extension's gate, with the real host-kit policy:
 * they ask in the default `ask` mode, the card names the exact destination,
 * and offline mode refuses them before any card or hook.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { ConversationEntry } from '../../src/services/conversationTypes';
import { TurnState } from '../../src/agent/turnState';

const mode = vi.hoisted(() => ({ permission: 'ask', offline: false }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, d?: T) => (key === 'agent.permissionMode' ? (mode.permission as unknown as T) : d)
    })
  }
}));

vi.mock('../../src/helpers/offlineMode', () => ({
  extensionOfflineMode: () => (mode.offline ? { offline: true, source: 'env', detail: 'BANDIT_OFFLINE=1' } : { offline: false })
}));

import { AutoApprovalLedger, SessionPermissionStore, type HookSettings } from '@burtson-labs/host-kit';
import { buildBeforeToolExecute, type BeforeToolExecuteDeps } from '../../src/agent/beforeToolExecute';
import { redactRemoteUrl } from '../../src/agent/networkDestination';
import type { PermissionGateService } from '../../src/provider/services/permissionGateService';

type Req = { tool: string; primary: string; warning?: string };

function setup(workspaceRoot = '/tmp/ws-none') {
  const requests: Req[] = [];
  const gate = {
    request: async (r: Req) => { requests.push(r); return { choice: 'deny' as const }; }
  } as unknown as PermissionGateService;
  const entry: ConversationEntry = { id: 'a', role: 'assistant', content: '', timestamp: 0, payload: '' };
  const deps: BeforeToolExecuteDeps = {
    state: new TurnState(entry),
    assistantEntry: entry,
    permissionGate: gate,
    permissionStore: new SessionPermissionStore(),
    hookSettings: { permissions: { allow: [], deny: [], ask: [] } } as unknown as HookSettings,
    workspaceRoot,
    userGoal: 'x',
    turnLog: null,
    notifyUser: vi.fn(),
    autoLedger: new AutoApprovalLedger()
  };
  return { before: buildBeforeToolExecute(deps), requests };
}

beforeEach(() => {
  mode.permission = 'ask';
  mode.offline = false;
});

describe('network tools in the extension gate', () => {
  it('web_fetch asks and the card shows the full URL', async () => {
    const { before, requests } = setup();
    const r = await before({ name: 'web_fetch', params: { url: 'https://example.com/?leak=SECRET_PROJECT_NAME' } });
    expect(r.allow).toBe(false); // denied on the card
    expect(requests).toHaveLength(1);
    expect(requests[0].warning).toContain('https://example.com/?leak=SECRET_PROJECT_NAME');
  });

  it('fetch_image, web_search and publish_artifact ask too', async () => {
    for (const [name, params] of [
      ['fetch_image', { url: 'https://img.example/a.png' }],
      ['web_search', { query: 'secret thing' }],
      ['publish_artifact', { path: 'README.md' }]
    ] as const) {
      const { before, requests } = setup();
      await before({ name, params: { ...params } });
      expect(requests, name).toHaveLength(1);
    }
  });

  it('git_push shows the resolved remote URL, with credentials removed', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-gitgate-'));
    execFileSync('git', ['init', '-q'], { cwd: ws });
    execFileSync('git', ['remote', 'add', 'origin', 'https://user:tok123@git.example/acme/repo.git'], { cwd: ws });
    const { before, requests } = setup(ws);
    await before({ name: 'git_push', params: { set_upstream: 'true' } });
    expect(requests).toHaveLength(1);
    expect(requests[0].warning).toContain('origin (https://user:***@git.example/acme/repo.git)');
    expect(requests[0].warning).not.toContain('tok123');
    expect(requests[0].primary).toBe('https://user:***@git.example/acme/repo.git');
  });

  it('plan mode denies network tools without a card', async () => {
    mode.permission = 'plan';
    const { before, requests } = setup();
    const r = await before({ name: 'fetch_image', params: { url: 'https://img.example/a.png' } });
    expect(r.allow).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('offline mode refuses network tools with a clear message and no card', async () => {
    mode.offline = true;
    for (const name of ['web_fetch', 'git_push', 'publish_artifact', 'someserver.fetch_url']) {
      const { before, requests } = setup();
      const r = await before({ name, params: { url: 'https://example.com' } });
      expect(r, name).toMatchObject({ allow: false });
      expect((r as { reason: string }).reason).toMatch(/^Bandit is in offline mode \(BANDIT_OFFLINE=1\)/);
      expect(requests).toHaveLength(0);
    }
  });

  it('auto mode keeps working for local reads', async () => {
    mode.permission = 'auto';
    const { before, requests } = setup();
    expect(await before({ name: 'read_file', params: { path: 'a.ts' } })).toEqual({ allow: true });
    expect(requests).toHaveLength(0);
  });
});

describe('redactRemoteUrl', () => {
  it('hides tokens and keeps scp-style remotes', () => {
    expect(redactRemoteUrl('https://x-access-token:ghp_abc@github.com/a/b.git')).toBe('https://x-access-token:***@github.com/a/b.git');
    expect(redactRemoteUrl('https://ghp_abc@github.com/a/b.git')).toBe('https://***@github.com/a/b.git');
    expect(redactRemoteUrl('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
  });
});

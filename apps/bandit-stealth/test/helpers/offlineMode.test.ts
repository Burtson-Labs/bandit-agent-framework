/**
 * The extension's offline switch: the setting, BANDIT_OFFLINE, the settings
 * files and the machine policy all turn it on; none can turn it off.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const cfg = vi.hoisted(() => ({ offline: false }));
vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: <T>(k: string, d?: T) => (k === 'offline' ? (cfg.offline as unknown as T) : d) })
  }
}));

import { extensionOfflineMode, offlineRefusal } from '../../src/helpers/offlineMode';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-ext-offline-'));
const base = () => ({ env: {}, homeDir: tmp(), policyFile: null as string | null });

describe('extensionOfflineMode', () => {
  it('is off by default', () => {
    expect(extensionOfflineMode(base()).offline).toBe(false);
  });

  it('the banditStealth.offline setting turns it on', () => {
    cfg.offline = true;
    const m = extensionOfflineMode(base());
    cfg.offline = false;
    expect(m).toMatchObject({ offline: true, source: 'settings', detail: 'banditStealth.offline' });
    expect(offlineRefusal('web_fetch', m)).toContain('offline mode (banditStealth.offline)');
  });

  it('BANDIT_OFFLINE=1 turns it on', () => {
    expect(extensionOfflineMode({ ...base(), env: { BANDIT_OFFLINE: '1' } })).toMatchObject({ offline: true, source: 'env' });
  });

  it('"offline": true in a workspace or home settings file turns it on', () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, '.bandit'));
    fs.writeFileSync(path.join(ws, '.bandit', 'settings.json'), JSON.stringify({ offline: true }));
    expect(extensionOfflineMode({ ...base(), workspaceRoot: ws }).offline).toBe(true);
    const home = tmp();
    fs.mkdirSync(path.join(home, '.bandit'));
    fs.writeFileSync(path.join(home, '.bandit', 'settings.json'), JSON.stringify({ offline: true }));
    expect(extensionOfflineMode({ ...base(), homeDir: home }).offline).toBe(true);
  });

  it('the machine policy turns it on and BANDIT_OFFLINE=0 does not turn it off', () => {
    const dir = tmp();
    const file = path.join(dir, 'policy.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, network: { offline: true } }));
    expect(extensionOfflineMode({ ...base(), env: { BANDIT_OFFLINE: '0' }, policyFile: file })).toMatchObject({ offline: true, source: 'policy' });
  });
});

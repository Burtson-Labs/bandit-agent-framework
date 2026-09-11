import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: { getConfiguration: () => fakeConfiguration }
}));

import * as vscode from 'vscode';
import {
  migrateSettingSecrets,
  readMigratedSecret,
  MIGRATED_SECRETS
} from '../../src/helpers/secretMigration';

/** Minimal stand-in for vscode.WorkspaceConfiguration with per-target values. */
interface Scoped { global?: string; workspace?: string; workspaceFolder?: string }

let scopes: Map<string, Scoped>;
let updates: Array<{ key: string; value: unknown; target: number }>;

const fakeConfiguration = {
  get<T>(key: string, fallback?: T): T {
    const s = scopes.get(key);
    // VS Code resolution order: folder > workspace > user.
    const effective = s?.workspaceFolder ?? s?.workspace ?? s?.global;
    return ((effective ?? fallback) as unknown) as T;
  },
  inspect<T>(key: string) {
    const s = scopes.get(key);
    return {
      globalValue: s?.global as T | undefined,
      workspaceValue: s?.workspace as T | undefined,
      workspaceFolderValue: s?.workspaceFolder as T | undefined
    };
  },
  update(key: string, value: unknown, target: number) {
    updates.push({ key, value, target });
    const s = scopes.get(key);
    if (!s) {return Promise.resolve();}
    if (target === 1) {delete s.global;}
    if (target === 2) {delete s.workspace;}
    if (target === 3) {delete s.workspaceFolder;}
    return Promise.resolve();
  }
} as unknown as vscode.WorkspaceConfiguration;

function makeSecrets(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    api: {
      get: vi.fn(async (k: string) => store.get(k)),
      store: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
      delete: vi.fn(async (k: string) => { store.delete(k); })
    } as unknown as vscode.SecretStorage
  };
}

function makeContext(secrets: vscode.SecretStorage) {
  return { secrets } as unknown as vscode.ExtensionContext;
}

beforeEach(() => {
  scopes = new Map();
  updates = [];
});

describe('migrateSettingSecrets', () => {
  it('moves a plaintext key into SecretStorage and clears the setting', async () => {
    scopes.set('openaiApiKey', { global: 'sk-plaintext-123' });
    const { store, api } = makeSecrets();

    const migrated = await migrateSettingSecrets(makeContext(api), fakeConfiguration);

    expect(migrated).toEqual(['openaiApiKey']);
    expect(store.get('banditStealth.openaiApiKey')).toBe('sk-plaintext-123');
    // Cleared by writing undefined to the target that held it.
    expect(updates).toEqual([{ key: 'openaiApiKey', value: undefined, target: 1 }]);
    expect(fakeConfiguration.get<string>('openaiApiKey', '')).toBe('');
  });

  it('is a no-op when nothing is stored in plaintext', async () => {
    const { store, api } = makeSecrets();

    const migrated = await migrateSettingSecrets(makeContext(api), fakeConfiguration);

    expect(migrated).toEqual([]);
    expect(store.size).toBe(0);
    expect(updates).toEqual([]);
  });

  it('clears every scope that held a value, not just the effective one', async () => {
    // A key cleared from user settings but left in .vscode/settings.json is
    // still a key in a file that gets committed.
    scopes.set('voice.tts.apiKey', { global: 'from-user', workspace: 'from-workspace' });
    const { store, api } = makeSecrets();

    await migrateSettingSecrets(makeContext(api), fakeConfiguration);

    expect(updates.map((u) => u.target).sort()).toEqual([1, 2]);
    expect(scopes.get('voice.tts.apiKey')).toEqual({});
    // Workspace scope wins in VS Code's resolution order, so that's the value kept.
    expect(store.get('banditStealth.voice.tts.apiKey')).toBe('from-workspace');
  });

  it('keeps an existing secret and still clears the stale setting', async () => {
    scopes.set('webSearch.tavilyApiKey', { global: 'stale-synced-value' });
    const { store, api } = makeSecrets({ 'banditStealth.webSearch.tavilyApiKey': 'current-key' });

    await migrateSettingSecrets(makeContext(api), fakeConfiguration);

    expect(store.get('banditStealth.webSearch.tavilyApiKey')).toBe('current-key');
    expect(updates).toHaveLength(1);
  });

  it('ignores whitespace-only settings rather than storing a blank secret', async () => {
    scopes.set('openaiApiKey', { global: '   ' });
    const { store, api } = makeSecrets();

    const migrated = await migrateSettingSecrets(makeContext(api), fakeConfiguration);

    expect(migrated).toEqual([]);
    expect(store.size).toBe(0);
  });

  it('does not throw when SecretStorage is unavailable', async () => {
    scopes.set('openaiApiKey', { global: 'sk-plaintext-123' });
    const failing = {
      get: vi.fn(async () => { throw new Error('keychain locked'); }),
      store: vi.fn(async () => { throw new Error('keychain locked'); }),
      delete: vi.fn()
    } as unknown as vscode.SecretStorage;

    await expect(migrateSettingSecrets(makeContext(failing), fakeConfiguration)).resolves.toEqual([]);
    // The key stays where it was so the feature keeps working.
    expect(fakeConfiguration.get<string>('openaiApiKey', '')).toBe('sk-plaintext-123');
  });

  it('covers every key that used to be a plaintext setting', async () => {
    expect(MIGRATED_SECRETS.map((m) => m.setting)).toEqual([
      'openaiApiKey',
      'voice.stt.apiKey',
      'voice.tts.apiKey',
      'webSearch.tavilyApiKey'
    ]);
    // The secret name must match the setting id it replaces.
    for (const { setting, secret } of MIGRATED_SECRETS) {
      expect(secret).toBe(`banditStealth.${setting}`);
    }
  });
});

describe('readMigratedSecret', () => {
  it('prefers the stored secret', async () => {
    scopes.set('openaiApiKey', { global: 'from-setting' });
    const { api } = makeSecrets({ 'banditStealth.openaiApiKey': 'from-keychain' });

    const value = await readMigratedSecret(api, 'banditStealth.openaiApiKey', fakeConfiguration, 'openaiApiKey');

    expect(value).toBe('from-keychain');
  });

  it('falls back to the legacy setting before migration has run', async () => {
    scopes.set('openaiApiKey', { global: 'from-setting' });
    const { api } = makeSecrets();

    const value = await readMigratedSecret(api, 'banditStealth.openaiApiKey', fakeConfiguration, 'openaiApiKey');

    expect(value).toBe('from-setting');
  });

  it('returns empty string when neither store has a value', async () => {
    const { api } = makeSecrets();

    const value = await readMigratedSecret(api, 'banditStealth.openaiApiKey', fakeConfiguration, 'openaiApiKey');

    expect(value).toBe('');
  });

  it('falls back to the setting when SecretStorage throws', async () => {
    scopes.set('openaiApiKey', { global: 'from-setting' });
    const failing = { get: vi.fn(async () => { throw new Error('keychain locked'); }) } as unknown as vscode.SecretStorage;

    const value = await readMigratedSecret(failing, 'banditStealth.openaiApiKey', fakeConfiguration, 'openaiApiKey');

    expect(value).toBe('from-setting');
  });
});

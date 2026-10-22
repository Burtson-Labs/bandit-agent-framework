/**
 * Offline mode: one switch, three sources (policy file, env, settings), any
 * one turns it on and none can turn it back off; a broken policy file fails
 * closed; the fetch guard refuses everything except loopback and the model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  installOfflineFetchGuard,
  isLoopbackHost,
  isPrivateOrLocalHost,
  machinePolicyPath,
  offlineMessage,
  readPolicyOffline,
  resolveOfflineMode,
  OfflineBlockedError
} from '../src/offline';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-offline-'));

describe('resolveOfflineMode', () => {
  it('is off by default', () => {
    expect(resolveOfflineMode({ env: {}, policyFile: null }).offline).toBe(false);
  });

  it('BANDIT_OFFLINE=1 turns it on', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      const m = resolveOfflineMode({ env: { BANDIT_OFFLINE: v }, policyFile: null });
      expect(m.offline, v).toBe(true);
      expect(m.source).toBe('env');
    }
    expect(resolveOfflineMode({ env: { BANDIT_OFFLINE: '0' }, policyFile: null }).offline).toBe(false);
  });

  it('settings turn it on', () => {
    const m = resolveOfflineMode({ env: {}, settingsOffline: true, policyFile: null });
    expect(m).toMatchObject({ offline: true, source: 'settings' });
  });

  it('the policy file turns it on and BANDIT_OFFLINE=0 cannot turn it off', () => {
    const dir = tmp();
    const file = path.join(dir, 'policy.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, network: { offline: true } }));
    const m = resolveOfflineMode({ env: { BANDIT_OFFLINE: '0' }, settingsOffline: false, policyFile: file });
    expect(m).toMatchObject({ offline: true, source: 'policy', detail: file });
  });

  it('a policy file without network.offline leaves it off', () => {
    const dir = tmp();
    const file = path.join(dir, 'policy.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, network: { allowedHosts: ['a.test'] } }));
    expect(resolveOfflineMode({ env: {}, policyFile: file }).offline).toBe(false);
    expect(readPolicyOffline(path.join(dir, 'missing.json'))).toEqual({ offline: false });
  });

  it('a broken policy file fails closed', () => {
    const dir = tmp();
    const file = path.join(dir, 'policy.json');
    fs.writeFileSync(file, '{ not json');
    const m = resolveOfflineMode({ env: {}, policyFile: file });
    expect(m.offline).toBe(true);
    expect(m.policyError).toMatch(/not valid JSON/);
    fs.writeFileSync(file, JSON.stringify({ network: { offline: 'yes' } }));
    expect(readPolicyOffline(file)).toMatchObject({ offline: true });
  });

  it('knows the machine policy paths', () => {
    expect(machinePolicyPath('linux')).toBe('/etc/bandit/policy.json');
    expect(machinePolicyPath('darwin')).toBe('/Library/Application Support/Bandit/policy.json');
    expect(machinePolicyPath('win32', { ProgramData: 'D:\\PD' })).toBe('D:\\PD\\Bandit\\policy.json');
  });

  it('says where the switch came from', () => {
    const m = resolveOfflineMode({ env: { BANDIT_OFFLINE: '1' }, policyFile: null });
    expect(offlineMessage(m, 'web_fetch')).toBe(
      'Bandit is in offline mode (BANDIT_OFFLINE=1): web_fetch is turned off. Offline mode allows connections only to the model server you configured.'
    );
  });
});

describe('host classification', () => {
  it('loopback', () => {
    for (const h of ['localhost', 'a.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['10.0.0.1', 'example.com', '192.168.1.5']) expect(isLoopbackHost(h), h).toBe(false);
  });

  it('private or local', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.51', '172.16.0.9', '169.254.1.1', '[fd00::1]', 'gpu-node', 'llm.local', 'vllm.cluster.internal', 'box.lan']) {
      expect(isPrivateOrLocalHost(h), h).toBe(true);
    }
    for (const h of ['api.openai.com', 'openrouter.ai', '8.8.8.8', 'models.dev']) expect(isPrivateOrLocalHost(h), h).toBe(false);
  });
});

describe('installOfflineFetchGuard', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('refuses other hosts, allows loopback and the model origin', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => { calls.push(String(input)); return new Response('ok'); }) as typeof fetch;
    const blocked: string[] = [];
    const uninstall = installOfflineFetchGuard({
      mode: { offline: true, source: 'env', detail: 'BANDIT_OFFLINE=1' },
      allowedOrigins: ['http://gpu-node:8000/v1'],
      onBlocked: (u) => blocked.push(u.host)
    });
    await expect(fetch('https://registry.npmjs.org/x')).rejects.toBeInstanceOf(OfflineBlockedError);
    await expect(fetch(new URL('https://models.dev/api.json'))).rejects.toThrow(/offline mode \(BANDIT_OFFLINE=1\): the connection to https:\/\/models\.dev is turned off/);
    await fetch('http://127.0.0.1:11434/api/tags');
    await fetch('http://gpu-node:8000/v1/chat/completions');
    expect(calls).toEqual(['http://127.0.0.1:11434/api/tags', 'http://gpu-node:8000/v1/chat/completions']);
    expect(blocked).toEqual(['registry.npmjs.org', 'models.dev']);
    uninstall();
    await fetch('https://registry.npmjs.org/x');
    expect(calls).toHaveLength(3);
  });

  it('is a no-op when offline mode is off', () => {
    const before = globalThis.fetch;
    installOfflineFetchGuard({ mode: { offline: false }, allowedOrigins: [] })();
    expect(globalThis.fetch).toBe(before);
  });
});

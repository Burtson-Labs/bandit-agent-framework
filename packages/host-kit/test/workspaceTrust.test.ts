/**
 * Workspace trust store — the decision that lets a repository's own
 * `.bandit/settings.json` run hooks and widen permissions. Pinned from the
 * attacker's side: nothing in a checkout may create trust, only the user's
 * file under ~/.bandit or the env var may.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isWorkspaceTrusted,
  trustWorkspace,
  untrustWorkspace,
  loadTrustedWorkspaces,
  rememberUserGrant,
  loadUserGrants,
  normalizeWorkspaceRoot,
  trustedWorkspacesPath,
  envTrustsProjectSettings,
  TRUST_PROJECT_SETTINGS_ENV
} from '../src/workspaceTrust';

let home: string;
let repo: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-kit-trust-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'host-kit-trust-repo-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

const opts = () => ({ homeDir: home, env: {} as Record<string, string | undefined> });

describe('isWorkspaceTrusted', () => {
  it('trusts nothing by default — a fresh clone is untrusted', async () => {
    expect(await isWorkspaceTrusted(repo, opts())).toBe(false);
    expect(await loadTrustedWorkspaces(opts())).toEqual([]);
  });

  it('ignores anything the checkout itself contains', async () => {
    // A repository cannot vouch for itself: files under the workspace never
    // count, only the user's file under ~/.bandit.
    fs.mkdirSync(path.join(repo, '.bandit'));
    fs.writeFileSync(path.join(repo, '.bandit', 'trusted-workspaces.json'), JSON.stringify({ trusted: [repo] }));
    expect(await isWorkspaceTrusted(repo, opts())).toBe(false);
  });

  it('trusts a folder after trustWorkspace, and its subfolders', async () => {
    await trustWorkspace(repo, opts());
    expect(await isWorkspaceTrusted(repo, opts())).toBe(true);
    const nested = path.join(repo, 'packages', 'a');
    fs.mkdirSync(nested, { recursive: true });
    expect(await isWorkspaceTrusted(nested, opts())).toBe(true);
    // A sibling whose name merely starts with the trusted one is not inside it.
    const sibling = fs.mkdtempSync(repo + '-other-');
    try {
      expect(await isWorkspaceTrusted(sibling, opts())).toBe(false);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('writes the trust file 0600 under ~/.bandit and does not duplicate entries', async () => {
    await trustWorkspace(repo, opts());
    await trustWorkspace(repo + path.sep, opts());
    const file = trustedWorkspacesPath(home);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { trusted: string[] };
    expect(parsed.trusted).toHaveLength(1);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('untrustWorkspace removes the exact entry only', async () => {
    await trustWorkspace(repo, opts());
    expect(await untrustWorkspace(repo, opts())).toBe(true);
    expect(await isWorkspaceTrusted(repo, opts())).toBe(false);
    expect(await untrustWorkspace(repo, opts())).toBe(false);
  });

  it(`${TRUST_PROJECT_SETTINGS_ENV}=1 trusts the current workspace for this process`, async () => {
    const env = { [TRUST_PROJECT_SETTINGS_ENV]: '1' };
    expect(envTrustsProjectSettings(env)).toBe(true);
    expect(envTrustsProjectSettings({ [TRUST_PROJECT_SETTINGS_ENV]: 'no' })).toBe(false);
    expect(await isWorkspaceTrusted(repo, { homeDir: home, env })).toBe(true);
    // Nothing is written: env trust is per process, not remembered.
    expect(fs.existsSync(trustedWorkspacesPath(home))).toBe(false);
  });

  it('survives a malformed trust file by trusting nothing', async () => {
    fs.mkdirSync(path.join(home, '.bandit'), { recursive: true });
    fs.writeFileSync(trustedWorkspacesPath(home), '{ nope');
    expect(await isWorkspaceTrusted(repo, opts())).toBe(false);
  });
});

describe('user grants', () => {
  it('remembers rules per exact folder, without duplicates', async () => {
    await rememberUserGrant(repo, 'run_command:npm test*', opts());
    await rememberUserGrant(repo, 'run_command:npm test*', opts());
    await rememberUserGrant(repo, 'write_file:docs/a.md', opts());
    expect(await loadUserGrants(repo, opts())).toEqual(['run_command:npm test*', 'write_file:docs/a.md']);
    const nested = path.join(repo, 'sub');
    fs.mkdirSync(nested);
    expect(await loadUserGrants(nested, opts())).toEqual([]);
  });

  it('does not make the folder trusted', async () => {
    await rememberUserGrant(repo, 'run_command:npm test*', opts());
    expect(await isWorkspaceTrusted(repo, opts())).toBe(false);
  });
});

describe('normalizeWorkspaceRoot', () => {
  it('gives one spelling per folder', () => {
    const a = normalizeWorkspaceRoot(repo);
    expect(normalizeWorkspaceRoot(repo + path.sep)).toBe(a);
    expect(normalizeWorkspaceRoot(path.join(repo, '.', 'x', '..'))).toBe(a);
  });
});

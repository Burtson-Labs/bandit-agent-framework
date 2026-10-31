/**
 * The trust commands: a modal confirmation that says what trusting enables,
 * no trust without a folder, none in VS Code's Restricted Mode, none on
 * cancel; untrust forgets the folder and says what still applies. Plus the
 * manifest contract: both commands are declared, the trust command is hidden
 * from the palette in Restricted Mode, and the extension declares that it
 * does not run in untrusted workspaces.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const vscodeMock = vi.hoisted(() => ({
  folders: [{ uri: { fsPath: '/work/acme-app' }, name: 'acme-app' }] as Array<{ uri: { fsPath: string }; name: string }> | undefined,
  isTrusted: true,
  warningChoice: undefined as string | undefined,
  warnings: [] as Array<{ message: string; options?: unknown; actions: string[] }>,
  infos: [] as string[]
}));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() { return vscodeMock.folders; },
    get isTrusted() { return vscodeMock.isTrusted; }
  },
  window: {
    showWarningMessage: vi.fn(async (message: string, ...rest: unknown[]) => {
      const options = rest[0] && typeof rest[0] === 'object' ? rest.shift() : undefined;
      vscodeMock.warnings.push({ message, options, actions: rest as string[] });
      return vscodeMock.warningChoice;
    }),
    showInformationMessage: vi.fn(async (message: string) => {
      vscodeMock.infos.push(message);
      return undefined;
    })
  },
  commands: { executeCommand: vi.fn() }
}));

const hostKitMock = vi.hoisted(() => ({
  trusted: false,
  trustWorkspace: vi.fn(async (root: string) => root),
  untrustWorkspace: vi.fn(async (_root: string) => true),
  loadHookSettings: vi.fn(async (_root: string) => ({
    hooks: { PreToolUse: [{ command: 'echo a' }], Stop: [{ command: 'echo b' }] },
    permissions: { allow: ['run_command:npm test*'], deny: [], ask: [], mode: 'auto' }
  }))
}));

vi.mock('@burtson-labs/host-kit', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    isWorkspaceTrusted: vi.fn(async () => hostKitMock.trusted),
    trustWorkspace: hostKitMock.trustWorkspace,
    untrustWorkspace: hostKitMock.untrustWorkspace,
    loadHookSettings: hostKitMock.loadHookSettings,
    trustedWorkspacesPath: () => '/home/acme/.bandit/trusted-workspaces.json'
  };
});

import { trustWorkspaceSettings, untrustWorkspaceSettings } from '../../src/commands/workspaceTrust';
import { TRUST_ACTION } from '../../src/helpers/workspaceTrust';

beforeEach(() => {
  vscodeMock.folders = [{ uri: { fsPath: '/work/acme-app' }, name: 'acme-app' }];
  vscodeMock.isTrusted = true;
  vscodeMock.warningChoice = undefined;
  vscodeMock.warnings.length = 0;
  vscodeMock.infos.length = 0;
  hostKitMock.trusted = false;
  hostKitMock.trustWorkspace.mockClear();
  hostKitMock.untrustWorkspace.mockClear();
  hostKitMock.loadHookSettings.mockClear();
});

describe('Trust this folder\'s .bandit settings', () => {
  it('asks with a modal that says hooks run as shell commands, and trusts only on confirm', async () => {
    vscodeMock.warningChoice = TRUST_ACTION;
    await trustWorkspaceSettings();
    expect(vscodeMock.warnings).toHaveLength(1);
    const [prompt] = vscodeMock.warnings;
    expect(prompt.message).toBe('Trust the .bandit settings in "acme-app"?');
    expect(prompt.options).toMatchObject({ modal: true });
    expect((prompt.options as { detail: string }).detail).toContain('hooks as shell commands on your machine');
    expect((prompt.options as { detail: string }).detail).toContain('/work/acme-app');
    expect(prompt.actions).toEqual([TRUST_ACTION]);
    expect(hostKitMock.trustWorkspace).toHaveBeenCalledWith('/work/acme-app');
    // Reloaded, and the user told what now applies.
    expect(hostKitMock.loadHookSettings).toHaveBeenCalledWith('/work/acme-app');
    expect(vscodeMock.infos).toEqual([
      'Bandit now trusts "acme-app". From your next message: 2 hooks, 1 allow rule, permission mode auto.'
    ]);
  });

  it('does nothing when the modal is cancelled', async () => {
    vscodeMock.warningChoice = undefined;
    await trustWorkspaceSettings();
    expect(vscodeMock.warnings).toHaveLength(1);
    expect(hostKitMock.trustWorkspace).not.toHaveBeenCalled();
    expect(vscodeMock.infos).toEqual([]);
  });

  it('refuses in VS Code\'s Restricted Mode without showing the modal', async () => {
    vscodeMock.isTrusted = false;
    vscodeMock.warningChoice = TRUST_ACTION;
    await trustWorkspaceSettings();
    expect(hostKitMock.trustWorkspace).not.toHaveBeenCalled();
    expect(vscodeMock.warnings).toHaveLength(1);
    expect(vscodeMock.warnings[0].options).toBeUndefined();
    expect(vscodeMock.warnings[0].message).toContain('Restricted Mode');
  });

  it('needs an open folder', async () => {
    vscodeMock.folders = undefined;
    vscodeMock.warningChoice = TRUST_ACTION;
    await trustWorkspaceSettings();
    expect(hostKitMock.trustWorkspace).not.toHaveBeenCalled();
    expect(vscodeMock.warnings[0].message).toContain('Open a folder first');
  });

  it('says so when the folder is already trusted, without a modal', async () => {
    hostKitMock.trusted = true;
    await trustWorkspaceSettings();
    expect(vscodeMock.warnings).toHaveLength(0);
    expect(hostKitMock.trustWorkspace).not.toHaveBeenCalled();
    expect(vscodeMock.infos[0]).toContain('already trusts "acme-app"');
  });
});

describe('Stop trusting this folder\'s .bandit settings', () => {
  it('forgets the folder and says what applies from the next message', async () => {
    await untrustWorkspaceSettings();
    expect(hostKitMock.untrustWorkspace).toHaveBeenCalledWith('/work/acme-app');
    expect(vscodeMock.infos).toEqual([
      'Bandit no longer trusts "acme-app". From your next message its .bandit settings can only narrow what Bandit does.'
    ]);
  });

  it('reports a folder that was not trusted', async () => {
    hostKitMock.untrustWorkspace.mockResolvedValueOnce(false);
    await untrustWorkspaceSettings();
    expect(vscodeMock.infos[0]).toBe('Bandit was not trusting "acme-app"; nothing changed.');
  });

  it('warns when a parent folder or the environment still trusts it', async () => {
    hostKitMock.untrustWorkspace.mockResolvedValueOnce(false);
    hostKitMock.trusted = true;
    await untrustWorkspaceSettings();
    expect(vscodeMock.infos).toEqual([]);
    expect(vscodeMock.warnings[0].message).toContain('still trusted through a parent folder or BANDIT_TRUST_PROJECT_SETTINGS');
    expect(vscodeMock.warnings[0].message).toContain('/home/acme/.bandit/trusted-workspaces.json');
  });
});

describe('manifest', () => {
  const root = path.resolve(__dirname, '..', '..');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    capabilities?: { untrustedWorkspaces?: { supported: boolean | string; description?: string } };
    contributes: {
      commands: Array<{ command: string; title: string }>;
      menus: Record<string, Array<{ command: string; when?: string }>>;
    };
  };
  const registerSource = readFileSync(path.join(root, 'src/commands/registerCommands.ts'), 'utf8');

  it('declares both commands with their titles and registers handlers for them', () => {
    const titles = new Map(pkg.contributes.commands.map((c) => [c.command, c.title]));
    expect(titles.get('banditStealth.trustWorkspaceSettings')).toBe('Trust this folder\'s .bandit settings');
    expect(titles.get('banditStealth.untrustWorkspaceSettings')).toBe('Stop trusting this folder\'s .bandit settings');
    expect(registerSource).toContain('TRUST_WORKSPACE_COMMAND');
    expect(registerSource).toContain('UNTRUST_WORKSPACE_COMMAND');
  });

  it('hides the trust command from the palette while VS Code has the workspace in Restricted Mode', () => {
    const palette = pkg.contributes.menus.commandPalette;
    const trust = palette.find((m) => m.command === 'banditStealth.trustWorkspaceSettings');
    expect(trust?.when).toContain('isWorkspaceTrusted');
    expect(palette.some((m) => m.command === 'banditStealth.untrustWorkspaceSettings')).toBe(true);
  });

  it('does not run in untrusted workspaces at all', () => {
    expect(pkg.capabilities?.untrustedWorkspaces?.supported).toBe(false);
    expect(pkg.capabilities?.untrustedWorkspaces?.description).toBeTruthy();
  });
});

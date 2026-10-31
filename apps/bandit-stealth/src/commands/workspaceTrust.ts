import * as path from 'path';
import * as vscode from 'vscode';
import {
  isWorkspaceTrusted,
  loadHookSettings,
  trustWorkspace,
  trustedWorkspacesPath,
  untrustWorkspace,
  type HookSettings
} from '@burtson-labs/host-kit';
import { TRUST_ACTION } from '../helpers/workspaceTrust';

/**
 * "Trust this folder's .bandit settings" and "Stop trusting …".
 *
 * Trust is what lets a folder's `.bandit/settings.json` run hooks as shell
 * commands on this machine, add allow rules and set a wider permission mode
 * (host-kit workspaceTrust.ts). It is remembered per folder in
 * `~/.bandit/trusted-workspaces.json`, shared with the CLI, and read again at
 * the start of every turn, so a change applies to the next message without a
 * reload. Trusting needs a modal confirmation that says what it enables, and
 * is refused while VS Code has the workspace in Restricted Mode: VS Code's own
 * trust decision comes first.
 */
function currentFolder(): { root: string; name: string } | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return undefined; }
  return { root: folder.uri.fsPath, name: folder.name || path.basename(folder.uri.fsPath) };
}

/** "3 hooks, 2 allow rules, permission mode auto" — what applies once trusted. */
function describeInEffect(settings: HookSettings | undefined): string | undefined {
  if (!settings) { return undefined; }
  const hooks = Object.values(settings.hooks ?? {}).reduce((n, rules) => n + (rules?.length ?? 0), 0);
  const allow = settings.permissions?.allow?.length ?? 0;
  const parts = [
    ...(hooks > 0 ? [`${hooks} hook${hooks === 1 ? '' : 's'}`] : []),
    ...(allow > 0 ? [`${allow} allow rule${allow === 1 ? '' : 's'}`] : []),
    ...(settings.permissions?.mode ? [`permission mode ${settings.permissions.mode}`] : [])
  ];
  return parts.length > 0 ? parts.join(', ') : undefined;
}

export async function trustWorkspaceSettings(): Promise<void> {
  const folder = currentFolder();
  if (!folder) {
    void vscode.window.showWarningMessage('Open a folder first. Bandit trusts .bandit settings per folder.');
    return;
  }
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(
      `VS Code has "${folder.name}" in Restricted Mode, so Bandit will not trust its .bandit settings. Trust the workspace in VS Code first (Manage Workspace Trust).`
    );
    return;
  }
  if (await isWorkspaceTrusted(folder.root)) {
    void vscode.window.showInformationMessage(`Bandit already trusts "${folder.name}": its .bandit settings apply in full.`);
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Trust the .bandit settings in "${folder.name}"?`,
    {
      modal: true,
      detail:
        'Bandit will run this folder\'s .bandit/settings.json hooks as shell commands on your machine, ' +
        'honour its permissions.allow rules (tool calls that skip the approval card) and its permissions.mode, ' +
        'wider modes included. Only trust a folder whose .bandit files you have read.\n\n' +
        `Folder: ${folder.root}`
    },
    TRUST_ACTION
  );
  if (choice !== TRUST_ACTION) { return; }
  await trustWorkspace(folder.root);
  // Settings are loaded afresh at the start of every turn; load them now to
  // tell the user what the folder's files put in effect.
  const inEffect = describeInEffect(await loadHookSettings(folder.root).catch(() => undefined));
  void vscode.window.showInformationMessage(
    inEffect
      ? `Bandit now trusts "${folder.name}". From your next message: ${inEffect}.`
      : `Bandit now trusts "${folder.name}". Its .bandit settings apply in full from your next message.`
  );
}

export async function untrustWorkspaceSettings(): Promise<void> {
  const folder = currentFolder();
  if (!folder) {
    void vscode.window.showWarningMessage('Open a folder first. Bandit trusts .bandit settings per folder.');
    return;
  }
  const removed = await untrustWorkspace(folder.root);
  if (await isWorkspaceTrusted(folder.root)) {
    void vscode.window.showWarningMessage(
      `"${folder.name}" is still trusted through a parent folder or BANDIT_TRUST_PROJECT_SETTINGS. Edit ${trustedWorkspacesPath()} to change that.`
    );
    return;
  }
  void vscode.window.showInformationMessage(
    removed
      ? `Bandit no longer trusts "${folder.name}". From your next message its .bandit settings can only narrow what Bandit does.`
      : `Bandit was not trusting "${folder.name}"; nothing changed.`
  );
}

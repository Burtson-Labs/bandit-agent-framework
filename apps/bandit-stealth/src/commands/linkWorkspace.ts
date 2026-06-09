import * as vscode from 'vscode';
import { GatewaySearchAdapter } from '@burtson-labs/stealth-core-runtime';
import { API_KEY_SECRET_KEY } from '../storageKeys';

export async function linkWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('banditStealth');
  const gatewayUrl = configuration.get<string>('gatewayUrl', '');
  if (!gatewayUrl) {
    void vscode.window.showWarningMessage('Set "banditStealth.gatewayUrl" in settings first.');
    return;
  }
  const apiKey = await context.secrets.get(API_KEY_SECRET_KEY);
  if (!apiKey) {
    void vscode.window.showWarningMessage('No API key set. Use "Bandit: Set API Key" first.');
    return;
  }
  const adapter = new GatewaySearchAdapter({ gatewayUrl, apiKey, workspaceId: '' });
  const workspaces = await adapter.listWorkspaces();
  if (!workspaces.length) {
    void vscode.window.showWarningMessage('No workspaces found on Gateway. Create one in Bandit Stealth Web first.');
    return;
  }
  const items = workspaces.map(w => ({
    label: w.name,
    description: w.repoFullName ?? w.id,
    id: w.id
  }));
  const selected = await vscode.window.showQuickPick(items, {
    title: 'Link Workspace to Gateway',
    placeHolder: 'Select the workspace that matches this repo'
  });
  if (!selected) {return;}
  await configuration.update('workspaceId', selected.id, vscode.ConfigurationTarget.Workspace);
  void vscode.window.showInformationMessage(
    `Workspace linked: "${selected.label}" (${selected.id}). Qdrant context is now active for this repo.`
  );
}

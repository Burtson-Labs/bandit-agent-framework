import * as vscode from 'vscode';
import { GatewaySearchAdapter } from '@burtson-labs/stealth-core-runtime';
import { API_KEY_SECRET_KEY } from '../storageKeys';

export async function indexRepo(context: vscode.ExtensionContext): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('banditStealth');
  const gatewayUrl = configuration.get<string>('gatewayUrl', '');
  const workspaceId = configuration.get<string>('workspaceId', '');
  if (!gatewayUrl || !workspaceId) {
    void vscode.window.showWarningMessage(
      'Run "Bandit: Link Workspace to Gateway" first to configure gatewayUrl and workspaceId.'
    );
    return;
  }
  const apiKey = await context.secrets.get(API_KEY_SECRET_KEY);
  if (!apiKey) {
    void vscode.window.showWarningMessage('No API key set. Use "Bandit: Set API Key" first.');
    return;
  }
  const adapter = new GatewaySearchAdapter({ gatewayUrl, apiKey, workspaceId });
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Bandit: Starting repo index…', cancellable: false },
    async () => {
      const ok = await adapter.triggerIndex(workspaceId);
      if (ok) {
        void vscode.window.showInformationMessage('Repo indexing started. Status will update in the status bar when complete.');
      } else {
        void vscode.window.showErrorMessage('Failed to trigger indexing. Check gateway logs.');
      }
    }
  );
}

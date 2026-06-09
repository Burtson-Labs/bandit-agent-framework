import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  clearModelBehaviorOverrides,
  registerModelBehaviorConfig
} from '@burtson-labs/stealth-core-runtime';

export function loadWorkspaceModelBehaviorProfiles(notify = false): void {
  clearModelBehaviorOverrides();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {return;}

  const configPath = path.join(workspaceRoot, '.bandit', 'model-profiles.json');
  if (!fs.existsSync(configPath)) {return;}

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    const message = `Bandit ignored .bandit/model-profiles.json: invalid JSON (${err instanceof Error ? err.message : String(err)})`;
    console.warn(message);
    void vscode.window.showWarningMessage(message);
    return;
  }

  const result = registerModelBehaviorConfig(parsed);
  if (result.errors.length > 0) {
    const message = `Bandit ignored .bandit/model-profiles.json: ${result.errors.join('; ')}`;
    console.warn(message);
    void vscode.window.showWarningMessage(message);
    return;
  }
  if (result.warnings.length > 0) {
    const message = `.bandit/model-profiles.json loaded with warnings: ${result.warnings.slice(0, 2).join('; ')}${result.warnings.length > 2 ? '...' : ''}`;
    console.warn(message);
    if (notify) {void vscode.window.showWarningMessage(`Bandit ${message}`);}
  } else if (notify) {
    void vscode.window.showInformationMessage(`Bandit loaded ${result.entries.length} model behavior profile override${result.entries.length === 1 ? '' : 's'}.`);
  }
}

export { clearModelBehaviorOverrides };

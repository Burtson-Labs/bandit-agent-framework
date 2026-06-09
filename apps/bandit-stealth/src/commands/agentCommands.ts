import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { getModelCapabilities } from '@burtson-labs/stealth-core-runtime';
import type { StealthAgentRuntime } from '../agent/agentRuntime';
import { environmentService } from '../agent/environmentService';
import type { BanditStealthViewProvider } from '../extension';

export async function startGoal(
  provider: BanditStealthViewProvider,
  runtimeController: StealthAgentRuntime,
  inputGoal?: string
): Promise<void> {
  let goal = typeof inputGoal === 'string' ? inputGoal.trim() : '';
  if (!goal) {
    goal = (await vscode.window.showInputBox({
      title: 'Agent Goal',
      prompt: 'Describe the goal to achieve'
    }))?.trim() ?? '';
  }
  if (!goal) {
    return;
  }
  const cfg = vscode.workspace.getConfiguration('banditStealth');
  const providerKind = cfg.get<string>('provider', 'bandit') === 'ollama' ? 'ollama' : 'bandit';
  const activeModelId = providerKind === 'ollama'
    ? (() => {
        const baseModel = (cfg.get<string>('ollamaModel', 'gemma3:12b') ?? 'gemma3:12b').trim();
        const agentModel = (cfg.get<string>('agentOllamaModel', '') ?? '').trim();
        if (agentModel) {
          return agentModel;
        }
        const autoRoute = cfg.get<boolean>('ollamaAutoRouteModels', true) !== false;
        if (!autoRoute) {
          return baseModel;
        }
        const codingModel = (cfg.get<string>('ollamaCodingModel', '') ?? '').trim();
        return codingModel || baseModel;
      })()
    : cfg.get<string>('model', 'bandit-core-1');
  const agentTier = getModelCapabilities(activeModelId).tier;

  // Opt-in: create an isolated git branch before the agent touches anything.
  if (cfg.get<boolean>('agent.createBranchBeforeRun', false)) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      const slug = goal
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      const branchName = `bandit/${slug || 'run'}`;
      const branchResult = spawnSync('git', ['checkout', '-b', branchName], {
        cwd: workspaceRoot,
        encoding: 'utf8'
      });
      if (branchResult.status === 0) {
        void vscode.window.showInformationMessage(`Bandit: created branch ${branchName}`);
      }
      // Non-zero exit = branch already exists or git unavailable — silently continue.
    }
  }

  const contextResult = await provider.buildContextBlock(goal, cfg).catch(() => undefined);
  void runtimeController.startGoal(goal, { modelTier: agentTier, contextBlock: contextResult?.formatted });
}

export function cancelGoal(runtimeController: StealthAgentRuntime): void {
  runtimeController.cancel();
  void environmentService.postToWebview({ type: 'agent:status', text: 'Goal cancelled', phase: 'error' });
}

export async function showReport(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceFolder) {
    void vscode.window.showWarningMessage('Open a workspace to view agent reports.');
    return;
  }
  const reportUri = vscode.Uri.joinPath(workspaceFolder, '.bandit', 'agent-report.json');
  try {
    const document = await vscode.workspace.openTextDocument(reportUri);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
  } catch {
    void vscode.window.showWarningMessage('No report found. Run an agent goal first.');
  }
}

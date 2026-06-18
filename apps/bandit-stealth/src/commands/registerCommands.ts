import * as vscode from 'vscode';
import type { StealthAgentRuntime } from '../agent/agentRuntime';
import type { BanditStealthViewProvider } from '../extension';
import { revealWithSelection } from './revealWithSelection';
import { switchModel } from './switchModel';
import { startGoal, cancelGoal, showReport } from './agentCommands';
import { testConnection } from './testConnection';
import { linkWorkspace } from './linkWorkspace';
import { indexRepo } from './indexRepo';
import { openInTerminal, toggleUseTerminal } from './terminal';
import { insightsCommand } from './insights';

export function registerCommands(
  context: vscode.ExtensionContext,
  provider: BanditStealthViewProvider,
  runtimeController: StealthAgentRuntime,
  updateStatusBarText: () => void
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('banditStealth.askBandit', () => revealWithSelection(provider)),
    vscode.commands.registerCommand('banditStealth.openChat', () => provider.reveal()),
    vscode.commands.registerCommand('banditStealth.setApiKey', () => provider.showApiKeyOverlay()),
    vscode.commands.registerCommand('banditStealth.resetApiKey', () => provider.clearApiKey()),
    vscode.commands.registerCommand('banditStealth.setOllamaAuthToken', () => provider.setOllamaAuthToken()),
    vscode.commands.registerCommand('banditStealth.clearOllamaAuthToken', () => provider.clearOllamaAuthToken()),
    vscode.commands.registerCommand('banditStealth.setTavilyKey', () => provider.setTavilyKey()),
    vscode.commands.registerCommand('banditStealth.clearTavilyKey', () => provider.clearTavilyKey()),
    vscode.commands.registerCommand('banditStealth.toggleMode', () => provider.toggleMode()),
    vscode.commands.registerCommand('banditStealth.traceViewer', () => provider.openTraceViewer()),
    vscode.commands.registerCommand('banditStealth.switchModel', () => switchModel(updateStatusBarText, context)),
    vscode.commands.registerCommand('banditStealth.agent.startGoal', (inputGoal?: string) =>
      startGoal(provider, runtimeController, inputGoal)
    ),
    vscode.commands.registerCommand('banditStealth.agent.cancel', () => cancelGoal(runtimeController)),
    vscode.commands.registerCommand('banditStealth.agent.showReport', () => showReport()),
    vscode.commands.registerCommand('banditStealth.testConnection', () => testConnection(context)),
    vscode.commands.registerCommand('banditStealth.linkWorkspace', () => linkWorkspace(context)),
    vscode.commands.registerCommand('banditStealth.indexRepo', () => indexRepo(context)),
    vscode.commands.registerCommand('banditStealth.openInTerminal', () => openInTerminal()),
    vscode.commands.registerCommand('banditStealth.toggleUseTerminal', () => toggleUseTerminal()),
    vscode.commands.registerCommand('banditStealth.insights', () => insightsCommand(provider))
  ];
}

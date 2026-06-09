import * as vscode from 'vscode';
import type { BanditStealthViewProvider } from '../extension';

export async function revealWithSelection(provider: BanditStealthViewProvider): Promise<void> {
  // Terminal-mode shortcut. When the user has flipped on
  // banditStealth.useTerminal, any "Ask Bandit" trigger — the
  // Activity Bar icon, the Alt+Shift+B keybinding, the editor
  // menu — opens the CLI in VS Code's integrated terminal instead
  // of the chat panel. Same pattern Claude Code uses for its
  // "Use Terminal" toggle.
  const useTerminal = vscode.workspace
    .getConfiguration('banditStealth')
    .get<boolean>('useTerminal', false);
  if (useTerminal) {
    await vscode.commands.executeCommand('banditStealth.openInTerminal');
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const selection = editor?.selection && !editor.selection.isEmpty
    ? editor.document.getText(editor.selection).trim()
    : '';

  await provider.reveal(selection || undefined);
}

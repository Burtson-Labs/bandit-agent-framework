import * as vscode from 'vscode';

// Claude Code has a "Use Terminal" setting that launches the CLI
// inside VS Code's integrated terminal. We do the same for users
// who prefer the terminal flow — they get the same agent runtime
// via our @burtson-labs/bandit-stealth-cli npm package.
export async function openInTerminal(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath;
  const existing = vscode.window.terminals.find(t => t.name === 'Bandit');
  const terminal = existing ?? vscode.window.createTerminal({
    name: 'Bandit',
    cwd,
    iconPath: new vscode.ThemeIcon('robot')
  });
  terminal.show();
  // Run the CLI. If it's not installed we show a helper message
  // with the install command. The CLI exits with its own friendly
  // error if Ollama isn't reachable / no model configured.
  terminal.sendText('command -v bandit >/dev/null 2>&1 && bandit || echo "Bandit CLI not found. Install with: npm install -g @burtson-labs/bandit-stealth-cli"', true);
}

export async function toggleUseTerminal(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('banditStealth');
  const current = configuration.get<boolean>('useTerminal', false);
  await configuration.update('useTerminal', !current, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    !current
      ? 'Bandit terminal mode ON — the Activity Bar icon opens the CLI. Toggle off to switch back to the chat panel.'
      : 'Bandit terminal mode OFF — the Activity Bar icon opens the chat panel.'
  );
}

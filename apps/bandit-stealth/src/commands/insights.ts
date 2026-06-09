import * as vscode from 'vscode';
import { writeInsightsReport } from '@burtson-labs/host-kit';
import type { BanditStealthViewProvider } from '../extension';

export async function insightsCommand(provider: BanditStealthViewProvider): Promise<void> {
  // Generate a fresh report (overwrites ~/.bandit/insights.html)
  // and open it in the user's default browser. Calls the model
  // the same way the CLI's `/insights` does — same provider
  // settings, same one-shot chat path, same shared callback
  // helper — so the AI summary section renders identically on
  // both surfaces. Wrapped in withProgress so the user sees a
  // notification while the AI summary is being generated (can
  // take up to 30s on cold starts) and gets an in-chat
  // confirmation when it lands.
  try {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const written = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Bandit: generating insights report…',
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: 'building AI summary' });
        const ai = await provider.buildInsightsAiCallbackForIde();
        progress.report({ message: 'writing HTML report' });
        return writeInsightsReport({ cwd, ai });
      }
    );
    await vscode.env.openExternal(vscode.Uri.file(written));
    // Chat-panel confirmation so the user has a durable record
    // (the toast auto-dismisses; chat history doesn't).
    await provider.appendAssistantMessage(
      `I created your insights report and opened it in your browser.\n\nReport saved to \`${written}\`.`
    );
    void vscode.window.showInformationMessage(`Bandit insights regenerated → ${written}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Insights failed: ${msg}`);
    try {
      await provider.appendAssistantMessage(`I tried to generate the insights report but it failed: ${msg}`);
    } catch { /* swallow — chat append is best-effort here */ }
  }
}

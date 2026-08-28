import * as vscode from 'vscode';
import { nextCycleMode, type PermissionMode } from '@burtson-labs/host-kit';

/**
 * Cycle the agent permission mode ask → auto → plan → ask — the extension's
 * equivalent of the CLI's shift+tab. Persists to workspace settings (falls
 * back to global when no folder is open) so the choice sticks across the
 * session; the config listener refreshes the status-bar chip. `dangerous` is
 * deliberately not reachable from this cycle — it stays a settings-only act.
 */
export async function cyclePermissionMode(updateStatusBarText: () => void): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('banditStealth');
  const current = (cfg.get<string>('agent.permissionMode', 'ask') ?? 'ask') as PermissionMode;
  const next = nextCycleMode(current);
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await cfg.update('agent.permissionMode', next, target);
  updateStatusBarText();
  const blurb = next === 'plan'
    ? 'Plan mode: read-only — Bandit presents a plan and makes no changes until you leave plan mode.'
    : next === 'auto'
      ? 'Auto mode: routine work runs without a card; destructive calls still ask.'
      : 'Ask mode: every non-allowlisted call shows a permission card.';
  void vscode.window.setStatusBarMessage(`Bandit · ${blurb}`, 4000);
}

/**
 * Workspace trust for a folder's `.bandit/` settings — the extension side of
 * host-kit's workspaceTrust.ts.
 *
 * host-kit loads `.bandit/settings.json` with the folder's hooks, allow rules
 * and any wider permission mode dropped until the user trusts the folder, and
 * reports what it dropped in `ignoredUntrusted`. Without a word from the
 * extension, a team whose repository ships intentional hooks would just see
 * them stop running. This module turns that report into one notice per folder
 * per window, naming the file and what was ignored, with "Trust this folder"
 * (which runs the trust command and its modal confirmation) and "Not now".
 *
 * Nothing here trusts a folder on its own: only the command does, after the
 * user confirms, and never while VS Code itself has the workspace in
 * Restricted Mode (commands/workspaceTrust.ts).
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { normalizeWorkspaceRoot, type HookSettings, type IgnoredUntrustedSetting } from '@burtson-labs/host-kit';

export const TRUST_WORKSPACE_COMMAND = 'banditStealth.trustWorkspaceSettings';
export const UNTRUST_WORKSPACE_COMMAND = 'banditStealth.untrustWorkspaceSettings';
export const TRUST_ACTION = 'Trust this folder';
export const NOT_NOW_ACTION = 'Not now';

/** "3 hooks, permissions.mode" — what one ignored file tried to widen. */
export function describeIgnored(entry: IgnoredUntrustedSetting): string {
  return entry.keys
    .map((key) => {
      if (key !== 'hooks') { return key; }
      const n = entry.hookCount ?? 0;
      return n > 0 ? `${n} hook${n === 1 ? '' : 's'}` : 'hooks';
    })
    .join(', ');
}

export interface UntrustedSettingsNotice {
  message: string;
  /** Absolute paths of the settings files that were partly ignored. */
  files: string[];
}

/** The notice for a loaded settings object, or null when nothing was ignored. */
export function buildUntrustedSettingsNotice(
  workspaceRoot: string,
  settings: Pick<HookSettings, 'ignoredUntrusted'>
): UntrustedSettingsNotice | null {
  const ignored = (settings.ignoredUntrusted ?? []).filter((entry) => entry.keys.length > 0);
  if (ignored.length === 0) { return null; }
  const folder = path.basename(workspaceRoot) || workspaceRoot;
  const rel = (file: string) => path.relative(workspaceRoot, file).split(path.sep).join('/') || file;
  const what = ignored.length === 1
    ? `${rel(ignored[0].file)} in "${folder}": ${describeIgnored(ignored[0])}`
    : `${ignored.map((entry) => `${rel(entry.file)} (${describeIgnored(entry)})`).join(' and ')} in "${folder}"`;
  return {
    files: ignored.map((entry) => entry.file),
    message: `Bandit ignored part of ${what}. Until you trust this folder, its .bandit settings can only narrow what Bandit does.`
  };
}

export interface UntrustedSettingsNotifierDeps {
  /** `vscode.workspace.isTrusted` — false while VS Code has the workspace in Restricted Mode. */
  editorTrusted: () => boolean;
  show: (message: string, ...actions: string[]) => Thenable<string | undefined>;
  /** Runs the trust command, modal confirmation included. */
  trust: () => Thenable<unknown>;
}

export interface UntrustedSettingsNotifier {
  /** Shows the notice for this folder once per window. Resolves to true when it was shown. */
  maybeNotify(workspaceRoot: string, settings: Pick<HookSettings, 'ignoredUntrusted'>): Promise<boolean>;
}

export function createUntrustedSettingsNotifier(deps: UntrustedSettingsNotifierDeps): UntrustedSettingsNotifier {
  const shown = new Set<string>();
  return {
    async maybeNotify(workspaceRoot, settings) {
      const notice = buildUntrustedSettingsNotice(workspaceRoot, settings);
      if (!notice) { return false; }
      const key = normalizeWorkspaceRoot(workspaceRoot);
      if (shown.has(key)) { return false; }
      shown.add(key);
      if (!deps.editorTrusted()) {
        // VS Code does not trust this workspace, so Bandit does not offer to.
        await deps.show(
          `${notice.message} VS Code has the workspace in Restricted Mode; trust it in VS Code before trusting its Bandit settings.`
        );
        return true;
      }
      const choice = await deps.show(notice.message, TRUST_ACTION, NOT_NOW_ACTION);
      if (choice === TRUST_ACTION) { await deps.trust(); }
      return true;
    }
  };
}

const notifier = createUntrustedSettingsNotifier({
  editorTrusted: () => vscode.workspace.isTrusted,
  show: (message, ...actions) => vscode.window.showWarningMessage(message, ...actions),
  trust: () => vscode.commands.executeCommand(TRUST_WORKSPACE_COMMAND)
});

/**
 * Called with the settings host-kit loaded for a turn. Fire-and-forget: the
 * turn does not wait for the notice, and a folder is mentioned once per window.
 */
export function notifyUntrustedWorkspaceSettings(workspaceRoot: string, settings: Pick<HookSettings, 'ignoredUntrusted'>): void {
  void notifier.maybeNotify(workspaceRoot, settings).catch(() => undefined);
}

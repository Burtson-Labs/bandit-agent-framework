/**
 * Offline mode for the extension.
 *
 * On when any of these says so (host-kit resolveOfflineMode):
 *   - the machine policy file (`network.offline: true`; a broken file fails closed),
 *   - `BANDIT_OFFLINE=1` in the environment VS Code was started with,
 *   - the `banditStealth.offline` setting,
 *   - `"offline": true` in `~/.bandit/settings.json` or the workspace's
 *     `.bandit/settings.json` / `.bandit/settings.local.json`.
 *
 * When on, the extension contacts only the configured model server: no
 * models.dev, no web/image/artifact tools, no Bandit Cloud features (provider,
 * account, usage, intent, feedback, voice, remote control, telemetry), no
 * cloud voice providers, no remote MCP servers, and network tools are refused
 * at the permission gate.
 *
 * The extension does NOT wrap globalThis.fetch: the VS Code extension host is
 * shared with other extensions, so each Bandit feature is gated here instead.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { offlineMessage, resolveOfflineMode, type OfflineMode } from '@burtson-labs/host-kit';

function settingsFileOffline(file: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { offline?: unknown };
    return parsed?.offline === true;
  } catch {
    return false;
  }
}

export interface ExtensionOfflineInput {
  /** `banditStealth.offline`. Read from the workspace configuration when omitted. */
  setting?: boolean;
  workspaceRoot?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /** Override the machine policy path (tests). `null` skips it. */
  policyFile?: string | null;
}

/** Resolve offline mode now (cheap: a few small synchronous file reads). */
export function extensionOfflineMode(input: ExtensionOfflineInput = {}): OfflineMode {
  const setting = input.setting
    ?? vscode.workspace.getConfiguration('banditStealth').get<boolean>('offline', false) === true;
  const root = input.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const home = input.homeDir ?? os.homedir();
  const files = [
    path.join(home, '.bandit', 'settings.json'),
    ...(root ? [path.join(root, '.bandit', 'settings.json'), path.join(root, '.bandit', 'settings.local.json')] : [])
  ];
  const fromFile = files.find(settingsFileOffline);
  return resolveOfflineMode({
    env: input.env ?? process.env,
    settingsOffline: setting || fromFile !== undefined,
    settingsDetail: setting ? 'banditStealth.offline' : fromFile ? `"offline": true in ${fromFile}` : undefined,
    ...(input.policyFile !== undefined ? { policyFile: input.policyFile } : {})
  });
}

export function isExtensionOffline(input?: ExtensionOfflineInput): boolean {
  return extensionOfflineMode(input).offline;
}

/** The refusal text for a feature that offline mode turns off. */
export function offlineRefusal(what: string, mode: OfflineMode = extensionOfflineMode()): string {
  return offlineMessage(mode, what);
}

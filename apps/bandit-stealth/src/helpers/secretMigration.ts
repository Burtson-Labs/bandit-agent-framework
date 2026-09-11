/**
 * One-time migration of API keys out of `settings.json` and into
 * SecretStorage (the OS keychain), plus the read helper every consumer
 * of those keys now goes through.
 *
 * Why: four keys were declared as plain `type: string` settings. A
 * workspace-scoped value lands in `.vscode/settings.json` — a file that
 * gets committed — and a user-scoped value rides Settings Sync across
 * machines in cleartext. The Bandit cloud key and the Ollama auth token
 * already used SecretStorage; these four were the holdouts.
 *
 * The migration is silent and idempotent: it runs on every activation and
 * is a no-op once the settings are empty. That is deliberately stronger
 * than a run-once flag — if a user (or a synced profile, or a committed
 * workspace file) puts a key back into settings.json later, the next
 * activation pulls it out again instead of leaving it sitting there.
 */
import * as vscode from 'vscode';
import {
  OPENAI_API_KEY_SECRET_KEY,
  VOICE_STT_API_KEY_SECRET_KEY,
  VOICE_TTS_API_KEY_SECRET_KEY,
  TAVILY_API_KEY_SECRET_KEY
} from '../storageKeys';

/** Setting id (relative to the `banditStealth` section) ↔ secret key. */
export interface MigratedSecret {
  setting: string;
  secret: string;
}

export const MIGRATED_SECRETS: readonly MigratedSecret[] = [
  { setting: 'openaiApiKey', secret: OPENAI_API_KEY_SECRET_KEY },
  { setting: 'voice.stt.apiKey', secret: VOICE_STT_API_KEY_SECRET_KEY },
  { setting: 'voice.tts.apiKey', secret: VOICE_TTS_API_KEY_SECRET_KEY },
  { setting: 'webSearch.tavilyApiKey', secret: TAVILY_API_KEY_SECRET_KEY }
];

/**
 * Read a key that now lives in SecretStorage, falling back to the legacy
 * plaintext setting.
 *
 * The fallback is not dead code. Migration is fire-and-forget on activate,
 * so an early read can land before it finishes; and a user who hand-edits
 * settings.json mid-session should still get a working key rather than a
 * confusing "not configured" until the next reload. Once the migration has
 * run the setting is empty and this reads the keychain.
 */
export async function readMigratedSecret(
  secrets: vscode.SecretStorage,
  secretKey: string,
  configuration: vscode.WorkspaceConfiguration,
  settingKey: string
): Promise<string> {
  const stored = await Promise.resolve(secrets.get(secretKey)).catch(() => undefined);
  const trimmed = (stored ?? '').trim();
  if (trimmed) {return trimmed;}
  return (configuration.get<string>(settingKey, '') ?? '').trim();
}

/** Which config targets currently hold a non-empty string for this setting. */
function targetsHoldingValue(
  configuration: vscode.WorkspaceConfiguration,
  settingKey: string
): vscode.ConfigurationTarget[] {
  const info = configuration.inspect<string>(settingKey);
  const targets: vscode.ConfigurationTarget[] = [];
  const has = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;
  if (has(info?.globalValue)) {targets.push(vscode.ConfigurationTarget.Global);}
  if (has(info?.workspaceValue)) {targets.push(vscode.ConfigurationTarget.Workspace);}
  if (has(info?.workspaceFolderValue)) {targets.push(vscode.ConfigurationTarget.WorkspaceFolder);}
  return targets;
}

/**
 * Move any plaintext key out of settings.json into SecretStorage and clear
 * the setting. Returns the setting ids that were migrated (for logging and
 * for tests); an empty array means there was nothing in plaintext.
 *
 * An existing secret always wins — if both stores hold a value, the secret
 * is kept and the setting is only cleared. Otherwise re-running this would
 * let a stale synced setting clobber a key the user just entered.
 */
export async function migrateSettingSecrets(
  context: vscode.ExtensionContext,
  configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('banditStealth')
): Promise<string[]> {
  const migrated: string[] = [];

  for (const { setting, secret } of MIGRATED_SECRETS) {
    try {
      const targets = targetsHoldingValue(configuration, setting);
      if (targets.length === 0) {continue;}

      const existing = await Promise.resolve(context.secrets.get(secret)).catch(() => undefined);
      const plaintext = (configuration.get<string>(setting, '') ?? '').trim();

      if (!(existing ?? '').trim() && plaintext) {
        await context.secrets.store(secret, plaintext);
      }

      // Clear every target that held one, not just the effective one — a
      // key left in workspace scope while user scope is cleared is still a
      // key in a file that gets committed.
      for (const target of targets) {
        await configuration.update(setting, undefined, target);
      }
      migrated.push(setting);
    } catch {
      // Never block activation on this. A failure here leaves the key
      // exactly where it was and readMigratedSecret still resolves it from
      // the setting, so the feature keeps working; the next activation
      // retries the move.
    }
  }

  return migrated;
}

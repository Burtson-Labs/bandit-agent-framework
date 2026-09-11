// ─────────────────────────────────────────────────────────────────────────────
// Shared Bandit config (~/.bandit/config.json) helpers.
//
// The CLI ships saveTavilyKey / clearTavilyKey in apps/bandit-cli/src/config.ts.
// The IDE used to write its Tavily key only to a VS Code workspace setting
// (banditStealth.webSearch.tavilyApiKey), which meant a key set in the IDE
// wasn't visible to the CLI — they had no shared source of truth and users
// had to enter their key twice.
//
// As of v1.7.332 the IDE writes to ~/.bandit/config.json too, which is
// what gave the two surfaces a shared source of truth.
//
// The VS Code setting is no longer written at all: it was a plaintext
// credential in a synced (and often committed) file. New keys go to
// ~/.bandit/config.json (mode 0600) plus the OS keychain. Read order is
// env TAVILY_API_KEY → ~/.bandit/config.json → SecretStorage → legacy
// setting, matching the CLI so both surfaces see the same key. The
// setting stays readable only until migrateSettingSecrets clears it.
//
// Inlined here rather than imported from a shared package because the
// extension can't depend on @burtson-labs/bandit-stealth-cli (it's a
// peer app), and the surface is small enough (3 functions) that
// duplication is cheaper than carving out a new shared module right now.
// If we ever need another file-backed config field, this moves into
// host-kit alongside loadMemory + appendMemory.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { TAVILY_API_KEY_SECRET_KEY } from '../storageKeys';

export const BANDIT_CONFIG_PATH = path.join(os.homedir(), '.bandit', 'config.json');

export interface BanditConfigFile {
  tools?: {
    tavily?: { apiKey?: string };
  };
  /** App-level OTLP telemetry — opt-in, off by default. Same block the CLI
   *  reads; shared with the IDE host so one config drives both. */
  telemetry?: {
    enabled?: boolean;
    endpoint?: string;
    mode?: 'metrics+traces' | 'metrics-only';
    headers?: Record<string, string>;
  };
  [key: string]: unknown;
}

export function readBanditConfig(): BanditConfigFile {
  try {
    const raw = fs.readFileSync(BANDIT_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as BanditConfigFile;
  } catch {
    // Missing or malformed — treat as empty. The save path will create
    // a fresh file on the next write.
    return {};
  }
}

export function writeBanditConfig(next: BanditConfigFile): void {
  const dir = path.dirname(BANDIT_CONFIG_PATH);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  // Mode 0o600 to match how the CLI writes — the file holds tokens, so
  // group/other readability is a real risk on shared machines.
  fs.writeFileSync(BANDIT_CONFIG_PATH, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export function readTavilyKeyFromBanditConfig(): string | null {
  const cfg = readBanditConfig();
  const key = cfg.tools?.tavily?.apiKey?.trim();
  return key && key.length > 0 ? key : null;
}

export function writeTavilyKeyToBanditConfig(apiKey: string): void {
  const cfg = readBanditConfig();
  cfg.tools = {
    ...(cfg.tools ?? {}),
    tavily: { ...(cfg.tools?.tavily ?? {}), apiKey }
  };
  writeBanditConfig(cfg);
}

export function clearTavilyKeyFromBanditConfig(): void {
  const cfg = readBanditConfig();
  if (cfg.tools?.tavily) {
    delete cfg.tools.tavily.apiKey;
    if (Object.keys(cfg.tools.tavily).length === 0) {delete cfg.tools.tavily;}
    if (cfg.tools && Object.keys(cfg.tools).length === 0) {delete cfg.tools;}
  }
  writeBanditConfig(cfg);
}

/** Read the effective Tavily key the chat engine should use. Resolution
 *  order matches the CLI's `resolveConfig`: env wins (per-shell override),
 *  then ~/.bandit/config.json (canonical store, written 0600 and shared
 *  with the CLI), then SecretStorage, then the legacy VS Code setting.
 *
 *  The setting is last and exists only so an existing install keeps working
 *  until `migrateSettingSecrets` lifts the value into the keychain and
 *  clears it. New writes go to the file + SecretStorage, never to
 *  settings.json. */
export async function resolveTavilyKey(
  configuration: vscode.WorkspaceConfiguration,
  secrets?: vscode.SecretStorage
): Promise<string | undefined> {
  const envKey = process.env.TAVILY_API_KEY?.trim();
  if (envKey && envKey.length > 0) {return envKey;}
  const fileKey = readTavilyKeyFromBanditConfig();
  if (fileKey) {return fileKey;}
  if (secrets) {
    const stored = await Promise.resolve(secrets.get(TAVILY_API_KEY_SECRET_KEY)).catch(() => undefined);
    const trimmedSecret = (stored ?? '').trim();
    if (trimmedSecret) {return trimmedSecret;}
  }
  const settingKey = (configuration.get<string>('webSearch.tavilyApiKey', '') || '').trim();
  return settingKey.length > 0 ? settingKey : undefined;
}

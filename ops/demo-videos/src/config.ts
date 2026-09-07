import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface BanditCreds {
  apiKey?: string;
  apiUrl: string;
}

/**
 * Credentials for Bandit cloud TTS. Env (BANDIT_API_KEY / BANDIT_API_URL)
 * wins, then the user's local ~/.bandit/config.json — the same file the
 * CLI and extension read. Never logged, never written anywhere.
 */
export function loadBanditCreds(): BanditCreds {
  let fileKey: string | undefined;
  let fileUrl: string | undefined;
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.bandit', 'config.json'), 'utf8')) as {
      bandit?: { apiKey?: string; apiUrl?: string };
    };
    fileKey = raw?.bandit?.apiKey;
    fileUrl = raw?.bandit?.apiUrl;
  } catch {
    /* no local config — narrate.ts falls back to macOS `say` */
  }
  return {
    apiKey: process.env.BANDIT_API_KEY ?? fileKey,
    apiUrl: (process.env.BANDIT_API_URL ?? fileUrl ?? 'https://api.burtson.ai').trim(),
  };
}

/**
 * Mirror the extension's deriveEndpoint (apps/bandit-stealth/src/helpers/endpoints.ts):
 * strip a pasted /completions tail, then append the stealth TTS path.
 */
export function ttsEndpoint(apiUrl: string): string {
  const base = apiUrl
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/completions$/i, '');
  return `${base}/api/stealth/tts`;
}

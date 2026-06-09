/**
 * Bandit cloud account/usage HTTP calls extracted from extension.ts.
 *
 * Why: extension.ts crossed 9k lines and bandit's self-evaluation
 * flagged it as monolithic. The two cloud-account network calls were
 * tangled into the provider class but had no real coupling to it —
 * they're pure `(apiKey, url) → result` functions. Pulling them out
 * leaves the state mutation in the class (`this.accountProfile = ...`)
 * but makes the IO testable in isolation.
 */
import type { AccountProfile } from '../agentTypes';

/** Shape returned by the cloud /api/stealth/account/usage endpoint. */
export interface AccountUsageData {
  authMethod: string;
  email?: string;
  userId?: string;
  plan: string;
  isAdmin: boolean;
  session: { used: number; limit: number; resetsAtUnix: number };
  weekly: { used: number; limit: number; resetsAtUnix: number };
}

export type AccountFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Validate a Bandit API key with the auth gateway and return the
 * profile it issues. The endpoint is the canonical
 * `/api/keys/validate` — note this hits the auth host directly, not
 * the configurable `apiUrl` (intentional: a misconfigured workspace
 * apiUrl shouldn't break key validation). 6-second timeout because
 * we block UI on this on every API-key store.
 */
export async function validateBanditApiKey(apiKey: string): Promise<AccountFetchResult<AccountProfile>> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return { ok: false, error: 'API key is empty.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const url = `https://auth.burtson.ai/api/keys/validate?key=${encodeURIComponent(trimmed)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, error: text || `Validation failed (${response.status})` };
    }
    const profile = (await response.json()) as AccountProfile;
    return { ok: true, data: profile };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch the rolling-window usage snapshot from the cloud account API.
 * Caller passes the resolved URL (use `resolveAccountUsageUrl` from
 * `helpers/endpoints.ts`) so this stays free of vscode/configuration
 * knowledge. Returns a string error suitable for the modal's empty
 * state on any failure — the modal renders gracefully rather than
 * spinning forever.
 */
export async function fetchAccountUsage(apiKey: string, url: string): Promise<AccountFetchResult<AccountUsageData>> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        error: `Usage fetch failed: ${response.status}${detail ? ` — ${detail.slice(0, 160)}` : ''}`
      };
    }
    const data = (await response.json()) as AccountUsageData;
    return { ok: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Usage fetch failed: ${message}` };
  }
}

/**
 * `AccountService` owns the Bandit Cloud account profile slice of
 * webview state: the cached profile object (org / plan / email), the
 * `loading | idle | error` status, and the last validation error
 * string. Plus the two HTTP fetches that drive them:
 *
 * - `refresh()` validates the stored API key against the account-
 *   profile endpoint; called on activation, after key mutations
 *   (set/clear/signIn), and from the `requestAccountProfile`
 *   webview message.
 * - `sendUsage()` fetches the per-period usage chart payload and
 *   posts it back as `accountUsage`; called from
 *   `requestAccountUsage`.
 *
 * Both methods short-circuit cleanly when the user isn't on the
 * Bandit Cloud provider or has no key stored — the webview renders
 * a graceful empty state for both surfaces, not a spinner.
 *
 * The 3 state slots are exposed as readonly getters so `flushState`
 * can mirror them into the outgoing webview state without the
 * provider needing to cache them itself.
 */
import * as vscode from 'vscode';
import type { AccountProfile, AccountProfileStatus } from '../../agentTypes';
import { fetchAccountUsage, validateBanditApiKey } from '../../helpers/accountApi';
import { resolveAccountUsageUrl } from '../../helpers/endpoints';
import { API_KEY_SECRET_KEY } from '../../storageKeys';
import type { ProviderContext } from '../context';

export class AccountService {
  private profile: AccountProfile | null = null;
  private status: AccountProfileStatus = 'idle';
  private error: string | null = null;

  constructor(private readonly ctx: ProviderContext) {}

  /** Cached profile snapshot — mirrored into webview state by
   *  flushState. Null when the user isn't on Bandit Cloud or the
   *  last validation failed. */
  get accountProfile(): AccountProfile | null {
    return this.profile;
  }

  /** Validation status — `idle` while at-rest, `loading` during an
   *  in-flight refresh, `error` after a failed validation. */
  get accountProfileStatus(): AccountProfileStatus {
    return this.status;
  }

  /** Human-readable error from the last failed validation, or null
   *  when the profile is fresh / never-validated / explicitly cleared. */
  get accountProfileError(): string | null {
    return this.error;
  }

  /**
   * Resolve the active provider's Bandit Cloud API key against the
   * account-validation endpoint and refresh the cached profile.
   * On non-Bandit providers or with no key stored, clears the cache
   * to its idle state so the webview shows the empty "not signed in"
   * surface instead of a stale signed-in chip.
   */
  async refresh(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('banditStealth');
    const providerKind = this.ctx.getProviderKind(configuration);
    const apiKey = providerKind === 'bandit'
      ? await this.ctx.extensionContext.secrets.get(API_KEY_SECRET_KEY)
      : undefined;
    if (providerKind !== 'bandit' || !apiKey) {
      this.profile = null;
      this.error = null;
      this.status = 'idle';
      await this.ctx.syncState();
      return;
    }

    this.status = 'loading';
    this.error = null;
    await this.ctx.syncState();

    const result = await validateBanditApiKey(apiKey);
    if (result.ok) {
      this.profile = result.data;
      this.status = 'idle';
      this.error = null;
    } else {
      this.profile = null;
      this.status = 'error';
      this.error = result.error;
    }

    await this.ctx.syncState();
  }

  /**
   * Webview bridge — fetch the usage chart payload for the current
   * billing period and post it back to the chat panel. Posts
   * `{ data: null, error: ... }` on the off-Bandit / no-key paths so
   * the modal renders a graceful empty state rather than spinning
   * forever.
   */
  async sendUsage(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('banditStealth');
    const providerKind = this.ctx.getProviderKind(configuration);
    if (providerKind !== 'bandit') {
      this.ctx.postMessage({ type: 'accountUsage', data: null, error: 'Account & Usage is only available when provider = bandit.' });
      return;
    }
    const apiKey = await this.ctx.extensionContext.secrets.get(API_KEY_SECRET_KEY);
    if (!apiKey) {
      this.ctx.postMessage({ type: 'accountUsage', data: null, error: 'Set a Bandit API key first to see your usage.' });
      return;
    }
    const result = await fetchAccountUsage(apiKey, resolveAccountUsageUrl(configuration));
    if (result.ok) {
      this.ctx.postMessage({ type: 'accountUsage', data: result.data });
    } else {
      this.ctx.postMessage({ type: 'accountUsage', data: null, error: result.error });
    }
  }
}

/**
 * API-key message handlers — the chunky `setApiKey` (paste-key flow)
 * and `signInWithBurtson` (PKCE OAuth flow). Both terminate in the
 * same `context.secrets.store(API_KEY_SECRET_KEY, ...)` write, the
 * same `slowStateCache.invalidate()` punch, and a fire-and-forget
 * `account.refresh()` to repopulate the profile chip.
 *
 * The smaller delegates (`setOllamaAuthToken`, `clearOllamaAuthToken`,
 * `setTavilyKey`, `clearTavilyKey`, `clearApiKey`) stay as 1-line
 * dispatch entries in the provider's `handleMessage` since they call
 * into the provider's existing public methods — moving them here
 * would just add indirection without removing LOC.
 *
 * The OAuth flow is dynamically imported so the auth/oauthFlow
 * module's `http`/`crypto`/etc. dependencies aren't paid by extension
 * activation when the user never signs in via OAuth.
 */
import type { IncomingMessage } from '../../messages';
import type { ProviderContext } from '../context';
import { API_KEY_SECRET_KEY } from '../../storageKeys';

export interface ApiKeyMessageDeps {
  /** Abort any in-flight tool-use turn before mutating the stored
   *  key — protects against an in-flight cloud call racing against
   *  the rotated credential. */
  cancelActiveStream(): void;
  /** Provider's `isBusy = false` direct assignment — preserves the
   *  pre-extraction "drop busy flag without firing onDidChangeStatus"
   *  behavior (the paste-key flow uses this; sign-in does not). */
  resetBusyImmediate(): void;
}

export async function handleSetApiKey(
  message: Extract<IncomingMessage, { type: 'setApiKey' }>,
  ctx: ProviderContext,
  deps: ApiKeyMessageDeps
): Promise<void> {
  const trimmed = message.value.trim();
  if (!trimmed) {
    ctx.postMessage({ type: 'notification', message: 'API key cannot be empty.' });
    return;
  }
  deps.cancelActiveStream();
  deps.resetBusyImmediate();
  await ctx.extensionContext.secrets.store(API_KEY_SECRET_KEY, trimmed);
  ctx.invalidateSlowStateCache();
  await ctx.syncState();
  // silent success — the settings panel already reflects the saved state.
  void ctx.account.refresh();
}

/**
 * Topic dispatcher — returns `true` if the message belongs to the
 * api-key cluster (and was handled), `false` otherwise. Collapses 2
 * if-blocks in the provider's `handleMessage`. The smaller credential
 * messages (clearApiKey, setOllamaAuthToken, …) stay inline because
 * they call provider-class methods directly — see the module
 * doc-comment above.
 */
export async function dispatchApiKeyMessage(
  ctx: ProviderContext,
  deps: ApiKeyMessageDeps,
  message: IncomingMessage
): Promise<boolean> {
  switch (message.type) {
    case 'setApiKey':
      await handleSetApiKey(message, ctx, deps);
      return true;
    case 'signInWithBurtson':
      await handleSignInWithBurtson(ctx);
      return true;
    default:
      return false;
  }
}

export async function handleSignInWithBurtson(
  ctx: ProviderContext
): Promise<void> {
  // Native-app PKCE OAuth → device-key issuance. Browser opens, user
  // authenticates with their existing Burtson Labs login (Google /
  // GitHub / Microsoft / Apple), AuthApi mints a fresh device key,
  // we persist it. From here on, completions calls use the API key
  // — same code path as the paste-key flow.
  ctx.postMessage({ type: 'notification', message: 'Opening browser for sign-in…' });
  try {
    const { runOAuthSignIn } = await import('../../auth/oauthFlow');
    const result = await runOAuthSignIn();
    await ctx.extensionContext.secrets.store(API_KEY_SECRET_KEY, result.apiKey);
    ctx.invalidateSlowStateCache();
    await ctx.syncState();
    const greeting = result.name ? `Signed in as ${result.name}.` : 'Signed in.';
    ctx.postMessage({ type: 'notification', message: greeting });
    void ctx.account.refresh();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.postMessage({ type: 'notification', message: `Sign-in failed: ${msg}` });
  }
}

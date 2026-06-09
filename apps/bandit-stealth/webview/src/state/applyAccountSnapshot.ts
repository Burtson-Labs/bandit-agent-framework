import type { AccountProfile, AccountProfileStatus, WebviewState } from "../types/webview";

/**
 * Setter surface for the account/auth slice of a `state` boot/sync
 * message. Grouped here so `handleStateMessage` in App.tsx becomes a
 * coordinator that just hands the snapshot to each slice instead of
 * inlining ~10 setter calls per concern.
 *
 * Concern boundary: anything tied to the signed-in user, their stored
 * keys (Bandit + Tavily), and the installed extension version. The
 * Ollama-side credentials live on [[useProviderSettings]] because the
 * Ollama bits are provider-flavored, not account-flavored.
 */
export interface AccountSnapshotDeps {
  setRequireKey: (value: boolean) => void;
  setHasApiKey: (value: boolean) => void;
  setAccountProfile: (value: AccountProfile | null) => void;
  setAccountProfileStatus: (value: AccountProfileStatus) => void;
  setAccountProfileError: (value: string | null) => void;
  setHasStoredApiKey: (value: boolean) => void;
  setHasTavilyKey: (value: boolean) => void;
  setExtensionVersion: (value: string) => void;
}

export function applyAccountSnapshot(state: WebviewState, deps: AccountSnapshotDeps): void {
  deps.setRequireKey(state.requiresApiKey && !state.hasApiKey);
  deps.setHasApiKey(state.hasApiKey === true);
  deps.setAccountProfile(state.accountProfile ?? null);
  deps.setAccountProfileStatus(state.accountProfileStatus ?? "idle");
  deps.setAccountProfileError(state.accountProfileError ?? null);
  deps.setHasStoredApiKey(state.hasStoredApiKey ?? false);
  deps.setHasTavilyKey(Boolean((state as { hasTavilyKey?: boolean }).hasTavilyKey));
  deps.setExtensionVersion((state as { extensionVersion?: string }).extensionVersion ?? "");
}

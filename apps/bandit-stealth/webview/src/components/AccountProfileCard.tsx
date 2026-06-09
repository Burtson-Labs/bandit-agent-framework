import type { JSX } from "react";
import { ShieldCheckIcon, UserCircleIcon } from "@heroicons/react/24/outline";
import type { AccountProfile, AccountProfileStatus } from "../types/webview";

export function AccountProfileCard({
  profile,
  status,
  error,
  onRefresh
}: {
  profile: AccountProfile | null;
  status: AccountProfileStatus;
  error: string | null;
  onRefresh: () => void;
}): JSX.Element {
  if (status === "loading") {
    return (
      <div className="settings-card settings-card--muted">
        <p>Validating your API key…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="settings-card settings-card--error">
        <h3>Validation error</h3>
        <p>{error}</p>
        <button type="button" className="stealth-button" onClick={onRefresh}>
          Try again
        </button>
      </div>
    );
  }
  if (!profile || profile.valid === false) {
    return (
      <div className="settings-card settings-card--muted">
        <h3>No account detected</h3>
        <p>Enter a valid Bandit API key to link your account and unlock credits.</p>
        <button type="button" className="stealth-button" onClick={onRefresh}>
          Validate key
        </button>
      </div>
    );
  }
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
  const displayName = fullName || profile.email || "Bandit user";
  const creditsLabel =
    typeof profile.credits === "number" ? profile.credits.toLocaleString() : undefined;
  const hasKey = typeof profile.maskedKey === "string" && profile.maskedKey.length > 0;
  return (
    <div className="settings-card settings-account-card">
      <div className="settings-account-card__avatar" aria-hidden="true">
        <UserCircleIcon />
      </div>
      <div className="settings-account-card__body">
        <div className="settings-account-card__heading">
          <div>
            <p className="settings-account-card__title">{displayName}</p>
            {profile.email && <p className="settings-account-card__subtitle">{profile.email}</p>}
          </div>
          {profile.isAdmin && (
            <span className="settings-admin-pill settings-admin-pill--badge">
              <ShieldCheckIcon aria-hidden="true" />
              Admin key
            </span>
          )}
        </div>
        <div className="settings-account-card__stats">
          <div className="settings-account-card__stat">
            <p className="settings-label">Credits</p>
            <p className="settings-value">{creditsLabel ?? "—"}</p>
          </div>
          <div className="settings-account-card__stat">
            <p className="settings-label">API key</p>
            <p className="settings-value">{hasKey ? profile.maskedKey : "Not set"}</p>
          </div>
        </div>
        {hasKey && (
          <div className="settings-note">
            Keys are stored securely inside VS Code. Refresh if you generated a new key outside Bandit.
          </div>
        )}
      </div>
      <div className="settings-account-card__actions">
        <button type="button" className="stealth-button stealth-button--ghost" onClick={onRefresh}>
          Refresh
        </button>
      </div>
    </div>
  );
}

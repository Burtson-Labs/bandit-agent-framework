import type { JSX } from "react";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { AccountProfile, AccountProfileStatus } from "../types/webview";

/** Up to two initials for the avatar; falls back to the email's first letter. */
export function accountInitials(profile: Pick<AccountProfile, "firstName" | "lastName" | "email">): string {
  const fromName = [profile.firstName, profile.lastName]
    .map((part) => part?.trim().charAt(0) ?? "")
    .join("")
    .toUpperCase();
  if (fromName) {return fromName;}
  return (profile.email?.trim().charAt(0) ?? "?").toUpperCase();
}

/**
 * The signed-in account as one compact row: initials, name, email, plan
 * and admin badges, then credits and the masked key underneath. The key
 * is only ever shown in the masked form the host sends.
 */
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
        <p className="settings-note">Checking your API key…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="settings-card settings-card--error" role="alert">
        <h3>Couldn't load your account</h3>
        <p className="settings-note">{error}</p>
        <div className="settings-actions">
          <button type="button" className="stealth-button stealth-button--ghost" onClick={onRefresh}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!profile || profile.valid === false) {
    return (
      <div className="settings-card">
        <h3>No account linked</h3>
        <p className="settings-note">Sign in or add a Bandit API key below to link your account.</p>
        <div className="settings-actions">
          <button type="button" className="stealth-button stealth-button--ghost" onClick={onRefresh}>
            Check again
          </button>
        </div>
      </div>
    );
  }
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
  const displayName = fullName || profile.email || "Bandit user";
  const creditsLabel =
    typeof profile.credits === "number" ? profile.credits.toLocaleString() : "—";
  const hasKey = typeof profile.maskedKey === "string" && profile.maskedKey.length > 0;
  const plan = profile.plan?.trim();
  return (
    <div className="settings-card settings-account">
      <div className="settings-account__row">
        <span className="settings-account__avatar" aria-hidden="true">
          {accountInitials(profile)}
        </span>
        <div className="settings-account__identity">
          <p className="settings-account__name" title={displayName}>{displayName}</p>
          {fullName && profile.email && (
            <p className="settings-account__email" title={profile.email}>{profile.email}</p>
          )}
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          aria-label="Refresh account"
          title="Refresh account (use after creating a new key outside Bandit)"
        >
          <ArrowPathIcon aria-hidden="true" />
        </button>
      </div>
      <div className="settings-account__meta">
        {plan && <span className="settings-badge">{plan}</span>}
        {profile.isAdmin && <span className="settings-badge">Admin key</span>}
        <span>Credits {creditsLabel}</span>
        <span>
          Key <code className="settings-account__key">{hasKey ? profile.maskedKey : "not set"}</code>
        </span>
      </div>
    </div>
  );
}

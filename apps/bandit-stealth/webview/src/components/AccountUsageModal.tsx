import type { JSX } from "react";
import { UsageMeter } from "@burtson-labs/agent-ui";
import { formatResetCountdown } from "../util/formatResetCountdown";

export type UsageSnapshot = {
  authMethod: string;
  email?: string;
  userId?: string;
  plan: string;
  isAdmin: boolean;
  session: { used: number; limit: number; resetsAtUnix?: number };
  weekly: { used: number; limit: number; resetsAtUnix?: number };
};

export function AccountUsageModal({
  snapshot,
  status,
  error,
  onClose,
  onRefresh
}: {
  snapshot: UsageSnapshot | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <div className="usage-modal__backdrop" role="dialog" aria-modal="true" aria-label="Account and usage">
      <div className="usage-modal">
        <header className="usage-modal__header">
          <h2>Account &amp; Usage</h2>
          <button type="button" className="stealth-button stealth-button--ghost" onClick={onClose}>
            Close
          </button>
        </header>

        {status === "loading" && <p className="settings-note">Loading usage…</p>}
        {status === "error" && (
          <div className="settings-card settings-card--error">
            <p>{error ?? "Could not load usage."}</p>
            <button type="button" className="stealth-button" onClick={onRefresh}>
              Try again
            </button>
          </div>
        )}

        {snapshot && (
          <>
            <section className="usage-modal__section">
              <div className="usage-modal__row">
                <span className="settings-label">Auth method</span>
                <span className="settings-value">{snapshot.authMethod}</span>
              </div>
              {snapshot.email && (
                <div className="usage-modal__row">
                  <span className="settings-label">Email</span>
                  <span className="settings-value">{snapshot.email}</span>
                </div>
              )}
              <div className="usage-modal__row">
                <span className="settings-label">Plan</span>
                <span className="usage-modal__plan-value">
                  <span className="settings-value">{snapshot.plan}</span>
                  {snapshot.isAdmin && (
                    <span className="settings-admin-pill settings-admin-pill--badge">admin bypass</span>
                  )}
                </span>
              </div>
            </section>

            <section className="usage-modal__section">
              <UsageMeter
                label="Current 5-hour session"
                used={snapshot.session.used}
                limit={snapshot.session.limit}
                note={`Resets in ${formatResetCountdown(snapshot.session.resetsAtUnix)}`}
              />
            </section>

            <section className="usage-modal__section">
              <UsageMeter
                label="Current weekly window"
                used={snapshot.weekly.used}
                limit={snapshot.weekly.limit}
                note={`Resets in ${formatResetCountdown(snapshot.weekly.resetsAtUnix)}`}
              />
            </section>

            <section className="usage-modal__section">
              <p className="settings-note">
                Need a higher limit? Email{" "}
                <a href="mailto:team@burtson.ai">team@burtson.ai</a> to upgrade.
              </p>
            </section>
          </>
        )}

        <footer className="usage-modal__footer">
          <button type="button" className="stealth-button stealth-button--ghost" onClick={onRefresh}>
            Refresh
          </button>
        </footer>
      </div>
    </div>
  );
}

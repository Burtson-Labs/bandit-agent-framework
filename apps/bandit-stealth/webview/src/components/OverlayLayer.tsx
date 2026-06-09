import type { JSX } from "react";
import { AccountUsageModal, type UsageSnapshot } from "./AccountUsageModal";
import { formatResetCountdown } from "../util/formatResetCountdown";

export interface RateLimitToast {
  window: string;
  resetsAtUnix?: number;
  message: string;
}

export interface OverlayLayerProps {
  /** Notification toast (mic guidance, STT 5xx, autoplay denial, etc). */
  toast: string | null;
  cancelToastDismiss: () => void;
  scheduleToastDismiss: () => void;
  dismissToast: () => void;
  /** Rate-limit-reached toast (separate visual surface from the generic toast). */
  rateLimitToast: RateLimitToast | null;
  onViewUsageFromToast: () => void;
  onDismissRateLimitToast: () => void;
  /** Account usage modal (opens from the rate-limit toast's "View usage" button). */
  usageModalOpen: boolean;
  usageSnapshot: UsageSnapshot | null;
  usageStatus: "idle" | "loading" | "ready" | "error";
  usageError: string | null;
  onCloseUsageModal: () => void;
  onRefreshUsage: () => void;
}

/**
 * Fixed-position overlay layer: the generic notification toast, the
 * distinct rate-limit-reached toast, and the account usage modal that
 * opens from the rate-limit toast's "View usage" button.
 *
 * All three are mutually exclusive surfaces by topic but can render
 * simultaneously by layer (toast + modal can coexist). Each renders
 * null when its driving state is empty.
 */
export function OverlayLayer(props: OverlayLayerProps): JSX.Element {
  const {
    toast,
    cancelToastDismiss,
    scheduleToastDismiss,
    dismissToast,
    rateLimitToast,
    onViewUsageFromToast,
    onDismissRateLimitToast,
    usageModalOpen,
    usageSnapshot,
    usageStatus,
    usageError,
    onCloseUsageModal,
    onRefreshUsage
  } = props;
  return (
    <>
      {toast && (
        <div
          className="stealth-notification"
          role="status"
          aria-live="polite"
          // Pause the auto-dismiss while the user is reading or about
          // to copy. Resume countdown when they mouse out. Mirrors the
          // standard pattern — Slack, GitHub, VS Code's own
          // notifications all do this. Without it, multi-line errors
          // (TCC mic guidance, STT 5xx body) blink out before the user
          // finishes reading.
          onMouseEnter={cancelToastDismiss}
          onMouseLeave={scheduleToastDismiss}
        >
          <div className="stealth-notification__body">{toast}</div>
          <button
            type="button"
            className="stealth-notification__close"
            onClick={dismissToast}
            aria-label="Dismiss notification"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {rateLimitToast && (
        <div className="rate-limit-toast" role="alert" aria-live="assertive">
          <div className="rate-limit-toast__body">
            <p className="rate-limit-toast__title">Rate limit reached</p>
            <p className="rate-limit-toast__message">{rateLimitToast.message}</p>
            {rateLimitToast.resetsAtUnix && (
              <p className="rate-limit-toast__meta">
                Resets in {formatResetCountdown(rateLimitToast.resetsAtUnix)} · {rateLimitToast.window} window
              </p>
            )}
          </div>
          <div className="rate-limit-toast__actions">
            <button type="button" className="stealth-button" onClick={onViewUsageFromToast}>
              View usage
            </button>
            <button
              type="button"
              className="stealth-button stealth-button--ghost"
              onClick={onDismissRateLimitToast}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {usageModalOpen && (
        <AccountUsageModal
          snapshot={usageSnapshot}
          status={usageStatus}
          error={usageError}
          onClose={onCloseUsageModal}
          onRefresh={onRefreshUsage}
        />
      )}
    </>
  );
}

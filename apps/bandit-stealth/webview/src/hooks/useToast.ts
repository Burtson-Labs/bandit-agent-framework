import { useCallback, useRef, useState } from "react";

// Toast dismiss is pauseable on hover. When the toast carries
// multi-line content (mic-blocked + cache-clearing instructions, STT
// error bodies, gateway 5xx detail), 4s isn't enough to read and the
// user's instinct is to mouse over to start copying text. The JSX in
// App's render wires onMouseEnter → cancelToastDismiss and onMouseLeave
// → scheduleToastDismiss so the baseline 8s timer pauses while the
// cursor is over the toast and resumes when it leaves.
const TOAST_AUTO_DISMISS_MS = 8000;

export interface ToastHook {
  /** The currently-displayed toast message, or null when none is up. */
  toast: string | null;
  /** Show a new toast (replaces any prior message) and schedule the auto-dismiss. */
  updateToast: (message: string) => void;
  /** Pause the auto-dismiss timer (hover-on). */
  cancelToastDismiss: () => void;
  /** Re-arm the auto-dismiss timer (hover-off). */
  scheduleToastDismiss: () => void;
  /** Manual close (X button): cancel the pending dismiss and clear the message. */
  dismissToast: () => void;
}

export function useToast(): ToastHook {
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleToastDismiss = useCallback(() => {
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
    }
    toastTimer.current = setTimeout(() => setToast(null), TOAST_AUTO_DISMISS_MS);
  }, []);

  const cancelToastDismiss = useCallback(() => {
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
      toastTimer.current = null;
    }
  }, []);

  const updateToast = useCallback(
    (message: string) => {
      setToast(message);
      scheduleToastDismiss();
    },
    [scheduleToastDismiss]
  );

  const dismissToast = useCallback(() => {
    cancelToastDismiss();
    setToast(null);
  }, [cancelToastDismiss]);

  return { toast, updateToast, cancelToastDismiss, scheduleToastDismiss, dismissToast };
}

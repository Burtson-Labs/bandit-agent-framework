import type { UsageSnapshot } from "../components/AccountUsageModal";
import type { AgentEvent } from "@burtson-labs/agent-core";
import type { WebviewMessage } from "../types/webviewMessage";

export interface AccountMessagesDeps {
  setUsageSnapshot: (snapshot: UsageSnapshot | null) => void;
  setUsageStatus: (status: "idle" | "loading" | "ready" | "error") => void;
  setUsageError: (error: string | null) => void;
  setRateLimitToast: (
    toast: { window: string; resetsAtUnix?: number; message: string } | null
  ) => void;
  /** Outbound `requestAccountUsage` post (refetch on rate-limit). */
  requestAccountUsage: () => void;
  /** Append a telemetry-shaped event for contextInjectionSkipped. */
  appendContextInjectionSkippedEvent: (reason?: string, prompt?: string) => AgentEvent;
  appendEvents: (event: AgentEvent | AgentEvent[]) => void;
}

/**
 * Topic dispatcher for account / billing / usage messages. Splits
 * three discrete responsibilities:
 * - accountUsage: success → snapshot ready; error → status flips
 * - rateLimited: surface a distinct toast + prefetch fresh usage
 *   numbers so the "View usage" modal opens populated
 * - contextInjectionSkipped: surface as a telemetry event for the
 *   trace timeline (the host reports when it skipped auto-context
 *   injection so the user can correlate "no files attached" with
 *   the agent's behavior)
 */
export function dispatchAccountMessage(
  message: WebviewMessage,
  deps: AccountMessagesDeps
): boolean {
  switch (message.type) {
    case "accountUsage":
      if (message.error) {
        deps.setUsageError(message.error);
        deps.setUsageStatus("error");
      } else if (message.data) {
        deps.setUsageSnapshot(message.data);
        deps.setUsageError(null);
        deps.setUsageStatus("ready");
      }
      return true;
    case "rateLimited":
      deps.setRateLimitToast({
        window: message.window,
        resetsAtUnix: message.resetsAtUnix,
        message: message.message
      });
      // Prefetch the usage snapshot so the modal opens with fresh
      // numbers if the user clicks "View usage" from the toast.
      deps.requestAccountUsage();
      return true;
    case "contextInjectionSkipped":
      deps.appendEvents(deps.appendContextInjectionSkippedEvent(message.reason, message.prompt));
      return true;
    default:
      return false;
  }
}

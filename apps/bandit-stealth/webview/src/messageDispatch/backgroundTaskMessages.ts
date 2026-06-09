import type { BackgroundTaskRecord } from "../types/backgroundTasks";
import type { WebviewMessage } from "../types/webviewMessage";

export interface BackgroundTaskMessagesDeps {
  setBackgroundTasksList: (next: BackgroundTaskRecord[]) => void;
  applyBackgroundTaskUpdate: (task: BackgroundTaskRecord) => void;
}

/**
 * Topic dispatcher for background-subagent task updates from the
 * extension. The hook owns the actual state mutation; this dispatcher
 * is just the routing slice from the message switch.
 */
export function dispatchBackgroundTaskMessage(
  message: WebviewMessage,
  deps: BackgroundTaskMessagesDeps
): boolean {
  switch (message.type) {
    case "backgroundTaskList":
      deps.setBackgroundTasksList(message.tasks ?? []);
      return true;
    case "backgroundTaskUpdate":
      deps.applyBackgroundTaskUpdate(message.task);
      return true;
    default:
      return false;
  }
}

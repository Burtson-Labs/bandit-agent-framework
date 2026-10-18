import type { WebviewMessage } from "../types/webviewMessage";
import { isViewAction, type ViewAction } from "../state/viewActions";

export interface ViewMessagesDeps {
  runViewAction: (action: ViewAction) => void;
}

/**
 * Topic dispatcher for the view title-bar actions the host forwards
 * (`viewAction`), plus the older `openSettings` push that the
 * "Set API Key" command sends. Unknown actions are ignored.
 */
export function dispatchViewMessage(message: WebviewMessage, deps: ViewMessagesDeps): boolean {
  switch (message.type) {
    case "viewAction":
      if (isViewAction(message.action)) {
        deps.runViewAction(message.action);
      }
      return true;
    case "openSettings":
      deps.runViewAction("openSettings");
      return true;
    default:
      return false;
  }
}

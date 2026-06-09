import type { ComposerSkillOption } from "@burtson-labs/agent-ui";
import type { WebviewMessage } from "../types/webviewMessage";
import type { WebviewState } from "../types/webview";

export interface CoreLifecycleDeps {
  handleStateMessage: (state: WebviewState) => void;
  updateToast: (message: string) => void;
  setRequireKey: (value: boolean) => void;
  /**
   * Resolve a pending skill-list promise that the composer's
   * autocomplete is awaiting. Set to null afterwards.
   */
  resolveSkillListPromise: (skills: ComposerSkillOption[]) => void;
}

/**
 * Topic dispatcher for the core webview lifecycle messages — the
 * boot/state sync, generic notifications/errors that flow through
 * the toast, the API-key gate, and the skill list response that
 * unblocks the composer's slash-command autocomplete.
 */
export function dispatchCoreLifecycleMessage(
  message: WebviewMessage,
  deps: CoreLifecycleDeps
): boolean {
  switch (message.type) {
    case "state":
      deps.handleStateMessage(message.state);
      return true;
    case "notification":
      deps.updateToast(message.message);
      return true;
    case "error":
      deps.updateToast(message.message);
      return true;
    case "requireApiKey":
      deps.setRequireKey(true);
      return true;
    case "skillList":
      deps.resolveSkillListPromise(Array.isArray(message.skills) ? message.skills : []);
      return true;
    default:
      return false;
  }
}

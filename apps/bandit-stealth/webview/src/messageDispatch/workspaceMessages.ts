import type { WebviewMessage } from "../types/webviewMessage";

export interface WorkspaceMessagesDeps {
  handleWorkspaceFileSuggestions: (entries: unknown) => void;
}

/**
 * Topic dispatcher for workspace-level extension → webview messages.
 * Currently a single case (the mention picker's file suggestions),
 * but the topic exists as its own module so future workspace events
 * (eg. workspaceFoldersChanged, gitBranchChanged) land here naturally.
 *
 * @returns true when the message was handled; false otherwise so the
 *          caller can route to the next dispatcher.
 */
export function dispatchWorkspaceMessage(
  message: WebviewMessage,
  deps: WorkspaceMessagesDeps
): boolean {
  if (message.type === "workspaceFileSuggestions") {
    deps.handleWorkspaceFileSuggestions(message.entries);
    return true;
  }
  return false;
}

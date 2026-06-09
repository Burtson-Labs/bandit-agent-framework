import type { AskUserQuestionPayload } from "../AskUserForm";
import type { IncomingPermissionRequest } from "../hooks/useApprovalQueue";
import type { WebviewMessage } from "../types/webviewMessage";

export interface PermissionMessagesDeps {
  /** Enqueue an inbound permissionRequest (dedup-by-id lives in the hook). */
  enqueueApproval: (request: IncomingPermissionRequest) => void;
  /** Drain the approval whose id matches the resolved one. */
  resolveApproval: (id: string) => void;
  /** Open the ask-user question card with the inbound questions. */
  requestAskUser: (id: string, questions: AskUserQuestionPayload[]) => void;
}

/**
 * Topic dispatcher for permission gate + ask_user messages. Tiny —
 * each case is a one-line delegate to the corresponding hook action.
 */
export function dispatchPermissionMessage(
  message: WebviewMessage,
  deps: PermissionMessagesDeps
): boolean {
  switch (message.type) {
    case "permissionRequest":
      deps.enqueueApproval(message);
      return true;
    case "permissionResolved":
      deps.resolveApproval(message.id);
      return true;
    case "userInputRequest":
      deps.requestAskUser(message.id, message.questions);
      return true;
    default:
      return false;
  }
}

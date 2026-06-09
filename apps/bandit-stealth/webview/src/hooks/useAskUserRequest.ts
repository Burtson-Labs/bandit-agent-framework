import { useCallback, useState } from "react";
import type { AskUserQuestionPayload } from "../AskUserForm";

export interface AskUserRequestState {
  id: string;
  questions: AskUserQuestionPayload[];
}

export interface AskUserRequestHook {
  /** The current in-flight ask_user request, or null if none is open. */
  askUserRequest: AskUserRequestState | null;
  /**
   * Receive an inbound `userInputRequest` message from the extension
   * host. Dedupes by id — re-sending the same id is a no-op so the user
   * doesn't see their in-progress form reset by a network resume.
   */
  requestAskUser: (id: string, questions: AskUserQuestionPayload[]) => void;
  /**
   * Submit (or cancel) the current ask_user form. Clears the local
   * state and posts the `userInputResponse` back to the extension host.
   */
  handleAskUserSubmit: (id: string, answers: Record<string, string>, cancelled?: boolean) => void;
}

/**
 * In-flight ask_user question card (one at a time, like the approval
 * queue head). The extension only ever has one ask_user in flight per
 * turn, so we model this as a single nullable slot rather than a queue.
 */
export function useAskUserRequest(): AskUserRequestHook {
  const [askUserRequest, setAskUserRequest] = useState<AskUserRequestState | null>(null);

  const requestAskUser = useCallback(
    (id: string, questions: AskUserQuestionPayload[]) => {
      setAskUserRequest((prev) => (prev && prev.id === id ? prev : { id, questions }));
    },
    []
  );

  const handleAskUserSubmit = useCallback(
    (id: string, answers: Record<string, string>, cancelled?: boolean) => {
      setAskUserRequest(null);
      vscode.postMessage({ type: "userInputResponse", id, answers, cancelled });
    },
    []
  );

  return { askUserRequest, requestAskUser, handleAskUserSubmit };
}

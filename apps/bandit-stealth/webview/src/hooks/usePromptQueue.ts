/**
 * Prompts typed while the agent works, for the extension's chat.
 *
 * The queue itself (order, one turn at a time, stop on a turn that does not
 * finish) is agent-ui's `useMessageQueue`, shared with the desktop IDE and
 * kept to the CLI's rules. This hook connects it to the extension host:
 *
 * - Each send carries a `turnId`; the host answers with `promptSettled`
 *   and how the prompt ended (done / cancelled / failed / refused), which
 *   is what lets the queue stop after a failed turn instead of sending the
 *   next message into the same error.
 * - `stop` cancels the turn and hands what was queued back (`onReturn`),
 *   unsent. So does a failed or cancelled turn.
 * - The queue is saved in the webview state, because the view reloads
 *   whenever it is hidden. On the first state snapshot after a reload, the
 *   queue waits for the turn it had sent if the host is still running it,
 *   carries on if it finished, and otherwise hands the messages back:
 *   nothing runs on its own after a reload it cannot account for.
 */
import { useCallback, useEffect, useRef } from "react";
import {
  useMessageQueue,
  type MessageQueue,
  type QueueTurnOutcome,
  type QueuedMessage
} from "@burtson-labs/agent-ui";
import type { WebviewState } from "../types/webview";
import {
  patchSavedState,
  readSavedState,
  type SavedPromptQueueMessage
} from "../state/savedState";

export type PromptQueueMessage = SavedPromptQueueMessage;
export type QueuedPrompt = QueuedMessage<PromptQueueMessage>;

/** Why queued prompts came back to the composer. */
export type PromptReturnReason = "stopped" | "failed" | "edit" | "reloaded";

export interface PromptQueueOptions {
  /** The host's busy flag (a turn is running). */
  busy: boolean;
  /** Queued prompts handed back, unsent: put them in the composer. */
  onReturn: (items: QueuedPrompt[], reason: PromptReturnReason) => void;
}

export interface PromptQueue {
  items: QueuedPrompt[];
  /** Sends now when idle, else queues behind the running turn. */
  submit: (message: PromptQueueMessage) => "sent" | "queued";
  remove: (id: string) => void;
  /** Takes one prompt back into the composer to edit. */
  edit: (id: string) => void;
  /** Stop: cancels the turn and hands the queue back. */
  stop: () => void;
}

let turnCounter = 0;
function newTurnId(): string {
  turnCounter += 1;
  return `turn-${Date.now().toString(36)}-${turnCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

function isOutcome(value: unknown): value is QueueTurnOutcome {
  return value === "done" || value === "cancelled" || value === "failed" || value === "refused";
}

export function usePromptQueue({ busy, onReturn }: PromptQueueOptions): PromptQueue {
  const onReturnRef = useRef(onReturn);
  onReturnRef.current = onReturn;
  // What the last load of this view left behind, read before this one
  // saves anything over it.
  const savedAtLoadRef = useRef<ReturnType<typeof readSavedState>["promptQueue"] | null>(null);
  if (savedAtLoadRef.current === null) {
    savedAtLoadRef.current = readSavedState().promptQueue;
  }
  // Turns sent and not yet settled, by id.
  const waitingRef = useRef(new Map<string, (outcome: QueueTurnOutcome) => void>());
  const inFlightRef = useRef<string | null>(null);
  const itemsRef = useRef<QueuedPrompt[]>([]);

  const save = useCallback(() => {
    patchSavedState({
      promptQueue: { items: itemsRef.current, inFlightTurnId: inFlightRef.current }
    });
  }, []);

  const waitFor = useCallback((turnId: string): Promise<QueueTurnOutcome> => {
    inFlightRef.current = turnId;
    return new Promise<QueueTurnOutcome>((resolve) => {
      waitingRef.current.set(turnId, resolve);
    });
  }, []);

  const send = useCallback(
    (message: PromptQueueMessage): Promise<QueueTurnOutcome> => {
      const turnId = newTurnId();
      const settled = waitFor(turnId);
      save();
      vscode.postMessage({
        type: "sendPrompt",
        text: message.text,
        mode: "agent",
        files: message.files.length ? message.files : undefined,
        images: message.images.length ? message.images : undefined,
        autoContext: message.autoContext,
        turnId
      });
      return settled;
    },
    [save, waitFor]
  );

  const queue: MessageQueue<PromptQueueMessage> = useMessageQueue<PromptQueueMessage>({
    isStreaming: busy,
    send,
    onHalted: (back, outcome) => onReturnRef.current(back, outcome === "cancelled" ? "stopped" : "failed")
  });
  itemsRef.current = queue.items;

  useEffect(() => {
    save();
  }, [queue.items, save]);

  const { restore } = queue;
  const restoredRef = useRef(false);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as
        | { type?: string; turnId?: unknown; outcome?: unknown; state?: WebviewState }
        | undefined;
      if (!message || typeof message !== "object") {return;}

      if (message.type === "promptSettled" && typeof message.turnId === "string") {
        const resolve = waitingRef.current.get(message.turnId);
        if (!resolve) {return;}
        waitingRef.current.delete(message.turnId);
        if (inFlightRef.current === message.turnId) {inFlightRef.current = null;}
        save();
        resolve(isOutcome(message.outcome) ? message.outcome : "failed");
        return;
      }

      // First snapshot after a (re)load: pick a saved queue back up.
      if (message.type === "state" && message.state && !restoredRef.current) {
        restoredRef.current = true;
        const saved = savedAtLoadRef.current;
        savedAtLoadRef.current = undefined;
        if (!saved) {return;}
        const savedItems = Array.isArray(saved.items) ? saved.items : [];
        const savedTurn = typeof saved.inFlightTurnId === "string" ? saved.inFlightTurnId : null;
        const state = message.state;
        if (savedTurn && state.activeTurnId === savedTurn) {
          // Still running: wait for it as if this view had just sent it.
          restore(savedItems, waitFor(savedTurn));
          return;
        }
        if (savedItems.length === 0) {
          if (savedTurn) {
            inFlightRef.current = null;
            save();
          }
          return;
        }
        const settled = state.lastSettledTurn;
        if (savedTurn && settled?.turnId === savedTurn && settled.outcome === "done") {
          restore(savedItems);
          return;
        }
        // The turn ended without finishing, or the host does not know it
        // (VS Code reloaded): nothing is sent; the messages go back.
        inFlightRef.current = null;
        const reason: PromptReturnReason =
          savedTurn && settled?.turnId === savedTurn
            ? settled.outcome === "cancelled" ? "stopped" : "failed"
            : "reloaded";
        onReturnRef.current(savedItems, reason);
        save();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [restore, save, waitFor]);

  const { take, takeAll, remove, submit } = queue;
  const edit = useCallback(
    (id: string) => {
      const item = take(id);
      if (item) {onReturnRef.current([item], "edit");}
    },
    [take]
  );

  const stop = useCallback(() => {
    // Back in the composer at once: the turn itself can take a while to
    // unwind (a command that ignores the abort).
    const back = takeAll();
    if (back.length > 0) {onReturnRef.current(back, "stopped");}
    vscode.postMessage({ type: "cancelResponse" });
  }, [takeAll]);

  return { items: queue.items, submit, remove, edit, stop };
}

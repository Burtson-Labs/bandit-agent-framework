/**
 * Messages sent while the agent is still working.
 *
 * A chat runs one turn at a time. Sending while a turn runs queues the
 * message; queued messages run in order, each once the turn before it ends.
 * The host lists them (ChatComposer's `queuedItems`), where each can be taken
 * back to edit (`take`) or removed (`remove`).
 *
 * Stop, and any turn that ends without finishing (it failed, it was
 * cancelled elsewhere, or no turn could start), stops the queue too: what was
 * queued comes back to the caller (`takeAll`, `onHalted`), which puts it in
 * the composer unsent. A queue that kept going after a failure would send
 * every message into the same error; one that dropped them would lose what
 * the user wrote.
 *
 * The same rules are kept by the Bandit CLI (input/lineQueue.ts) and the
 * desktop IDE (local/messageQueue.ts), so a queued message behaves the same
 * on every surface.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** How a turn ended. Anything but `done` stops the queue. */
export type QueueTurnOutcome = "done" | "cancelled" | "failed" | "refused";

/** What a queued message must carry. Hosts add their own fields (attached
 *  files, a context toggle…); the queue keeps them with the message. */
export interface QueueMessageInput {
  text: string;
  images?: string[];
}

export type QueuedMessage<M extends QueueMessageInput = QueueMessageInput> = M & { id: string };

export interface MessageQueueOptions<M extends QueueMessageInput = QueueMessageInput> {
  /** The host's own "a turn is running" flag. A turn the queue did not start
   *  (another surface, a command) holds the queue back too. */
  isStreaming: boolean;
  /** Starts a turn and resolves with how it ended. A rejection counts as
   *  `failed`. */
  send: (message: M) => Promise<QueueTurnOutcome>;
  /** The queue stopped after a turn that did not finish; `items` were still
   *  waiting and are no longer queued. */
  onHalted?: (items: QueuedMessage<M>[], outcome: Exclude<QueueTurnOutcome, "done">) => void;
}

export interface MessageQueue<M extends QueueMessageInput = QueueMessageInput> {
  items: QueuedMessage<M>[];
  /** Sends now when nothing is running or waiting, else queues behind it. */
  submit: (message: M) => "sent" | "queued";
  remove: (id: string) => void;
  /** Takes one message out of the queue (to edit it). */
  take: (id: string) => QueuedMessage<M> | undefined;
  /** Empties the queue and returns what was in it, oldest first. */
  takeAll: () => QueuedMessage<M>[];
  /** Puts messages saved before a reload back at the front of the queue.
   *  With `running`, a turn this queue started before the reload that is
   *  still going: the queue waits for it as if it had sent it, stopping when
   *  it does not finish. Without it, they run once nothing is running. */
  restore: (items: QueuedMessage<M>[], running?: Promise<QueueTurnOutcome>) => void;
}

let nextId = 0;
/** A queue id, unique within the page. */
export function createQueuedMessageId(): string {
  nextId += 1;
  return `queued-${Date.now().toString(36)}-${nextId}`;
}

/** The composer text after `items` come back into it: after what is already
 *  there, one message per paragraph, in their order. */
export function draftWithQueued(current: string, items: readonly Pick<QueueMessageInput, "text">[]): string {
  return [current, ...items.map((item) => item.text)]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
}

export function useMessageQueue<M extends QueueMessageInput = QueueMessageInput>({
  isStreaming,
  send,
  onHalted,
}: MessageQueueOptions<M>): MessageQueue<M> {
  const [items, setItemsState] = useState<QueuedMessage<M>[]>([]);
  // Read synchronously by submit and the drain below (several can happen
  // inside one render).
  const itemsRef = useRef<QueuedMessage<M>[]>([]);
  const setItems = useCallback((next: QueuedMessage<M>[]) => {
    itemsRef.current = next;
    setItemsState(next);
  }, []);
  // True from the moment a send is made until its turn has ended. The
  // host's isStreaming flag lags behind the send (a round trip to the
  // extension host, an image check), and must not let a second message out
  // in that gap.
  const busyRef = useRef(false);
  const sendRef = useRef(send);
  sendRef.current = send;
  const onHaltedRef = useRef(onHalted);
  onHaltedRef.current = onHalted;
  // Bumped when a send settles, so the drain looks again.
  const [settled, setSettled] = useState(0);

  const takeAll = useCallback((): QueuedMessage<M>[] => {
    const all = itemsRef.current;
    if (all.length > 0) {setItems([]);}
    return all;
  }, [setItems]);

  const follow = useCallback(
    (turn: Promise<QueueTurnOutcome>) => {
      busyRef.current = true;
      const settle = (outcome: QueueTurnOutcome) => {
        busyRef.current = false;
        if (outcome !== "done") {
          const rest = takeAll();
          if (rest.length > 0) {onHaltedRef.current?.(rest, outcome);}
        }
        setSettled((n) => n + 1);
      };
      turn.then(settle, () => settle("failed"));
    },
    [takeAll],
  );

  const dispatch = useCallback(
    (message: M) => {
      let turn: Promise<QueueTurnOutcome>;
      try {
        turn = sendRef.current(message);
      } catch (error) {
        turn = Promise.reject(error);
      }
      follow(turn);
    },
    [follow],
  );

  const restore = useCallback(
    (saved: QueuedMessage<M>[], running?: Promise<QueueTurnOutcome>) => {
      if (running) {follow(running);}
      if (saved.length > 0) {setItems([...saved, ...itemsRef.current]);}
    },
    [follow, setItems],
  );

  const submit = useCallback(
    (message: M): "sent" | "queued" => {
      if (isStreaming || busyRef.current || itemsRef.current.length > 0) {
        setItems([...itemsRef.current, { ...message, id: createQueuedMessageId() }]);
        return "queued";
      }
      dispatch(message);
      return "sent";
    },
    [dispatch, isStreaming, setItems],
  );

  useEffect(() => {
    if (isStreaming || busyRef.current) {return;}
    const [next, ...rest] = itemsRef.current;
    if (!next) {return;}
    setItems(rest);
    const { id: _id, ...message } = next;
    void _id;
    dispatch(message as unknown as M);
  }, [dispatch, isStreaming, items, setItems, settled]);

  const remove = useCallback(
    (id: string) => setItems(itemsRef.current.filter((item) => item.id !== id)),
    [setItems],
  );

  const take = useCallback(
    (id: string): QueuedMessage<M> | undefined => {
      const found = itemsRef.current.find((item) => item.id === id);
      if (found) {setItems(itemsRef.current.filter((item) => item.id !== id));}
      return found;
    },
    [setItems],
  );

  return { items, submit, remove, take, takeAll, restore };
}

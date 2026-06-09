import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CompletedChangeEntry,
  type DiffPreviewAction,
  persistStoredDiffEntries,
  readStoredDiffEntries
} from "../state/diffStorage";

export const DIFF_PREVIEW_DISMISS_DELAY_MS = 2400;

export interface DiffPreviewCardState {
  path: string;
  hasBackup: boolean;
  status: "idle" | "pending" | "success" | "error";
  lastAction?: DiffPreviewAction;
  message?: string;
}

export interface DiffSnapshotPayload {
  path?: string;
  diff?: string;
  summary?: { added: number; removed: number };
  confidence?: number;
  stepId?: string;
}

export interface DiffPreviewCardPayload {
  path?: string;
  hasBackup?: boolean;
}

export interface DiffPreviewResultPayload {
  path?: string;
  status: DiffPreviewAction | "error";
  message?: string;
}

export interface UseLiveDiffEntriesOpts {
  /**
   * Current conversation id — drives the localStorage key the persisted
   * entries round-trip through. When it changes, the hook re-reads
   * from storage and resets live entries (seeded from persisted iff
   * the agent run can still be undone, otherwise empty).
   */
  conversationId: string | undefined;
  /**
   * Mirrors the extension's "can the agent's last batch be reverted?"
   * cap. Drives whether `liveDiffEntries` is seeded from storage
   * (so the FilesChangedSummaryCard's undo affordance is meaningful)
   * or starts empty.
   */
  canUndoAgentChange: boolean;
}

export interface LiveDiffEntriesHook {
  /** Diffs the current turn / undo-window is touching. */
  liveDiffEntries: Record<string, CompletedChangeEntry>;
  /** Same shape, but persisted to localStorage keyed by conversation id. */
  persistedDiffEntries: Record<string, CompletedChangeEntry>;
  /** Active diff-preview cards rendered above the conversation. */
  diffPreviewCards: Record<string, DiffPreviewCardState>;

  // ── dispatch handlers (called from the message switch) ──────────
  /** Apply an `agent:diffSnapshot` message — merge the path/diff/summary into liveDiffEntries. */
  handleDiffSnapshot: (payload: DiffSnapshotPayload) => void;
  /** Apply a `diffPreviewCard` message — show a fresh card + ensure a live entry exists. */
  handleDiffPreviewCard: (preview: DiffPreviewCardPayload) => void;
  /** Apply a `diffPreviewResult` — flip the card to success/error and schedule a dismiss on success. */
  handleDiffPreviewResult: (payload: DiffPreviewResultPayload) => void;
  /** Apply a `diffPreviewClear` — drop all cards + cancel all pending dismiss timers. */
  handleDiffPreviewClear: () => void;

  // ── user actions (called from JSX) ──────────────────────────────
  /** User clicked Apply/Discard/Explain on a card — flip to pending + post the wire action. */
  handleDiffPreviewAction: (path: string, action: DiffPreviewAction) => void;
  /** User clicked Undo on the FilesChangedSummaryCard. */
  handleUndoAgentChanges: () => void;
  /**
   * Clear live entries without persisting (e.g. at the start of a fresh
   * agent turn, or on conversation switch — internal effect already
   * uses this on conversation change).
   */
  clearLiveDiffEntries: () => void;
}

/**
 * Owns the live-diff lifecycle in the webview:
 * - liveDiffEntries / persistedDiffEntries / diffPreviewCards state
 * - the localStorage round-trip keyed on conversationId
 * - the per-card auto-dismiss timers (cleared on unmount)
 * - the diff-snapshot + diff-preview wire-message handlers
 * - the user Apply/Discard/Explain + Undo actions
 */
export function useLiveDiffEntries(opts: UseLiveDiffEntriesOpts): LiveDiffEntriesHook {
  const { conversationId, canUndoAgentChange } = opts;

  const [liveDiffEntries, setLiveDiffEntriesState] = useState<Record<string, CompletedChangeEntry>>({});
  const [persistedDiffEntries, setPersistedDiffEntries] = useState<Record<string, CompletedChangeEntry>>({});
  const [diffPreviewCards, setDiffPreviewCards] = useState<Record<string, DiffPreviewCardState>>({});
  // window.setTimeout returns number in DOM lib, but @types/node's
  // global setTimeout returns Timeout — both are in scope here, so
  // pin the ref type to number explicitly and cast when storing.
  const diffPreviewTimers = useRef<Record<string, number>>({});
  const conversationIdRef = useRef<string | undefined>(conversationId);

  // Keep the conversation id ref in sync — syncPersistedDiffEntries
  // reads it from a ref so that an in-flight updater closure always
  // sees the current conversation rather than the one captured when
  // the callback was created.
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  // Conversation-id / undo-cap change: re-read from storage, then
  // seed live entries from the stored set iff the undo window is
  // still open. Otherwise live entries start empty for the new turn.
  useEffect(() => {
    const stored = readStoredDiffEntries(conversationId);
    setPersistedDiffEntries(stored);
    setLiveDiffEntriesState(canUndoAgentChange ? stored : {});
  }, [conversationId, canUndoAgentChange]);

  // Unmount cleanup — drop every pending auto-dismiss timer so we
  // don't fire setState into a dead React tree.
  useEffect(
    () => () => {
      Object.values(diffPreviewTimers.current).forEach((timer) => clearTimeout(timer));
      diffPreviewTimers.current = {};
    },
    []
  );

  const syncPersistedDiffEntries = useCallback(
    (entries: Record<string, CompletedChangeEntry>) => {
      setPersistedDiffEntries(entries);
      persistStoredDiffEntries(conversationIdRef.current, entries);
    },
    []
  );

  const updateLiveDiffEntries = useCallback(
    (
      updater:
        | Record<string, CompletedChangeEntry>
        | ((prev: Record<string, CompletedChangeEntry>) => Record<string, CompletedChangeEntry>),
      options?: { persist?: boolean }
    ) => {
      setLiveDiffEntriesState((previous) => {
        const next =
          typeof updater === "function"
            ? (updater as (prev: Record<string, CompletedChangeEntry>) => Record<string, CompletedChangeEntry>)(previous)
            : updater;
        if (options?.persist !== false) {
          syncPersistedDiffEntries(next);
        }
        return next;
      });
    },
    [syncPersistedDiffEntries]
  );

  const dismissDiffPreviewCard = useCallback((path: string, delay = 0) => {
    if (!path) {
      return;
    }
    const clearTimer = () => {
      if (diffPreviewTimers.current[path]) {
        clearTimeout(diffPreviewTimers.current[path]);
        delete diffPreviewTimers.current[path];
      }
    };
    const removeCard = () => {
      clearTimer();
      setDiffPreviewCards((prev) => {
        if (!prev[path]) {
          return prev;
        }
        const next = { ...prev };
        delete next[path];
        return next;
      });
    };
    if (delay > 0) {
      clearTimer();
      diffPreviewTimers.current[path] = window.setTimeout(removeCard, delay);
      return;
    }
    removeCard();
  }, []);

  const handleDiffSnapshot = useCallback(
    (payload: DiffSnapshotPayload) => {
      if (typeof payload.path !== "string") {
        return;
      }
      const path = payload.path;
      updateLiveDiffEntries((prev) => {
        const existing = prev[path];
        return {
          ...prev,
          [path]: {
            path,
            diffText: typeof payload.diff === "string" ? payload.diff : existing?.diffText,
            added: typeof payload.summary?.added === "number" ? payload.summary.added : existing?.added,
            removed:
              typeof payload.summary?.removed === "number" ? payload.summary.removed : existing?.removed
          }
        };
      });
    },
    [updateLiveDiffEntries]
  );

  const handleDiffPreviewCard = useCallback(
    (preview: DiffPreviewCardPayload) => {
      if (!preview?.path) {
        return;
      }
      const path = preview.path;
      setDiffPreviewCards((prev) => ({
        ...prev,
        [path]: {
          path,
          hasBackup: Boolean(preview.hasBackup),
          status: "idle"
        }
      }));
      updateLiveDiffEntries((prev) => ({
        ...prev,
        [path]: prev[path] ?? { path }
      }));
    },
    [updateLiveDiffEntries]
  );

  const handleDiffPreviewResult = useCallback(
    (payload: DiffPreviewResultPayload) => {
      if (!payload.path) {
        return;
      }
      const path = payload.path;
      setDiffPreviewCards((prev) => {
        const current = prev[path];
        if (!current) {
          return prev;
        }
        const nextState: DiffPreviewCardState =
          payload.status === "error"
            ? {
                ...current,
                status: "error",
                message: payload.message ?? "Unable to process diff."
              }
            : {
                ...current,
                status: "success",
                lastAction: payload.status,
                message:
                  payload.status === "apply"
                    ? "Applied changes."
                    : payload.status === "discard"
                      ? "Discarded changes."
                      : "Explained in chat."
              };
        return { ...prev, [path]: nextState };
      });
      updateLiveDiffEntries((prev) => {
        const existing = prev[path] ?? { path };
        return {
          ...prev,
          [path]: { ...existing }
        };
      });
      if (payload.status !== "error") {
        dismissDiffPreviewCard(path, DIFF_PREVIEW_DISMISS_DELAY_MS);
      }
    },
    [dismissDiffPreviewCard, updateLiveDiffEntries]
  );

  const handleDiffPreviewClear = useCallback(() => {
    Object.values(diffPreviewTimers.current).forEach((timer) => clearTimeout(timer));
    diffPreviewTimers.current = {};
    setDiffPreviewCards({});
  }, []);

  const handleDiffPreviewAction = useCallback((path: string, action: DiffPreviewAction) => {
    if (!path) {
      return;
    }
    setDiffPreviewCards((prev) => {
      const card = prev[path] ?? { path, hasBackup: false, status: "idle" as const };
      if (card.status === "pending") {
        return prev;
      }
      return {
        ...prev,
        [path]: {
          ...card,
          status: "pending",
          lastAction: action,
          message:
            action === "apply"
              ? "Applying changes…"
              : action === "discard"
                ? "Discarding changes…"
                : "Preparing explanation…"
        }
      };
    });
    vscode.postMessage({ type: "diffPreviewAction", path, action });
  }, []);

  const clearLiveDiffEntries = useCallback(() => {
    updateLiveDiffEntries(() => ({}), { persist: false });
  }, [updateLiveDiffEntries]);

  const handleUndoAgentChanges = useCallback(() => {
    updateLiveDiffEntries(() => ({}), { persist: false });
    setDiffPreviewCards({});
    vscode.postMessage({ type: "undoAgentChange" });
  }, [updateLiveDiffEntries]);

  return {
    liveDiffEntries,
    persistedDiffEntries,
    diffPreviewCards,
    handleDiffSnapshot,
    handleDiffPreviewCard,
    handleDiffPreviewResult,
    handleDiffPreviewClear,
    handleDiffPreviewAction,
    handleUndoAgentChanges,
    clearLiveDiffEntries
  };
}

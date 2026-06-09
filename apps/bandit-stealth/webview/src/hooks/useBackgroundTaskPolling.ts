import { useCallback, useMemo, useState } from "react";
import type { BackgroundTaskRecord } from "../types/backgroundTasks";

export interface BackgroundTaskPollingHook {
  /** All currently-known tasks, sorted by startedAt ascending (oldest first). */
  tasks: BackgroundTaskRecord[];
  /** Whether the BackgroundTaskTile is expanded. */
  panelOpen: boolean;
  /** Flip the expanded state — wired to the tile's summary-button onClick. */
  togglePanelOpen: () => void;
  /** Outbound `cancelBackgroundTask` for the tile's per-row Cancel button. */
  cancelTask: (taskId: string) => void;
  /**
   * Dismiss a finished task. Optimistically flips `consumed: true` on
   * the local copy so the tile reacts the instant the user clicks (the
   * extension's eventual backgroundTaskUpdate broadcast confirms),
   * then posts `dismissBackgroundTask` to the extension. Without the
   * optimistic flip the dismiss feels laggy on first paint of the next
   * render.
   */
  dismissTask: (taskId: string) => void;
  /**
   * Receive a `backgroundTaskList` snapshot from the extension. Replaces
   * the entire map rather than merging — covers the case where the
   * panel reopened and tasks finished while it was hidden.
   */
  setBackgroundTasksList: (next: BackgroundTaskRecord[]) => void;
  /**
   * Receive a single `backgroundTaskUpdate` patch. Always overwrites —
   * the extension owns the truth, the webview is just a projection.
   */
  applyBackgroundTaskUpdate: (task: BackgroundTaskRecord) => void;
}

/**
 * Owns the background-subagent task map + the BackgroundTaskTile's
 * expanded state, plus the outbound cancel/dismiss + inbound list/
 * update dispatchers.
 *
 * Note: there is no on-mount poll today. The extension pushes the
 * initial `backgroundTaskList` snapshot as part of the boot state and
 * broadcasts updates afterward, so the hook is purely a reducer over
 * inbound events plus the optimistic dismiss action.
 */
export function useBackgroundTaskPolling(): BackgroundTaskPollingHook {
  const [tasksById, setTasksById] = useState<Record<string, BackgroundTaskRecord>>({});
  const [panelOpen, setPanelOpen] = useState(false);

  const tasks = useMemo(
    () => Object.values(tasksById).sort((a, b) => a.startedAt - b.startedAt),
    [tasksById]
  );

  const togglePanelOpen = useCallback(() => {
    setPanelOpen((v) => !v);
  }, []);

  const cancelTask = useCallback((taskId: string) => {
    vscode.postMessage({ type: "cancelBackgroundTask", taskId });
  }, []);

  const dismissTask = useCallback((taskId: string) => {
    setTasksById((prev) => {
      const current = prev[taskId];
      if (!current) {return prev;}
      return { ...prev, [taskId]: { ...current, consumed: true } };
    });
    vscode.postMessage({ type: "dismissBackgroundTask", taskId });
  }, []);

  const setBackgroundTasksList = useCallback((next: BackgroundTaskRecord[]) => {
    const map: Record<string, BackgroundTaskRecord> = {};
    for (const t of next ?? []) {map[t.id] = t;}
    setTasksById(map);
  }, []);

  const applyBackgroundTaskUpdate = useCallback((task: BackgroundTaskRecord) => {
    setTasksById((prev) => ({ ...prev, [task.id]: task }));
  }, []);

  return {
    tasks,
    panelOpen,
    togglePanelOpen,
    cancelTask,
    dismissTask,
    setBackgroundTasksList,
    applyBackgroundTaskUpdate
  };
}

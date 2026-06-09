import { useCallback, useState } from "react";
import type {
  TraceDetailPayload,
  TraceSummaryPayload,
  TraceViewMode
} from "../types/trace";

export interface UseTracePanelOpts {
  /**
   * App-level side effects to run when the trace panel opens
   * (typically: close the history drawer + set activePage to
   * "workspace" + post a `showHistory: false` to the extension so
   * the host stops painting the drawer).
   *
   * Skipped on close — the panel just closes itself.
   */
  onOpen?: () => void;
}

export interface TracePanelHook {
  tracePanelOpen: boolean;
  traceViewMode: TraceViewMode;
  traceList: TraceSummaryPayload[];
  traceDetail: TraceDetailPayload | null;
  traceLoading: boolean;
  traceError: string | null;

  // ── inbound dispatcher setters ─────────────────────────────────
  // Exposed because dispatchTraceMessage's deps object reads each
  // setter directly. Once Arc W4 evolves to deps-as-hook-instance
  // these can collapse.
  setTracePanelOpen: (open: boolean) => void;
  setTraceViewMode: (mode: TraceViewMode) => void;
  setTraceList: (list: TraceSummaryPayload[]) => void;
  setTraceLoading: (loading: boolean) => void;
  setTraceError: (error: string | null) => void;
  setTraceDetail: (detail: TraceDetailPayload | null) => void;

  // ── outbound user actions ──────────────────────────────────────
  /** Post `requestTraceList` for the given mode (defaults to the current view mode). */
  requestTraceList: (mode?: TraceViewMode) => void;
  /** Post `requestTraceDetail` for a single trace id (no-op for empty ids). */
  requestTraceDetail: (id: string) => void;
  /**
   * Toolbar button: opens the panel + fires the on-open side effect
   * + requests a fresh list. Re-clicking closes the panel.
   */
  handleOpenTracePanel: () => void;
  /** User picks "All" vs "Needs attention" — drops the detail and refetches. */
  handleTraceModeChange: (mode: TraceViewMode) => void;
  /** "Refresh" button — re-requests the current mode's list. */
  handleTraceRefresh: () => void;
}

/**
 * Owns the trace browser's full state surface — panel open/close +
 * list + detail + loading/error + view mode — and the outbound
 * wire-message actions. The inbound `traceList`/`traceDetail`/
 * `traceError` dispatches still route through messageDispatch/
 * traceMessages.ts; this hook just exposes the setters that
 * dispatcher's deps shape reads.
 */
export function useTracePanel(opts: UseTracePanelOpts = {}): TracePanelHook {
  const { onOpen } = opts;
  const [tracePanelOpen, setTracePanelOpen] = useState(false);
  const [traceViewMode, setTraceViewMode] = useState<TraceViewMode>("all");
  const [traceList, setTraceList] = useState<TraceSummaryPayload[]>([]);
  const [traceDetail, setTraceDetail] = useState<TraceDetailPayload | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);

  const requestTraceList = useCallback(
    (mode: TraceViewMode = traceViewMode) => {
      setTraceLoading(true);
      setTraceError(null);
      vscode.postMessage({ type: "requestTraceList", mode });
    },
    [traceViewMode]
  );

  const requestTraceDetail = useCallback((id: string) => {
    if (!id) {return;}
    setTraceLoading(true);
    setTraceError(null);
    vscode.postMessage({ type: "requestTraceDetail", id });
  }, []);

  const handleOpenTracePanel = useCallback(() => {
    if (tracePanelOpen) {
      setTracePanelOpen(false);
      return;
    }
    setTracePanelOpen(true);
    onOpen?.();
    requestTraceList(traceViewMode);
  }, [tracePanelOpen, traceViewMode, requestTraceList, onOpen]);

  const handleTraceModeChange = useCallback(
    (mode: TraceViewMode) => {
      setTraceViewMode(mode);
      setTraceDetail(null);
      requestTraceList(mode);
    },
    [requestTraceList]
  );

  const handleTraceRefresh = useCallback(() => {
    requestTraceList(traceViewMode);
  }, [requestTraceList, traceViewMode]);

  return {
    tracePanelOpen,
    traceViewMode,
    traceList,
    traceDetail,
    traceLoading,
    traceError,
    setTracePanelOpen,
    setTraceViewMode,
    setTraceList,
    setTraceLoading,
    setTraceError,
    setTraceDetail,
    requestTraceList,
    requestTraceDetail,
    handleOpenTracePanel,
    handleTraceModeChange,
    handleTraceRefresh
  };
}

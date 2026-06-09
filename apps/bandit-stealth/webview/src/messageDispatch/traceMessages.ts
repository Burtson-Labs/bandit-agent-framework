import type {
  TraceDetailPayload,
  TraceSummaryPayload,
  TraceViewMode
} from "../types/trace";
import type { WebviewMessage } from "../types/webviewMessage";

export interface TraceMessagesDeps {
  setTracePanelOpen: (open: boolean) => void;
  setTraceViewMode: (mode: TraceViewMode) => void;
  setTraceList: (list: TraceSummaryPayload[]) => void;
  setTraceLoading: (loading: boolean) => void;
  setTraceError: (error: string | null) => void;
  setTraceDetail: (detail: TraceDetailPayload | null) => void;
  /**
   * Outbound `requestTraceDetail` post, fired when traceList arrives
   * with a selectedId (or implicit-selects the first trace).
   */
  requestTraceDetail: (id: string) => void;
}

/**
 * Topic dispatcher for trace browser messages. The trace panel state
 * (open / view mode / loading / error / list / detail) is still
 * App-owned — this dispatcher is the routing slice and the
 * select-first-trace + auto-request-detail orchestration that fires
 * when a fresh `traceList` lands.
 */
export function dispatchTraceMessage(
  message: WebviewMessage,
  deps: TraceMessagesDeps
): boolean {
  switch (message.type) {
    case "traceList": {
      const traces = Array.isArray(message.traces) ? message.traces : [];
      deps.setTracePanelOpen(true);
      deps.setTraceViewMode(message.mode ?? "all");
      deps.setTraceList(traces);
      deps.setTraceLoading(false);
      deps.setTraceError(null);
      const nextId = message.selectedId || traces[0]?.id;
      if (nextId) {
        deps.setTraceLoading(true);
        deps.requestTraceDetail(nextId);
      } else {
        deps.setTraceDetail(null);
      }
      return true;
    }
    case "traceDetail":
      deps.setTracePanelOpen(true);
      deps.setTraceDetail(message.trace);
      deps.setTraceLoading(false);
      deps.setTraceError(null);
      return true;
    case "traceError":
      deps.setTracePanelOpen(true);
      deps.setTraceError(message.message);
      deps.setTraceLoading(false);
      return true;
    default:
      return false;
  }
}

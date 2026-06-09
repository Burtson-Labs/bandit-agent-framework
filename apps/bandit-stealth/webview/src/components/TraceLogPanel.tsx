import type { JSX } from "react";
import clsx from "clsx";
import { ArrowUpRightIcon, XCircleIcon } from "@heroicons/react/24/outline";
import type {
  TraceDetailPayload,
  TraceStatus,
  TraceSummaryPayload,
  TraceViewMode
} from "../types/trace";
import { formatTraceTimestamp, traceBasename } from "../util/trace";

function tracePreview(trace: TraceSummaryPayload): string {
  const source = trace.prompt || trace.finalPreview || trace.id;
  return source.length > 170 ? source.slice(0, 167).trimEnd() + "..." : source;
}

function traceStatusLabel(status: TraceStatus): string {
  if (status === "completed") {return "done";}
  if (status === "failed") {return "failed";}
  if (status === "blocked") {return "blocked";}
  if (status === "cancelled") {return "cancelled";}
  return "unknown";
}

export function TraceLogPanel(props: {
  traces: TraceSummaryPayload[];
  detail: TraceDetailPayload | null;
  mode: TraceViewMode;
  loading: boolean;
  error: string | null;
  onModeChange: (mode: TraceViewMode) => void;
  onRefresh: () => void;
  onSelectTrace: (id: string) => void;
  onOpenRaw: (path: string) => void;
  onClose: () => void;
}): JSX.Element {
  const {
    traces,
    detail,
    mode,
    loading,
    error,
    onModeChange,
    onRefresh,
    onSelectTrace,
    onOpenRaw,
    onClose
  } = props;
  const selectedId = detail?.summary.id;
  const selectedTrace = detail?.summary ?? traces.find((trace) => trace.id === selectedId) ?? null;

  return (
    <section className="trace-panel" aria-label="Trace logs">
      <div className="trace-panel__header">
        <div>
          <p className="trace-panel__eyebrow">Trace logs</p>
          <h2>Turns, tools, permissions</h2>
        </div>
        <div className="trace-panel__actions">
          <div className="trace-panel__segmented" role="tablist" aria-label="Trace filter">
            <button
              type="button"
              className={clsx(mode === "all" && "is-active")}
              onClick={() => onModeChange("all")}
            >
              All
            </button>
            <button
              type="button"
              className={clsx(mode === "failed" && "is-active")}
              onClick={() => onModeChange("failed")}
            >
              Needs attention
            </button>
          </div>
          <button type="button" className="stealth-button stealth-button--ghost" onClick={onRefresh}>
            Refresh
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close trace logs"
            onClick={onClose}
            data-has-tooltip="true"
            data-tooltip="Close"
            data-tooltip-align="right"
          >
            <XCircleIcon aria-hidden="true" />
          </button>
        </div>
      </div>

      {error && <div className="trace-panel__error" role="alert">{error}</div>}

      <div className="trace-panel__body">
        <aside className="trace-list" aria-label="Trace list">
          {loading && traces.length === 0 ? (
            <div className="trace-list__empty">Loading traces...</div>
          ) : traces.length === 0 ? (
            <div className="trace-list__empty">No traces found.</div>
          ) : (
            traces.map((trace) => (
              <button
                key={trace.id}
                type="button"
                className={clsx("trace-row", selectedId === trace.id && "is-active")}
                onClick={() => onSelectTrace(trace.id)}
              >
                <span className="trace-row__topline">
                  <span className={clsx("trace-status", `trace-status--${trace.status}`)}>
                    {traceStatusLabel(trace.status)}
                  </span>
                  <span className="trace-row__time">{formatTraceTimestamp(trace.startedAt)}</span>
                </span>
                <span className="trace-row__prompt">{tracePreview(trace)}</span>
                <span className="trace-row__meta">
                  <span>{trace.scope}</span>
                  <span>{traceBasename(trace.workspace)}</span>
                  <span>{trace.toolCalls} tools</span>
                  {trace.errors > 0 && <span>{trace.errors} errors</span>}
                  {trace.retries > 0 && <span>{trace.retries} retries</span>}
                </span>
              </button>
            ))
          )}
        </aside>

        <article className="trace-detail" aria-label="Trace detail">
          {!selectedTrace ? (
            <div className="trace-detail__empty">Select a trace.</div>
          ) : (
            <>
              <div className="trace-detail__header">
                <div>
                  <div className="trace-detail__title-row">
                    <span className={clsx("trace-status", `trace-status--${selectedTrace.status}`)}>
                      {traceStatusLabel(selectedTrace.status)}
                    </span>
                    <h3>{selectedTrace.id}</h3>
                  </div>
                  <p className="trace-detail__meta">
                    {formatTraceTimestamp(selectedTrace.startedAt)} · {selectedTrace.scope} · {traceBasename(selectedTrace.workspace)}
                  </p>
                </div>
                <button
                  type="button"
                  className="stealth-button stealth-button--ghost"
                  onClick={() => onOpenRaw(selectedTrace.filePath)}
                >
                  <ArrowUpRightIcon aria-hidden="true" />
                  Open JSONL
                </button>
              </div>

              <div className="trace-metrics" aria-label="Trace metrics">
                <span>{selectedTrace.iterations} iterations</span>
                <span>{selectedTrace.toolCalls} tool calls</span>
                <span>{selectedTrace.permissionRequests} permission prompts</span>
                <span>{selectedTrace.retries} retries</span>
                <span>{selectedTrace.nativeFallbacks} fallbacks</span>
              </div>

              {selectedTrace.prompt && (
                <section className="trace-block">
                  <h4>Prompt</h4>
                  <p>{selectedTrace.prompt}</p>
                </section>
              )}

              {detail?.summary.id === selectedTrace.id && (
                <>
                  <section className="trace-events" aria-label="Trace event timeline">
                    <h4>Timeline</h4>
                    <ol>
                      {detail.events.map((event, index) => (
                        <li key={`${event.t ?? "event"}-${index}`} className={clsx(event.isError && "is-error")}>
                          <span className="trace-event__time">{event.t ? event.t.slice(11, 19) : "--:--:--"}</span>
                          <span className="trace-event__type">{event.type}</span>
                          {typeof event.iteration === "number" && (
                            <span className="trace-event__iteration">i{event.iteration}</span>
                          )}
                          {event.detail && <span className="trace-event__detail">{event.detail}</span>}
                        </li>
                      ))}
                    </ol>
                  </section>

                  {selectedTrace.finalPreview && (
                    <section className="trace-block">
                      <h4>Final</h4>
                      <p>{selectedTrace.finalPreview}</p>
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </article>
      </div>
    </section>
  );
}

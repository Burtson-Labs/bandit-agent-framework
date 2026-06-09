import type { CSSProperties, JSX } from "react";
import { classNames } from "../utils/classNames";
import type { TelemetrySnapshot } from "../types/ui-schema";

export interface TelemetryPanelProps {
  telemetry: TelemetrySnapshot;
  title?: string;
  className?: string;
}

const formatDuration = (value?: number): string => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "—";
  }
  if (value < 1000) {
    return `${value.toFixed(0)} ms`;
  }
  const seconds = value / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m ${rem}s`;
};

const METRIC_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  minWidth: 0
};

const formatIntent = (intent?: string): string => {
  if (!intent) {
    return "Detected goal";
  }
  switch (intent) {
    case "fix":
      return "Bug fix";
    case "refactor":
      return "Refactor";
    case "feature":
      return "Feature work";
    case "analyze":
      return "Investigation";
    case "doc":
      return "Documentation";
    case "style":
      return "Styling";
    default:
      return intent;
  }
};

export const TelemetryPanel = ({
  telemetry,
  title = "Telemetry",
  className
}: TelemetryPanelProps): JSX.Element => {
  const tokens = telemetry.tokens ?? { input: 0, output: 0, total: 0 };
  const totalSteps = telemetry.totalSteps ?? telemetry.completedSteps + telemetry.failedSteps;
  return (
    <section className={classNames("agent-ui-panel agent-ui-telemetry", className)}>
      <header className="agent-ui-panel__header">
        <div>
          <p className="agent-ui-panel__eyebrow">{title}</p>
          <h3 className="agent-ui-panel__title">{telemetry.model ?? telemetry.provider ?? "Unidentified Provider"}</h3>
        </div>
        <span className="agent-ui-panel__meta">
          {telemetry.completedSteps} / {totalSteps} steps
        </span>
      </header>
      <div className="agent-ui-telemetry__grid">
        <article className="agent-ui-metric" style={METRIC_STYLE}>
          <label>Input Tokens</label>
          <strong>{tokens.input.toLocaleString()}</strong>
        </article>
        <article className="agent-ui-metric" style={METRIC_STYLE}>
          <label>Output Tokens</label>
          <strong>{tokens.output.toLocaleString()}</strong>
        </article>
        <article className="agent-ui-metric" style={METRIC_STYLE}>
          <label>Total Tokens</label>
          <strong>{tokens.total.toLocaleString()}</strong>
        </article>
        {typeof tokens.cache === "number" && (
          <article className="agent-ui-metric" style={METRIC_STYLE}>
            <label>Cache Hits</label>
            <strong>{tokens.cache.toLocaleString()}</strong>
          </article>
        )}
        <article className="agent-ui-metric" style={METRIC_STYLE}>
          <label>Latency</label>
          <strong>{formatDuration(telemetry.latencyMs)}</strong>
        </article>
        <article className="agent-ui-metric" style={METRIC_STYLE}>
          <label>Steps</label>
          <strong>
            {telemetry.completedSteps}
            <span style={{ fontSize: "0.85rem", color: "var(--agent-ui-text-dim)" }}>
              {" / "}
              {totalSteps}
            </span>
          </strong>
        </article>
        {telemetry.averageStepDurationMs !== undefined && (
          <article className="agent-ui-metric" style={METRIC_STYLE}>
            <label>Avg Step Duration</label>
            <strong>{formatDuration(telemetry.averageStepDurationMs)}</strong>
          </article>
        )}
        {telemetry.goalInsight && (
          <article className="agent-ui-metric" style={METRIC_STYLE}>
            <label>Intent</label>
            <strong>{formatIntent(telemetry.goalInsight.intent)}</strong>
            {telemetry.goalInsight.files?.length ? (
              <span style={{ fontSize: "0.8rem", color: "var(--agent-ui-text-dim)" }}>
                {(telemetry.goalInsight.files ?? []).slice(0, 2).join(", ")}
              </span>
            ) : null}
          </article>
        )}
        {telemetry.taskProgress && (
          <article className="agent-ui-metric" style={METRIC_STYLE}>
            <label>Tasks Complete</label>
            <strong>
              {telemetry.taskProgress.completed}
              <span style={{ fontSize: "0.85rem", color: "var(--agent-ui-text-dim)" }}>
                {" / "}
                {telemetry.taskProgress.total}
              </span>
            </strong>
          </article>
        )}
      </div>
    </section>
  );
};

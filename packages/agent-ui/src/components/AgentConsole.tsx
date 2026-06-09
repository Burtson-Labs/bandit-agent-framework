import { useMemo } from "react";
import type { JSX, ReactNode } from "react";
import type { AgentEvent, AgentStep } from "@burtson-labs/agent-core";
import type { AgentConsoleEntry, StepCompletePayload } from "../types/ui-schema";
import { classNames } from "../utils/classNames";

export interface AgentConsoleProps {
  events?: AgentEvent[];
  limit?: number;
  title?: string;
  emptyState?: ReactNode;
  className?: string;
}

interface LogPayload {
  level?: "info" | "warn" | "error" | "debug";
  message?: string;
  metadata?: Record<string, unknown>;
}

const RELEVANT_TYPES = new Set([
  "plan:start",
  "plan:complete",
  "plan:chunk",
  "step:start",
  "step:complete",
  "diff:apply",
  "log",
  "report:chunk",
  "report:complete"
]);

const formatTimestamp = (timestamp: number): string => {
  try {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    return String(timestamp);
  }
};

const toEntry = (event: AgentEvent): AgentConsoleEntry | null => {
  if (!RELEVANT_TYPES.has(event.type)) {
    return null;
  }

  if (event.type === "log") {
    const payload = (event.payload as LogPayload | undefined) ?? {};
    const message = payload.message ?? JSON.stringify(event.payload);
    return {
      id: `${event.type}:${event.timestamp}`,
      label: "log",
      message,
      timestamp: event.timestamp,
      level: payload.level ?? "info",
      metadata: payload.metadata
    };
  }

  if (event.type === "plan:start") {
    const payload = event.payload as { goal?: string } | undefined;
    return {
      id: `${event.type}:${event.timestamp}`,
      label: "plan",
      message: `Planning started${payload?.goal ? `: ${payload.goal}` : ""}`,
      timestamp: event.timestamp,
      level: "info"
    };
  }

  if (event.type === "plan:complete") {
    return {
      id: `${event.type}:${event.timestamp}`,
      label: "plan",
      message: "Plan completed and ready to execute.",
      timestamp: event.timestamp,
      level: "info"
    };
  }

  if (event.type === "plan:chunk" || event.type === "report:chunk") {
    const payload = event.payload as { chunk?: string } | undefined;
    if (!payload?.chunk) {
      return null;
    }
    return {
      id: `${event.type}:${event.timestamp}:${payload.chunk.length}`,
      label: event.type === "plan:chunk" ? "plan" : "report",
      message: payload.chunk.trim(),
      timestamp: event.timestamp,
      level: "debug"
    };
  }

  if (event.type === "report:complete") {
    return {
      id: `${event.type}:${event.timestamp}`,
      label: "report",
      message: "Report completed.",
      timestamp: event.timestamp,
      level: "info"
    };
  }

  if (event.type === "step:start") {
    const payload = event.payload as { step?: AgentStep } | undefined;
    return {
      id: `${event.type}:${payload?.step?.id ?? event.timestamp}`,
      label: payload?.step?.title ?? "Step",
      message: "Execution started.",
      timestamp: event.timestamp,
      level: "info"
    };
  }

  if (event.type === "step:complete") {
    const payload = event.payload as StepCompletePayload | undefined;
    const result = payload?.result;
    const level = result?.status === "failed" ? "error" : "info";
    const message =
      result?.logs?.join("\n") ??
      (result?.status === "failed" ? "Step failed." : "Step completed successfully.");
    return {
      id: `${event.type}:${payload?.step?.id ?? event.timestamp}`,
      label: payload?.step?.title ?? "Step",
      message,
      timestamp: event.timestamp,
      level,
      metadata: result?.metadata as Record<string, unknown> | undefined
    };
  }

  if (event.type === "diff:apply") {
    const payload = event.payload as { step?: AgentStep; diff?: { path: string }[] } | undefined;
    const diffList = payload?.diff?.map((diff) => diff.path).join(", ");
    return {
      id: `${event.type}:${event.timestamp}`,
      label: payload?.step?.title ?? "Diff",
      message: diffList ? `Applied diff: ${diffList}` : "Diff applied.",
      timestamp: event.timestamp,
      level: "debug"
    };
  }

  return null;
};

export const AgentConsole = ({
  events = [],
  limit = 200,
  title = "Console",
  emptyState,
  className
}: AgentConsoleProps): JSX.Element => {
  const entries = useMemo(() => {
    const mapped = events.map(toEntry).filter(Boolean) as AgentConsoleEntry[];
    if (limit > 0) {
      return mapped.slice(-limit);
    }
    return mapped;
  }, [events, limit]);

  if (!entries.length) {
    return (
      <div className={classNames("agent-ui-panel agent-ui-empty-state", className)}>
        {emptyState ?? <p>No console output yet.</p>}
      </div>
    );
  }

  return (
    <section className={classNames("agent-ui-panel agent-ui-console", className)}>
      <header className="agent-ui-panel__header">
        <div>
          <p className="agent-ui-panel__eyebrow">{title}</p>
          <h3 className="agent-ui-panel__title">Agent output</h3>
        </div>
      </header>
      <ul className="agent-ui-console__log">
        {entries.map((entry) => (
          <li key={entry.id} className="agent-ui-console__entry" data-level={entry.level}>
            <span className="agent-ui-console__timestamp">{formatTimestamp(entry.timestamp)}</span>
            <span className="agent-ui-console__label">{entry.label}</span>
            <span>{entry.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
};

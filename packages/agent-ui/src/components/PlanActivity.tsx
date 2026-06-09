import { useMemo } from "react";
import type { JSX } from "react";
import type { AgentEvent, AgentExecutionResult, AgentStep } from "@burtson-labs/agent-core";
import { classNames } from "../utils/classNames";
import {
  BoltIcon,
  CheckCircleIcon,
  Cog6ToothIcon,
  ExclamationTriangleIcon,
  XCircleIcon
} from "@heroicons/react/24/outline";

type ActivityStatus = "start" | "update" | "complete" | "error" | "needs-revision";

export interface PlanActivityEntry {
  id: string;
  title: string;
  summary?: string;
  status: ActivityStatus;
  stepId?: string;
  timestamp: number;
}

export interface PlanActivityProps {
  events?: AgentEvent[];
  limit?: number;
  className?: string;
  showEmptyState?: boolean;
}

interface StepCompletePayload {
  step?: AgentStep;
  result?: AgentExecutionResult;
}

const TURN_TOKEN_REGEX = /<\/?\|?(?:im_start|im_end|start_of_turn|end_of_turn)\|?>/gi;

const stripTurnTokens = (value?: string | null): string => {
  if (!value) {
    return "";
  }
  return value.replace(TURN_TOKEN_REGEX, "").trim();
};

const formatSummary = (text?: string | null): string | undefined => {
  const cleaned = stripTurnTokens(text);
  return cleaned.length ? cleaned : undefined;
};

const mapStatusFromResult = (status?: string): ActivityStatus => {
  switch (status) {
    case "failed":
    case "error":
      return "error";
    case "needs-revision":
    case "warn":
      return "needs-revision";
    case "completed":
    case "done":
      return "complete";
    default:
      return "update";
  }
};

const getTimelineColor = (status: ActivityStatus): string => {
  switch (status) {
    case "complete":
      return "rgba(123, 228, 149, 0.28)";
    case "error":
      return "rgba(255, 177, 153, 0.28)";
    case "needs-revision":
      return "rgba(255, 216, 130, 0.28)";
    case "start":
      return "rgba(149, 209, 255, 0.24)";
    default:
      return "rgba(149, 209, 255, 0.18)";
  }
};

const getStatusLabel = (status: ActivityStatus): string => {
  switch (status) {
    case "start":
      return "In progress";
    case "complete":
      return "Completed";
    case "error":
      return "Blocked";
    case "needs-revision":
      return "Needs attention";
    default:
      return "Update";
  }
};

const getStatusIcon = (status: ActivityStatus): JSX.Element => {
  switch (status) {
    case "start":
      return <Cog6ToothIcon />;
    case "complete":
      return <CheckCircleIcon />;
    case "error":
      return <XCircleIcon />;
    case "needs-revision":
      return <ExclamationTriangleIcon />;
    default:
      return <BoltIcon />;
  }
};

const buildEntries = (events: AgentEvent[] = [], limit = 50): PlanActivityEntry[] => {
  const entries: PlanActivityEntry[] = [];

  for (const event of events) {
    if (event.type === "plan:start") {
      const payload = event.payload as { goal?: string } | undefined;
      const goal = stripTurnTokens(payload?.goal);
      entries.push({
        id: `${event.type}:${event.timestamp}`,
        title: goal ? `Plan: ${goal}` : "Agent plan started",
        summary: formatSummary(goal) ?? "Preparing execution plan…",
        status: "start",
        timestamp: event.timestamp
      });
      continue;
    }

    if (event.type === "plan:complete") {
      entries.push({
        id: `${event.type}:${event.timestamp}`,
        title: "Plan complete",
        summary: "Steps are ready to execute.",
        status: "complete",
        timestamp: event.timestamp
      });
      continue;
    }

    if (event.type === "plan:chunk") {
      const payload = event.payload as { chunk?: string } | undefined;
      if (payload?.chunk) {
        entries.push({
          id: `${event.type}:${event.timestamp}`,
          title: "Planning update",
          summary: payload.chunk,
          status: "update",
          timestamp: event.timestamp
        });
      }
      continue;
    }

    if (event.type === "step:start") {
      const payload = event.payload as { step?: AgentStep } | undefined;
      const title = stripTurnTokens(payload?.step?.title);
      const description = stripTurnTokens(payload?.step?.description);
      entries.push({
        id: `${event.type}:${payload?.step?.id ?? event.timestamp}`,
        title: title || "Executing step",
        summary: formatSummary(description) ?? "Working…",
        status: "update",
        stepId: payload?.step?.id,
        timestamp: event.timestamp
      });
      continue;
    }

    if (event.type === "step:complete") {
      const payload = event.payload as StepCompletePayload | undefined;
      const resultStatus = mapStatusFromResult(payload?.result?.status);
      const logs = stripTurnTokens(payload?.result?.logs?.join("\n"));
      const title = stripTurnTokens(payload?.step?.title);
      entries.push({
        id: `${event.type}:${payload?.step?.id ?? event.timestamp}`,
        title: title || "Step complete",
        summary: formatSummary(logs) ?? `Status: ${payload?.result?.status ?? "completed"}`,
        status: resultStatus,
        stepId: payload?.step?.id,
        timestamp: event.timestamp
      });
      continue;
    }

    if (event.type === "diff:apply") {
      const payload = event.payload as { step?: AgentStep; diff?: { path?: string }[] } | undefined;
      const diffPreview = payload?.diff
        ?.map((diff) => stripTurnTokens(diff.path))
        .filter(Boolean)
        .join(", ");
      const title = stripTurnTokens(payload?.step?.title);
      entries.push({
        id: `${event.type}:${event.timestamp}`,
        title: title ? `Diff applied • ${title}` : "Diff applied",
        summary: formatSummary(diffPreview) ?? "Changes enqueued for review.",
        status: "update",
        stepId: payload?.step?.id,
        timestamp: event.timestamp
      });
      continue;
    }

    if (event.type === "report:complete") {
      entries.push({
        id: `${event.type}:${event.timestamp}`,
        title: "Report ready",
        summary: "Agent produced a final report.",
        status: "complete",
        timestamp: event.timestamp
      });
    }
  }

  if (limit > 0) {
    return entries.slice(-limit);
  }
  return entries;
};

export const PlanActivity = ({
  events = [],
  limit = 50,
  className,
  showEmptyState = true
}: PlanActivityProps): JSX.Element | null => {
  const entries = useMemo(() => buildEntries(events, limit), [events, limit]);

  if (!entries.length) {
    if (!showEmptyState) {
      return null;
    }
    return (
      <div className={classNames("agent-ui-panel agent-ui-empty-state", className)}>
        <p>No live steps yet. Start a plan to see instant feedback.</p>
      </div>
    );
  }

  return (
    <section className={classNames("agent-ui-panel agent-ui-plan-activity", className)}>
      <header className="agent-ui-panel__header">
        <div>
          <p className="agent-ui-panel__eyebrow">Instant Feedback</p>
          <h3 className="agent-ui-panel__title">Live Steps</h3>
        </div>
        <span className="agent-ui-panel__meta">{entries.length} updates</span>
      </header>

      <div className="plan-activity-host">
        {entries.map((entry) => (
          <article key={entry.id} className="message assistant plan-activity">
            <div className="message-body assistant">
              <div className="message-content">
                <div
                  className="plan-activity-row"
                  style={{ ["--timeline-color" as string]: getTimelineColor(entry.status) }}
                >
                  <span
                    className={classNames("plan-activity-icon", `plan-activity-${entry.status}`)}
                  >
                    {getStatusIcon(entry.status)}
                  </span>
                  <div className="plan-activity-text">
                    <p className="plan-activity-title">{entry.title}</p>
                    <p className="plan-activity-summary">
                      {entry.summary ?? getStatusLabel(entry.status)}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
};

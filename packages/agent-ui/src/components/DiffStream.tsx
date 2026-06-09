import { useMemo } from "react";
import type { JSX, ReactNode } from "react";
import type { AgentDiff, AgentEvent, AgentStep } from "@burtson-labs/agent-core";
import type { DiffStreamEntry } from "../types/ui-schema";
import { classNames } from "../utils/classNames";
import { DiffBlock } from "./DiffBlock";

interface DiffStreamProps {
  events?: AgentEvent[];
  limit?: number;
  emptyState?: ReactNode;
  title?: string;
  className?: string;
}

interface DiffEventPayload {
  step?: AgentStep;
  diff?: AgentDiff[];
}

const toEntries = (events: AgentEvent[], limit?: number): DiffStreamEntry[] => {
  const diffEvents = events.filter((event) => event.type === "diff:apply");
  const entries: DiffStreamEntry[] = [];

  for (const event of diffEvents) {
    const payload = event.payload as DiffEventPayload | undefined;
    if (!payload?.diff?.length) {
      continue;
    }

    payload.diff.forEach((diff, index) => {
      entries.push({
        id: `${event.timestamp}:${diff.path}:${index}`,
        timestamp: event.timestamp,
        stepId: payload.step?.id,
        stepTitle: payload.step?.title,
        diff
      });
    });
  }

  if (typeof limit === "number" && limit > 0) {
    return entries.slice(-limit);
  }

  return entries;
};

const formatDiffLabel = (diff: AgentDiff): string => {
  const verb = diff.type === "create" ? "Created" : diff.type === "delete" ? "Deleted" : "Updated";
  return `${verb} ${diff.path}`;
};

export const DiffStream = ({
  events = [],
  limit = 25,
  emptyState,
  title = "Live Diffs",
  className
}: DiffStreamProps): JSX.Element => {
  const entries = useMemo(() => toEntries(events, limit), [events, limit]);

  if (!entries.length) {
    return (
      <div className={classNames("agent-ui-panel agent-ui-empty-state", className)}>
        {emptyState ?? <p>No diffs have been streamed yet.</p>}
      </div>
    );
  }

  return (
    <div className={classNames("agent-ui-panel agent-ui-diff-stream", className)}>
      <header className="agent-ui-panel__header">
        <div>
          <p className="agent-ui-panel__eyebrow">{title}</p>
          <h3 className="agent-ui-panel__title">Recent file activity</h3>
        </div>
        <span className="agent-ui-panel__meta">
          Showing {entries.length} recent change{entries.length === 1 ? "" : "s"}
        </span>
      </header>

      <div className="agent-ui-diff-stream__list">
        {entries.map((entry) => (
          <article
            key={entry.id}
            className="agent-ui-diff-card"
            data-type={entry.diff.type}
          >
            <div className="agent-ui-diff-card__header">
              <div>
                <p className="agent-ui-plan-step__title">{entry.diff.path}</p>
                {entry.stepTitle && (
                  <p className="agent-ui-plan-step__description">Step: {entry.stepTitle}</p>
                )}
              </div>
              <span className="agent-ui-badge">{entry.diff.type}</span>
            </div>
            {entry.diff.preview && (
              <DiffBlock source={entry.diff.preview} className="agent-ui-diff-preview" />
            )}
            {!entry.diff.preview && (
              <p className="agent-ui-plan-step__description">{formatDiffLabel(entry.diff)}</p>
            )}
          </article>
        ))}
      </div>
    </div>
  );
};

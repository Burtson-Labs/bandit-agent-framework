import type {
  AgentStepStatus,
  Task as AgentTask,
  TaskStatus
} from "@burtson-labs/agent-core";
import type {
  ConversationPlanStepState,
  Plan,
  PlanRunSummary
} from "../types/webview";
import { stripTurnTokens } from "../util/stripTurnTokens";

export type PlanActivityStatus = "start" | "update" | "complete" | "error" | "needs-revision";

export interface PlanActivityCardEntry {
  id: string;
  stepId?: string;
  title: string;
  summary: string;
  status: PlanActivityStatus;
  timestamp: number;
}

export const PLAN_ACTIVITY_LIMIT = 12;

export const mapPlanUpdateStateToTaskStatus = (
  state?: string,
  fallback: TaskStatus = "pending"
): TaskStatus => {
  const normalized = (state ?? "").toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "complete" || normalized === "done" || normalized === "approved") {
    return "completed";
  }
  if (normalized === "error" || normalized === "failed" || normalized === "needs-revision") {
    return "failed";
  }
  if (normalized === "start" || normalized === "progress" || normalized === "update") {
    return "in_progress";
  }
  return fallback;
};

export const readTaskMetadataString = (task: AgentTask, key: string): string | undefined => {
  if (!task.metadata || typeof task.metadata !== "object") {
    return undefined;
  }
  const value = (task.metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

export const mapPlanActivityStatus = (state?: string): PlanActivityStatus => {
  switch ((state ?? "").toLowerCase()) {
    case "start":
      return "start";
    case "complete":
    case "done":
    case "approved":
      return "complete";
    case "error":
    case "failed":
      return "error";
    case "needs-revision":
    case "warn":
    case "attention":
      return "needs-revision";
    default:
      return "update";
  }
};

export const getPlanActivityStatusLabel = (status: PlanActivityStatus): string => {
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

export const findActivePlanRun = (
  history: PlanRunSummary[],
  activeRunId: string | null
): PlanRunSummary | null => {
  if (!history.length) {
    return null;
  }
  if (activeRunId) {
    const match = history.find((run) => run.id === activeRunId);
    if (match) {
      return match;
    }
  }
  let latest = history[0];
  for (const run of history) {
    if (run.createdAt > latest.createdAt) {
      latest = run;
    }
  }
  return latest;
};

export const buildPlanActivityEntries = (
  history: PlanRunSummary[],
  activeRunId: string | null,
  fallbackPlan: Plan | null,
  updates: Record<string, ConversationPlanStepState>
): PlanActivityCardEntry[] => {
  const run = findActivePlanRun(history, activeRunId);
  const planSource = run?.plan ?? fallbackPlan;
  if (!planSource) {
    return [];
  }
  const entries: PlanActivityCardEntry[] = [];
  const goal = stripTurnTokens(planSource.goal);
  entries.push({
    id: `${run?.id ?? "plan"}:start`,
    stepId: undefined,
    title: goal || "Agent plan started",
    summary: goal ? `Goal: ${goal}` : "Setting up plan steps…",
    status: "start",
    timestamp: run?.createdAt ?? Date.now()
  });
  const updateSource = run?.updates ?? updates;
  const orderedUpdates = Object.entries(updateSource)
    .map(([stepId, detail]) => ({
      stepId,
      detail,
      timestamp: detail.updatedAt ?? run?.updatedAt ?? Date.now()
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
  for (const { stepId, detail, timestamp } of orderedUpdates) {
    const status = mapPlanActivityStatus(detail.state);
    const stepIndex = planSource.steps.findIndex((step) => step.id === stepId);
    const stepTitle = stepIndex !== -1 ? stripTurnTokens(planSource.steps[stepIndex].title) : "";
    const label =
      stepIndex !== -1
        ? `Step ${stepIndex + 1}: ${stepTitle || `Step ${stepIndex + 1}`}`
        : "Plan step update";
    const summary = stripTurnTokens(detail.summary) || getPlanActivityStatusLabel(status);
    entries.push({
      id: `${run?.id ?? "plan"}:${stepId}:${timestamp}`,
      stepId,
      title: label,
      summary,
      status,
      timestamp
    });
  }
  if (entries.length > PLAN_ACTIVITY_LIMIT) {
    return entries.slice(-PLAN_ACTIVITY_LIMIT);
  }
  return entries;
};

export const mapStatus = (raw?: string): AgentStepStatus => {
  switch ((raw ?? "").toLowerCase()) {
    case "start":
    case "running":
    case "active":
      return "in_progress";
    case "complete":
    case "approved":
      return "completed";
    case "error":
    case "needs-revision":
    case "failed":
      return "failed";
    default:
      return "pending";
  }
};

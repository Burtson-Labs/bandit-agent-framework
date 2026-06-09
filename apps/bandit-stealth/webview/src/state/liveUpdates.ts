import {
  BoltIcon,
  CheckCircleIcon,
  Cog6ToothIcon,
  XCircleIcon
} from "@heroicons/react/24/outline";
import type {
  AgentEvent,
  AgentPlan,
  AgentStep
} from "@burtson-labs/agent-core";
import { stripTurnTokens } from "../util/stripTurnTokens";

export const LIVE_UPDATE_LIMIT = 12;
// Slow the cadence just enough to show progress animations while still streaming updates.
export const LIVE_UPDATE_INTERVAL_MS = 900;

export type LiveUpdateStatus = "start" | "progress" | "complete" | "error";

type HeroIconComponent = typeof Cog6ToothIcon;

export const LIVE_STATUS_ICON_MAP: Record<LiveUpdateStatus, HeroIconComponent> = {
  start: Cog6ToothIcon,
  progress: BoltIcon,
  complete: CheckCircleIcon,
  error: XCircleIcon
};

export const LIVE_STATUS_LABELS: Record<LiveUpdateStatus, string> = {
  start: "Starting",
  progress: "In progress",
  complete: "Completed",
  error: "Blocked"
};

export interface LiveUpdateDiff {
  path?: string;
  preview?: string;
  summary?: { added: number; removed: number };
  confidence?: number;
}

export interface LiveUpdateEntry {
  id: string;
  runId?: string | null;
  stepId?: string;
  title: string;
  summary?: string;
  path?: string;
  status: LiveUpdateStatus;
  diff?: LiveUpdateDiff;
  updatedAt: number;
}

interface StepCompleteEventPayload {
  step?: AgentStep;
  runId?: string | null;
  result?: {
    status?: string;
    logs?: string[];
    metadata?: Record<string, unknown>;
  };
}

interface DiffSnapshotPayload {
  runId?: string | null;
  path?: string;
  diff?: string;
  summary?: { added: number; removed: number };
  confidence?: number;
  stepId?: string;
}

export const getEventRunId = (event: AgentEvent): string | undefined => {
  const payload = event.payload as { runId?: string } | undefined;
  return typeof payload?.runId === "string" ? payload.runId : undefined;
};

export const extractLiveUpdates = (
  events: AgentEvent[],
  plan: AgentPlan | null
): LiveUpdateEntry[] => {
  if (!plan || !events.length) {
    return [];
  }

  const runId = plan.id;
  const stepMap = new Map<string, AgentStep>();
  plan?.steps.forEach((step) => {
    stepMap.set(step.id, step);
  });

  const entryOrder: string[] = [];
  const entries = new Map<string, LiveUpdateEntry>();
  const ensureEntry = (step: AgentStep): LiveUpdateEntry => {
    const existing = entries.get(step.id);
    if (existing) {
      return existing;
    }
    const base: LiveUpdateEntry = {
      id: `${runId}:${step.id}`,
      runId,
      stepId: step.id,
      title: stripTurnTokens(step.title) || "Agent step",
      summary: stripTurnTokens(step.description),
      path: step.metadata?.command ? String(step.metadata.command) : undefined,
      status: "start",
      updatedAt: Date.now()
    };
    entries.set(step.id, base);
    entryOrder.push(step.id);
    return base;
  };

  const coerceStep = (payloadStep?: AgentStep): AgentStep | undefined => {
    if (!payloadStep) {
      return undefined;
    }
    if (payloadStep.id && stepMap.has(payloadStep.id)) {
      return stepMap.get(payloadStep.id);
    }
    if (payloadStep.id) {
      stepMap.set(payloadStep.id, payloadStep);
    }
    return payloadStep;
  };

  let activeStepId: string | null = null;

  for (const event of events) {
    const eventRunId = getEventRunId(event);
    if (eventRunId && eventRunId !== runId) {
      continue;
    }

    if (event.type === "step:start") {
      const payload = event.payload as { step?: AgentStep } | undefined;
      const step = coerceStep(payload?.step);
      if (!step) {
        continue;
      }
      const current = ensureEntry(step);
      entries.set(step.id, {
        ...current,
        title: stripTurnTokens(step.title) || current.title,
        summary: stripTurnTokens(step.description) || current.summary,
        path: step.metadata?.command ? String(step.metadata.command) : current.path,
        status: "start",
        updatedAt: event.timestamp
      });
      activeStepId = step.id;
      continue;
    }

    if (event.type === "step:complete") {
      const payload = event.payload as StepCompleteEventPayload | undefined;
      const step = coerceStep(payload?.step);
      if (!step) {
        continue;
      }
      const status = payload?.result?.status === "failed" ? "error" : "complete";
      const summary =
        stripTurnTokens(payload?.result?.logs?.join("\n")) || stripTurnTokens(step.description);
      const current = ensureEntry(step);
      entries.set(step.id, {
        ...current,
        status,
        summary: summary || current.summary,
        path: step.metadata?.command ? String(step.metadata.command) : current.path,
        updatedAt: event.timestamp
      });
      if (activeStepId === step.id) {
        activeStepId = null;
      }
      continue;
    }

    if (event.type === "diff:snapshot") {
      const payload = event.payload as DiffSnapshotPayload | undefined;
      if (!payload) {
        continue;
      }
      const targetStepId =
        payload.stepId ??
        activeStepId ??
        (entryOrder.length > 0 ? entryOrder[entryOrder.length - 1] : undefined);
      if (!targetStepId) {
        continue;
      }
      const fallbackStep: AgentStep = stepMap.get(targetStepId) ?? {
        id: targetStepId,
        title: payload.path ?? "Agent step",
        description: ""
      };
      stepMap.set(targetStepId, fallbackStep);
      const current = ensureEntry(fallbackStep);
      entries.set(targetStepId, {
        ...current,
        status: current.status === "complete" || current.status === "error" ? current.status : "progress",
        path: payload.path ?? current.path,
        diff: {
          path: payload.path ?? current.diff?.path,
          preview: payload.diff ?? current.diff?.preview,
          summary: payload.summary ?? current.diff?.summary,
          confidence:
            typeof payload.confidence === "number" ? payload.confidence : current.diff?.confidence
        },
        updatedAt: event.timestamp
      });
    }
  }

  const orderedEntries = entryOrder
    .map((id) => entries.get(id))
    .filter((entry): entry is LiveUpdateEntry => Boolean(entry));

  if (orderedEntries.length > LIVE_UPDATE_LIMIT) {
    return orderedEntries.slice(-LIVE_UPDATE_LIMIT);
  }
  return orderedEntries;
};

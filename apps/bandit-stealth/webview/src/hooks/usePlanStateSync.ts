import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type {
  AgentEvent,
  AgentPlan,
  AgentStep,
  AgentStepStatus
} from "@burtson-labs/agent-core";
import type {
  ConversationPlanStepState,
  Plan,
  PlanRunSummary,
  WebviewState
} from "../types/webview";
import { mapStatus } from "../state/planSync";
import { stripTurnTokens } from "../util/stripTurnTokens";

// ─── Plan helper functions (moved out of App.tsx to live with the hook) ──

/**
 * Project an extension `Plan` (the wire shape) into the agent-ui
 * `AgentPlan` shape the renderer expects. Plays back the running
 * planUpdates over the steps so the rendered status reflects the
 * latest known state for each step.
 */
export const buildPlan = (
  plan: Plan | null | undefined,
  updates: Record<string, ConversationPlanStepState>,
  runId?: string | null
): AgentPlan | null => {
  if (!plan) {
    return null;
  }
  const goal = stripTurnTokens(plan.goal);
  return {
    id: runId ?? goal ?? "plan",
    goal,
    summary: goal,
    createdAt: Date.now(),
    version: "webview",
    steps: plan.steps.map((step, index) => ({
      id: step.id ?? `step-${index}`,
      title: stripTurnTokens(step.title) || `Step ${index + 1}`,
      description: stripTurnTokens(step.details),
      status: mapStatus(updates[step.id]?.state),
      metadata: step.command ? { command: step.command } : undefined
    }))
  };
};

const getStepFromPlan = (plan: AgentPlan | null, stepId: string): AgentStep | undefined =>
  plan?.steps.find((step) => step.id === stepId);

/**
 * Build a step lifecycle event from a status transition. Returns null
 * if the step isn't found in the plan (extension shouldn't emit those,
 * but defensive against drift). `appendEvents` calls this to surface
 * a single step's state change into the telemetry stream.
 */
const createStepEvent = (
  plan: AgentPlan | null,
  stepId: string,
  status: AgentStepStatus,
  meta?: { summary?: string; durationMs?: number; tokens?: number }
): AgentEvent | null => {
  const step = getStepFromPlan(plan, stepId);
  if (!step) {
    return null;
  }
  const timestamp = Date.now();
  const runId = plan?.id;
  if (status === "in_progress") {
    return {
      type: "step:start",
      timestamp,
      payload: { step, runId }
    };
  }
  if (status === "completed" || status === "failed") {
    return {
      type: "step:complete",
      timestamp,
      payload: {
        step,
        runId,
        result: {
          status: status === "failed" ? "failed" : "completed",
          logs: meta?.summary ? [meta.summary] : undefined,
          metadata: {
            durationMs: meta?.durationMs,
            tokens: meta?.tokens
          }
        }
      }
    };
  }
  return null;
};

// ─── Hook ────────────────────────────────────────────────────────────

/**
 * Subset of the AgentPlanUpdateMessage wire shape the hook consumes.
 * Modeled structurally so the hook doesn't need to import the full
 * WebviewMessage union.
 */
export interface AgentPlanUpdateMessage {
  stepId: string;
  status?: string;
  meta?: { summary?: string; durationMs?: number; tokens?: number };
  history?: PlanRunSummary[];
  activeRunId?: string | null;
}

export interface AgentPlanMessage {
  plan?: Plan | null;
  activeRunId?: string | null;
  history?: PlanRunSummary[];
}

export interface AgentPlanHistoryMessage {
  history: PlanRunSummary[];
  activeRunId?: string | null;
}

export interface UsePlanStateSyncOpts {
  /** Called when the hook generates step:start / step:complete / plan:start / plan:complete events. */
  appendEvents: (event: AgentEvent | AgentEvent[]) => void;
}

export interface PlanStateSyncHook {
  plan: AgentPlan | null;
  rawPlan: Plan | null;
  planUpdates: Record<string, ConversationPlanStepState>;
  planHistory: PlanRunSummary[];
  activePlanRunId: string | null;
  selectedStepId: string | undefined;
  setSelectedStepId: (id: string | undefined) => void;

  /**
   * Stale-closure-safe ref shadow of `plan`. Consumers whose message
   * listeners can't include `plan` in their effect deps (because doing
   * so would re-register the listener on every plan change) should
   * read `planRef.current` instead. The hook keeps it in sync via an
   * internal effect.
   */
  planRef: MutableRefObject<AgentPlan | null>;
  /** Same pattern as `planRef`, for the active run id. */
  activePlanRunIdRef: MutableRefObject<string | null>;

  /**
   * Apply the plan slice of a `state` boot/sync message. Replaces all
   * plan state; preserves selectedStepId if it's still valid, otherwise
   * seeds it from the first step.
   */
  applyStateSnapshot: (state: WebviewState) => void;
  /** Dispatch handler for the `agentPlan` wire message. */
  handleAgentPlan: (message: AgentPlanMessage) => void;
  /** Dispatch handler for the `agentPlanUpdate` wire message. */
  handleAgentPlanUpdate: (message: AgentPlanUpdateMessage) => void;
  /** Dispatch handler for the `agentPlanHistory` wire message. */
  handleAgentPlanHistory: (message: AgentPlanHistoryMessage) => void;
}

/**
 * Owns the plan + plan-updates + plan-history surface. Built around
 * three ref-shadowed state slots (plan, planUpdates, activePlanRunId)
 * so consumers can read current values without forcing their effect
 * listeners to re-register on every plan change.
 */
export function usePlanStateSync(opts: UsePlanStateSyncOpts): PlanStateSyncHook {
  const { appendEvents } = opts;

  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [rawPlan, setRawPlan] = useState<Plan | null>(null);
  const [planUpdates, setPlanUpdates] = useState<Record<string, ConversationPlanStepState>>({});
  const [planHistory, setPlanHistory] = useState<PlanRunSummary[]>([]);
  const [activePlanRunId, setActivePlanRunId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | undefined>();

  const planRef = useRef<AgentPlan | null>(null);
  const planUpdatesRef = useRef<Record<string, ConversationPlanStepState>>({});
  const activePlanRunIdRef = useRef<string | null>(null);

  // Ref shadows — kept in sync via effects so consumer closures can
  // read .current without re-registering on every plan change.
  useEffect(() => {
    planRef.current = plan;
  }, [plan]);

  useEffect(() => {
    activePlanRunIdRef.current = activePlanRunId;
  }, [activePlanRunId]);

  useEffect(() => {
    planUpdatesRef.current = planUpdates;
  }, [planUpdates]);

  // Clear selectedStepId when the plan is dropped (a stale selection
  // would point at a step that no longer exists).
  useEffect(() => {
    if (!plan && selectedStepId) {
      setSelectedStepId(undefined);
    }
  }, [plan, selectedStepId]);

  // Keep appendEvents in a ref so the dispatcher callbacks below stay
  // stable even when the consumer's identity changes between renders.
  const appendEventsRef = useRef(appendEvents);
  useEffect(() => {
    appendEventsRef.current = appendEvents;
  }, [appendEvents]);

  const applyStateSnapshot = useCallback((state: WebviewState) => {
    const nextPlanUpdates = state.planUpdates ?? {};
    setPlanUpdates(nextPlanUpdates);
    const nextRawPlan = state.plan ?? null;
    setRawPlan(nextRawPlan);
    const nextHistory = state.planHistory ?? [];
    setPlanHistory(nextHistory);
    const nextRunId = typeof state.activePlanRunId === "string" ? state.activePlanRunId : null;
    setActivePlanRunId(nextRunId);
    activePlanRunIdRef.current = nextRunId;
    const agentPlan = buildPlan(state.plan ?? null, nextPlanUpdates, state.activePlanRunId ?? undefined);
    setPlan(agentPlan);
    planRef.current = agentPlan;
    setSelectedStepId((current) => {
      if (current) {return current;}
      return agentPlan?.steps[0]?.id;
    });
  }, []);

  const handleAgentPlan = useCallback((message: AgentPlanMessage) => {
    const basePlan = buildPlan(
      message.plan ?? null,
      planUpdatesRef.current,
      message.activeRunId ?? undefined
    );
    setPlan(basePlan);
    planRef.current = basePlan;
    const nextRawPlan = message.plan ?? null;
    setRawPlan(nextRawPlan);
    if (Array.isArray(message.history)) {
      setPlanHistory(message.history);
    }
    if (Object.prototype.hasOwnProperty.call(message, "activeRunId")) {
      const nextRunId = typeof message.activeRunId === "string" ? message.activeRunId : null;
      setActivePlanRunId(nextRunId);
      activePlanRunIdRef.current = nextRunId;
    }
    if (basePlan) {
      appendEventsRef.current([
        {
          type: "plan:start",
          timestamp: Date.now(),
          payload: { goal: basePlan.goal, runId: basePlan.id }
        },
        {
          type: "plan:complete",
          timestamp: Date.now() + 1,
          payload: { plan: basePlan, runId: basePlan.id }
        }
      ]);
    }
  }, []);

  const handleAgentPlanUpdate = useCallback((message: AgentPlanUpdateMessage) => {
    if (Array.isArray(message.history)) {
      setPlanHistory(message.history);
    }
    if (Object.prototype.hasOwnProperty.call(message, "activeRunId")) {
      const nextRunId = typeof message.activeRunId === "string" ? message.activeRunId : null;
      setActivePlanRunId(nextRunId);
      activePlanRunIdRef.current = nextRunId;
    }
    const updates = { ...planUpdatesRef.current };
    const existing = updates[message.stepId] ?? {};
    updates[message.stepId] = {
      ...existing,
      state: message.status ?? existing.state,
      summary: stripTurnTokens(message.meta?.summary ?? existing.summary),
      durationMs: message.meta?.durationMs ?? existing.durationMs,
      tokens: message.meta?.tokens ?? existing.tokens
    };
    setPlanUpdates(updates);
    const currentPlan = planRef.current;
    const status = mapStatus(updates[message.stepId].state);
    if (currentPlan) {
      const nextPlan: AgentPlan = {
        ...currentPlan,
        steps: currentPlan.steps.map((step) =>
          step.id === message.stepId
            ? {
                ...step,
                status
              }
            : step
        )
      };
      setPlan(nextPlan);
      planRef.current = nextPlan;
    }
    const event = createStepEvent(planRef.current, message.stepId, status, message.meta);
    if (event) {
      appendEventsRef.current(event);
    }
  }, []);

  const handleAgentPlanHistory = useCallback((message: AgentPlanHistoryMessage) => {
    setPlanHistory(message.history);
    const nextRunId = Object.prototype.hasOwnProperty.call(message, "activeRunId")
      ? typeof message.activeRunId === "string"
        ? message.activeRunId
        : null
      : activePlanRunIdRef.current;
    setActivePlanRunId(nextRunId ?? null);
    activePlanRunIdRef.current = nextRunId ?? null;
  }, []);

  return {
    plan,
    rawPlan,
    planUpdates,
    planHistory,
    activePlanRunId,
    selectedStepId,
    setSelectedStepId,
    planRef,
    activePlanRunIdRef,
    applyStateSnapshot,
    handleAgentPlan,
    handleAgentPlanUpdate,
    handleAgentPlanHistory
  };
}

import { useMemo } from "react";
import type { JSX, ReactNode } from "react";
import { classNames } from "../utils/classNames";
import type { AgentEvent, AgentPlan, AgentStep, AgentStepStatus } from "@burtson-labs/agent-core";
import type { PlanTreeState, StepCompletePayload } from "../types/ui-schema";

export interface PlanTreeProps {
  events?: AgentEvent[];
  plan?: AgentPlan | null;
  selectedStepId?: string;
  onSelectStep?: (step: AgentStep) => void;
  emptyState?: ReactNode;
  title?: string;
  className?: string;
}

const STATUS_LABELS: Record<AgentStepStatus, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  completed: "Completed",
  failed: "Failed"
};

const STATUS_CLASS_MAP: Record<AgentStepStatus, string> = {
  pending: "is-pending",
  in_progress: "is-active",
  completed: "is-done",
  failed: "is-error"
};

const extractPlanState = (events: AgentEvent[], explicitPlan?: AgentPlan | null): PlanTreeState => {
  const planFromEvents = [...events]
    .reverse()
    .find((event) => event.type === "plan:complete" && (event.payload as { plan?: AgentPlan })?.plan)
    ?.payload as { plan?: AgentPlan } | undefined;

  const plan = explicitPlan ?? planFromEvents?.plan ?? null;

  if (!plan) {
    return { plan: null, stepStatuses: {} };
  }

  const baseStatuses: Record<string, AgentStepStatus> = {};
  for (const step of plan.steps) {
    baseStatuses[step.id] = step.status ?? "pending";
  }

  for (const event of events) {
    if (event.type === "step:start") {
      const payload = event.payload as { step?: AgentStep } | undefined;
      if (payload?.step?.id) {
        baseStatuses[payload.step.id] = "in_progress";
      }
      continue;
    }
    if (event.type === "step:complete") {
      const payload = event.payload as StepCompletePayload | undefined;
      if (payload?.step?.id) {
        baseStatuses[payload.step.id] = payload.result?.status ?? "completed";
      }
      continue;
    }
    if (event.type === "step:error") {
      const payload = event.payload as { step?: AgentStep } | undefined;
      if (payload?.step?.id) {
        baseStatuses[payload.step.id] = "failed";
      }
    }
  }

  return { plan, stepStatuses: baseStatuses };
};

export const PlanTree = ({
  events = [],
  plan: planOverride,
  selectedStepId,
  onSelectStep,
  emptyState,
  title = "Execution Plan",
  className
}: PlanTreeProps): JSX.Element => {
  const { plan, stepStatuses } = useMemo<PlanTreeState>(
    () => extractPlanState(events, planOverride ?? undefined),
    [events, planOverride]
  );

  if (!plan) {
    return (
      <div className={classNames("agent-ui-panel agent-ui-empty-state", className)}>
        {emptyState ?? <p>No plan available yet. Trigger planning to populate this view.</p>}
      </div>
    );
  }

  return (
    <div className={classNames("agent-ui-panel agent-ui-plan-tree", className)}>
      <header className="agent-ui-panel__header">
        <div>
          <p className="agent-ui-panel__eyebrow">{title}</p>
          <h3 className="agent-ui-panel__title">{plan.goal}</h3>
          {plan.summary && <p className="agent-ui-panel__subtitle">{plan.summary}</p>}
        </div>
        <span className="agent-ui-panel__meta">
          {plan.steps.length} step{plan.steps.length === 1 ? "" : "s"}
        </span>
      </header>

      <ol className="agent-ui-plan-list inline-plan-steps">
        {plan.steps.map((step: AgentStep, index: number) => {
          const status = stepStatuses[step.id] ?? "pending";
          const isSelected = selectedStepId === step.id;
          const command = step.metadata?.command;
          const hasCommand = command !== undefined && command !== null;
          return (
            <li
              key={step.id}
              className={classNames(
                "agent-ui-plan-step",
                "plan-card-step",
                STATUS_CLASS_MAP[status],
                isSelected && "is-selected",
                onSelectStep && "is-clickable"
              )}
              onClick={() => onSelectStep?.(step)}
            >
              <span className="agent-ui-plan-step__rail" aria-hidden="true" />
              <span className="agent-ui-plan-step__index plan-card-index">{index + 1}</span>
              <div className="agent-ui-plan-step__body plan-card-step-body">
                <div className="agent-ui-plan-step__row">
                  <p className="agent-ui-plan-step__title plan-card-step-title">{step.title}</p>
                  <span className="agent-ui-plan-step__badge">{STATUS_LABELS[status]}</span>
                </div>
                {step.description && (
                  <p className="agent-ui-plan-step__description plan-card-step-summary">
                    {step.description}
                  </p>
                )}

                {hasCommand && (
                  <pre className="agent-ui-plan-step__command">
                    <code>{String(command)}</code>
                  </pre>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

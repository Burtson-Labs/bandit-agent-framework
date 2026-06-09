import type { AgentEvent } from "@burtson-labs/agent-core";
import type {
  AgentPlanHistoryMessage,
  AgentPlanMessage,
  AgentPlanUpdateMessage
} from "../hooks/usePlanStateSync";
import type { AgentTelemetryPayload } from "../types/webview";
import type { WebviewMessage } from "../types/webviewMessage";

export interface PlanMessagesDeps {
  // Plan-state slice (from usePlanStateSync):
  handleAgentPlan: (message: AgentPlanMessage) => void;
  handleAgentPlanUpdate: (message: AgentPlanUpdateMessage) => void;
  handleAgentPlanHistory: (message: AgentPlanHistoryMessage) => void;

  // App-owned side effects of a fresh plan (drop the live ticker, the
  // events trail, and the goal-inference hints — those touch state
  // outside the plan slice):
  resetForFreshPlan: () => void;

  // Telemetry routing for agentTelemetry:
  setGoalFileHints: (hints: { files: string[]; intent?: string } | null) => void;
  buildAndAppendTelemetryEvent: (telemetry: AgentTelemetryPayload) => AgentEvent;
  appendEvents: (event: AgentEvent | AgentEvent[]) => void;
}

/**
 * Topic dispatcher for plan / plan-update / plan-history / telemetry
 * messages. Routes the plain plan-state slice straight into the hook;
 * preserves App's "fresh plan resets the live ticker + events trail"
 * side effect via the resetForFreshPlan callback; threads the
 * goal-inference hint extraction inline because it's a small,
 * dispatcher-specific projection.
 */
export function dispatchPlanMessage(
  message: WebviewMessage,
  deps: PlanMessagesDeps
): boolean {
  switch (message.type) {
    case "agentPlan":
      deps.resetForFreshPlan();
      deps.handleAgentPlan(message);
      return true;
    case "agentPlanUpdate":
      deps.handleAgentPlanUpdate(message);
      return true;
    case "agentPlanHistory":
      deps.handleAgentPlanHistory(message);
      return true;
    case "agentTelemetry": {
      if (message.telemetry.kind === "goal-inference") {
        const files = Array.isArray(message.telemetry.goal?.files)
          ? message.telemetry.goal.files.filter(
              (file): file is string => typeof file === "string" && file.length > 0
            )
          : [];
        if (files.length > 0) {
          deps.setGoalFileHints({
            files,
            intent:
              typeof message.telemetry.goal?.intent === "string"
                ? message.telemetry.goal.intent
                : undefined
          });
        } else {
          deps.setGoalFileHints(
            typeof message.telemetry.goal?.intent === "string"
              ? { files: [], intent: message.telemetry.goal.intent }
              : null
          );
        }
      }
      deps.appendEvents(deps.buildAndAppendTelemetryEvent(message.telemetry));
      return true;
    }
    default:
      return false;
  }
}

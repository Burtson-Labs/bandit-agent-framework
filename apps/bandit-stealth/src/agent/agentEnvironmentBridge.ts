/**
 * `dispatchAgentEnvironmentMessage` — bridge between
 * `StealthAgentRuntime`'s `agent:*` event stream and the webview /
 * conversation-state mutations the provider used to do inline at
 * `applyAgentEnvironmentMessage` (L3519 pre-extraction).
 *
 * Four message types flow through here:
 *
 *  - `agent:plan` starts a new plan run (or clears the active one when
 *    the payload's plan is null/empty) and broadcasts the new plan +
 *    history to the webview. `setRunContext` fires in BOTH branches so
 *    a turn that doesn't emit a plan still clears stale run-context
 *    wiring before the next plan-emitting turn.
 *  - `agent:planUpdate` merges a step-state delta onto the active run
 *    and broadcasts the merged history.
 *  - `agent:telemetry` is fire-and-forget: a telemetry payload without
 *    a `stepId` skips the step-state merge but still emits the
 *    `agentTelemetry` webview message (the webview shows token/duration
 *    overlays for non-plan telemetry too).
 *  - `agent:final` writes the evaluation onto the active run if one
 *    exists and re-broadcasts history. The `AWAITING_GUIDANCE_PREFIX`-
 *    matching message composition is preserved verbatim (silent today,
 *    but kept as the canonical place to wire a future surface).
 *
 * Load-bearing behaviors carried over from the inline form:
 *
 *  - `planStates` is cleared BEFORE the new run lands — both branches
 *    funnel through `ConversationService.startPlanRun` /
 *    `clearActivePlan`, which clear internally. Without this a second
 *    `agent:plan` in the same conversation rendered with stale step
 *    badges from the first run.
 *  - `planRuns` is capped at 10 entries inside `startPlanRun`.
 *  - The two webview messages (`agentPlan` + `agentPlanHistory`) fire
 *    even when planData is null — the webview's plan card relies on
 *    receiving both to clear its UI.
 */
import { environmentService } from './environmentService';
import { AWAITING_GUIDANCE_PREFIX } from './feedbackService';
import type { AgentReport, AgentTelemetryMessage, Plan } from '@burtson-labs/stealth-core-runtime';
import type { ConversationPlanStepState, SerializedPlanRun } from '../services/conversationTypes';
import type { ProviderContext } from '../provider/context';

export interface AgentEnvironmentBridgeDeps {
  /** Reads `banditStealth.debug.emitPlanJson` so the bridge can decide
   *  whether new runs get an on-disk artifacts directory. */
  arePlanArtifactsEnabled(): boolean;
}

export async function dispatchAgentEnvironmentMessage(
  ctx: ProviderContext,
  deps: AgentEnvironmentBridgeDeps,
  message: unknown
): Promise<void> {
  if (!message || typeof message !== 'object') {return;}

  const payload = message as { type?: string };
  const type = typeof payload.type === 'string' ? payload.type : '';
  if (!type.startsWith('agent:')) {return;}

  if (type === 'agent:plan') {
    await handlePlan(ctx, deps, payload as { plan?: Plan });
    return;
  }

  if (type === 'agent:planUpdate') {
    handlePlanUpdate(ctx, payload as {
      stepId?: string;
      state?: string;
      meta?: { summary?: string; durationMs?: number; tokens?: number };
    });
    return;
  }

  if (type === 'agent:telemetry') {
    handleTelemetry(ctx, payload as AgentTelemetryMessage);
    return;
  }

  if (type === 'agent:final') {
    handleFinal(ctx, payload as { report?: AgentReport });
    return;
  }
}

async function handlePlan(
  ctx: ProviderContext,
  deps: AgentEnvironmentBridgeDeps,
  payload: { plan?: Plan }
): Promise<void> {
  const conversation = ctx.conversations.ensureActive();
  const incoming = payload.plan && Array.isArray(payload.plan.steps) && payload.plan.steps.length > 0
    ? payload.plan
    : null;
  const artifactsEnabled = deps.arePlanArtifactsEnabled();

  let history: SerializedPlanRun[] = [];
  let activePlan: Plan | null = null;

  if (incoming) {
    const run = ctx.conversations.startPlanRun({ plan: incoming, artifactsEnabled });
    activePlan = run?.plan ?? incoming;
    environmentService.setRunContext({
      conversationId: conversation.id,
      conversationName: conversation.name,
      runId: run?.id
    });
    history = ctx.conversations.serializePlanRuns(conversation.planRuns);
  } else {
    ctx.conversations.clearActivePlan();
    environmentService.setRunContext({
      conversationId: conversation.id,
      conversationName: conversation.name,
      runId: undefined
    });
    history = ctx.conversations.serializePlanRuns(conversation.planRuns ?? []);
  }

  ctx.postMessage({
    type: 'agentPlan',
    plan: activePlan ?? payload.plan,
    history,
    activeRunId: ctx.conversations.activePlanRunId ?? null
  });
  ctx.postMessage({
    type: 'agentPlanHistory',
    history,
    activeRunId: ctx.conversations.activePlanRunId ?? null
  });
}

function handlePlanUpdate(
  ctx: ProviderContext,
  payload: { stepId?: string; state?: string; meta?: { summary?: string; durationMs?: number; tokens?: number } }
): void {
  if (typeof payload.stepId !== 'string') {return;}

  const stepUpdate: Partial<ConversationPlanStepState> = {
    summary: typeof payload.meta?.summary === 'string' ? payload.meta.summary : undefined,
    durationMs: typeof payload.meta?.durationMs === 'number' ? payload.meta.durationMs : undefined,
    tokens: typeof payload.meta?.tokens === 'number' ? payload.meta.tokens : undefined
  };
  if (typeof payload.state === 'string') {
    stepUpdate.state = payload.state;
  }

  const merged = ctx.conversations.updatePlanStep(payload.stepId, stepUpdate);
  const conversation = ctx.conversations.getCurrent();
  const history = ctx.conversations.serializePlanRuns(conversation?.planRuns ?? []);

  ctx.postMessage({
    type: 'agentPlanUpdate',
    stepId: payload.stepId,
    status: merged?.state ?? payload.state,
    meta: {
      summary: merged?.summary ?? payload.meta?.summary,
      durationMs: merged?.durationMs ?? payload.meta?.durationMs,
      tokens: merged?.tokens ?? payload.meta?.tokens
    },
    history,
    activeRunId: ctx.conversations.activePlanRunId ?? null
  });
  ctx.postMessage({
    type: 'agentPlanHistory',
    history,
    activeRunId: ctx.conversations.activePlanRunId ?? null
  });
}

function handleTelemetry(ctx: ProviderContext, telemetry: AgentTelemetryMessage): void {
  if (typeof telemetry.stepId === 'string' && telemetry.stepId.length > 0) {
    const update: Partial<ConversationPlanStepState> = {
      durationMs: typeof telemetry.durationMs === 'number' ? telemetry.durationMs : undefined,
      tokens: typeof telemetry.tokens === 'number' ? telemetry.tokens : undefined
    };
    ctx.conversations.updatePlanStep(telemetry.stepId, update);
  }
  ctx.postMessage({ type: 'agentTelemetry', telemetry });
}

function handleFinal(ctx: ProviderContext, payload: { report?: AgentReport }): void {
  const evaluation = payload.report?.evaluation;
  if (!evaluation) {return;}

  const conversation = ctx.conversations.getCurrent();
  const run = ctx.conversations.recordFinalEvaluation({
    success: evaluation.success,
    confidence: evaluation.confidence,
    feedback: evaluation.feedback
  });
  if (run) {
    const history = ctx.conversations.serializePlanRuns(conversation?.planRuns ?? []);
    ctx.postMessage({
      type: 'agentPlanHistory',
      history,
      activeRunId: ctx.conversations.activePlanRunId ?? null
    });
  }

  // Silent today — the chat feed already shows the agent's final
  // status line. Composition kept as the canonical place to wire a
  // future "agent run paused / completed / failed" surface; the
  // AWAITING_GUIDANCE_PREFIX prefix is what distinguishes paused
  // from failed evaluations.
  const confidence = Number.isFinite(evaluation.confidence)
    ? ` (confidence ${((evaluation.confidence ?? 0) * 100).toFixed(1)}%)`
    : '';
  const detail = evaluation.feedback ? ` — ${evaluation.feedback}` : '';
  const awaitingGuidance = !evaluation.success && evaluation.feedback?.startsWith(AWAITING_GUIDANCE_PREFIX);
  const prefix = evaluation.success
    ? 'Agent run completed'
    : awaitingGuidance
      ? 'Agent run paused'
      : 'Agent run finished with issues';
  void `${prefix}${confidence}${detail}`.trim();
}

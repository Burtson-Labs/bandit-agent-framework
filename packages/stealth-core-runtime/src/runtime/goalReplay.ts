import type { Plan, PlanStep, ExecutionResult, LlmRewriteAction } from '../internalTypes';
import type { ITelemetry, IStepExecutor, PlanUpdateState } from '../internalTypes';
import type { StatusPayload } from '../internalTypes';

export interface GoalReplayDeps {
  getLastPlan(): Plan | undefined;
  getLastWorkspaceRoot(): string | undefined;
  getLastGoal(): string | undefined;
  getLastSessionSnapshot(goal: string): Record<string, unknown>;
  initializeSession(goal: string, workspaceRoot: string, data: Record<string, unknown>): void;
  clearSession(): void;
  cloneActiveSessionData(): Record<string, unknown> | undefined;
  setLastSessionData(data: Record<string, unknown> | undefined): void;
  resetCancellation(): void;
  telemetry: ITelemetry;
  postPlanUpdate(stepId: string, state: PlanUpdateState, meta?: { summary?: string; durationMs?: number; tokens?: number }): Promise<void>;
  stepExecutor: IStepExecutor;
  stepLifecycle: {
    getStatusIconForStep(step: PlanStep): StatusPayload['icon'];
    getResultStatusIcon(ok: boolean): StatusPayload['icon'];
  };
  estimateTokens(result: ExecutionResult): number;
  promptRewriteRefinement(step: PlanStep): PromiseLike<string | undefined>;
  log(message: string, level: 'info' | 'warn' | 'error'): Promise<void>;
}

export interface GoalReplayer {
  replayStep(stepId: string, mode: 'replay' | 'refine'): Promise<void>;
}

export function createGoalReplayer(deps: GoalReplayDeps): GoalReplayer {
  async function replayStep(stepId: string, mode: 'replay' | 'refine'): Promise<void> {
    const plan = deps.getLastPlan();
    const workspaceRoot = deps.getLastWorkspaceRoot();
    if (!plan || !workspaceRoot) {
      await deps.log('No completed agent run to replay.', 'warn');
      return;
    }
    const step = plan.steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      await deps.log(`Step ${stepId} not found in last plan.`, 'warn');
      return;
    }
    const goal = deps.getLastGoal() ?? 'Replay agent step';
    const snapshot = deps.getLastSessionSnapshot(goal);
    deps.initializeSession(goal, workspaceRoot, snapshot);
    deps.resetCancellation();

    let stepToRun: PlanStep = step;
    if (mode === 'refine' && step.action.type === 'llmRewrite') {
      const refinement = await deps.promptRewriteRefinement(step);
      if (refinement && refinement.trim()) {
        const action = {
          ...step.action,
          instructions: `${step.action.instructions ?? ''}\n\nAdditional guidance: ${refinement.trim()}`
        } as LlmRewriteAction;
        stepToRun = { ...step, action };
      }
    }

    await deps.telemetry.status({
      text: `Replaying ${step.title}`,
      stepId,
      phase: 'start',
      icon: deps.stepLifecycle.getStatusIconForStep(stepToRun)
    });
    const result = await deps.stepExecutor.execute(stepToRun, goal);
    await deps.telemetry.status({
      text: `Replay ${step.title} — ${result.ok ? 'Completed' : 'Failed'}`,
      stepId,
      phase: result.ok ? 'complete' : 'error',
      detail: result.ok ? result.output : result.error,
      icon: deps.stepLifecycle.getResultStatusIcon(result.ok)
    });
    await deps.postPlanUpdate(stepId, result.ok ? 'complete' : 'error', {
      summary: result.output ?? result.error,
      durationMs: (result.data as { durationMs?: number } | undefined)?.durationMs ?? 0,
      tokens: deps.estimateTokens(result)
    });
    deps.setLastSessionData(deps.cloneActiveSessionData());
    deps.clearSession();
  }

  return {
    replayStep
  };
}

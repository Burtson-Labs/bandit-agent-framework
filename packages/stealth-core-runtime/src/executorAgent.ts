import type {
  ExecutionResult,
  Plan,
  PlanStep,
  ExecutorAgentConfiguration,
  ExecutorHooks,
  ExecutorResult
} from './internalTypes';

export class StealthExecutorAgent {
  constructor(private readonly hooks: ExecutorHooks) {}

  public async run(plan: Plan, goal: string, config: ExecutorAgentConfiguration): Promise<ExecutorResult> {
    const results: ExecutionResult[] = [];
    let autoIterations = 0;
    let stepIndex = 0;
    let invokedAutoRevise = false;

    const executeStep = async (step: PlanStep): Promise<ExecutionResult> => {
      if (typeof this.hooks.prepareStep === 'function') {
        await this.hooks.prepareStep(step, goal);
      }

      this.hooks.postPlanUpdate(step.id, 'start');
      await this.hooks.postStatus({
        text: step.title,
        stepId: step.id,
        phase: 'start',
        icon: this.hooks.getStatusIcon(step)
      });

      const result = await this.hooks.executeStep(step, goal);
      results.push(result);
      const summary = result.ok ? (result.output || 'OK') : (result.error || 'FAILED');
      await this.hooks.postLog({
        stepId: step.id,
        level: result.ok ? 'info' : 'error',
        message: `${step.title} — ${summary.slice(0, 160)}`
      });
      await this.hooks.postStatus({
        text: `${step.title} — ${result.ok ? 'Completed' : 'Failed'}`,
        stepId: step.id,
        phase: result.ok ? 'complete' : 'error',
        detail: summary,
        icon: this.hooks.getResultStatusIcon(result.ok)
      });
      this.hooks.postPlanUpdate(step.id, result.ok ? 'complete' : 'error', {
        summary,
        durationMs: (result.data as { durationMs?: number } | undefined)?.durationMs ?? 0,
        tokens: this.hooks.estimateTokensFromResult(result)
      });
      await this.hooks.postTelemetry(step.id, result);

      if (typeof this.hooks.finalizeStep === 'function') {
        await this.hooks.finalizeStep(step, result);
      }

      return result;
    };

    const runPlanFromIndex = async (): Promise<{ completed: boolean; failedStepId?: string }> => {
      for (; stepIndex < plan.steps.length; stepIndex++) {
        if (this.hooks.isCancelled()) {
          return { completed: true };
        }
        const step = plan.steps[stepIndex];
        const result = await executeStep(step);
        if (!result.ok) {
          return { completed: false, failedStepId: step.id };
        }
      }
      return { completed: true };
    };

    if (!this.hooks.previewOnly()) {
      while (true) {
        const execution = await runPlanFromIndex();
        if (execution.completed || this.hooks.previewOnly() || this.hooks.isCancelled()) {
          break;
        }

        const revision = await this.hooks.autoRevise(goal, plan, results, config);
        invokedAutoRevise = true;
        autoIterations += revision.iterations;
        if (revision.results.length > 0) {
          results.push(...revision.results);
        }

        if (revision.retryStepId) {
          const retryIndex = plan.steps.findIndex((step) => step.id === revision.retryStepId);
          stepIndex = retryIndex >= 0 ? retryIndex : stepIndex;
          continue;
        }
        break;
      }
    }

    if (!this.hooks.isCancelled() && !this.hooks.previewOnly() && !invokedAutoRevise) {
      const revision = await this.hooks.autoRevise(goal, plan, results, config);
      if (revision.results.length > 0) {
        results.push(...revision.results);
      }
      autoIterations += revision.iterations;
    }

    this.hooks.flushPlanUpdates();

    return { results, autoIterations };
  }
}

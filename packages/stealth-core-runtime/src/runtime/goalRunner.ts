import type { AgentReport, Plan } from '../internalTypes';
import type { ExecutorAgentConfiguration } from '../internalTypes';
import type { InferredGoal } from '../internalTypes';
import type { CoreRuntime, ITelemetry } from '../internalTypes';
import type { ExportPlanOptions } from './artifactManager';

export interface GoalRunnerDeps {
  coreRuntime: CoreRuntime;
  telemetry: ITelemetry;
  telemetryHub: { postFinal(report: AgentReport): Promise<void> };
  saveReport(report: AgentReport): Promise<void>;
  flushEmbeddings(): Promise<void>;
  exportPlan(options: ExportPlanOptions): Promise<void>;
  shouldEmitPlanArtifact(): boolean;
  getWorkspaceRoot(): string;
  getLastWorkspaceRoot(): string | undefined;
  setLastSessionData(data: Record<string, unknown> | undefined): void;
  cloneSessionData(): Record<string, unknown> | undefined;
  clearSession(): void;
  isCancelled(): boolean;
  getCurrentInsight(): InferredGoal | undefined;
}

export interface ExecutePlanInput {
  plan: Plan;
  goal: string;
  runOptions: { previewOnly?: boolean };
  agentConfig: ExecutorAgentConfiguration;
}

export function createGoalRunner(deps: GoalRunnerDeps) {
  async function executePlan(input: ExecutePlanInput): Promise<AgentReport> {
    const { plan, goal, runOptions, agentConfig } = input;
    const { results, autoIterations, evaluation } = await deps.coreRuntime.run(plan, goal, {
      insight: deps.getCurrentInsight(),
      metadata: { previewOnly: runOptions.previewOnly },
      executor: agentConfig,
      skipEnrich: true,
      previewOnly: runOptions.previewOnly === true
    });

    if (deps.isCancelled() && !runOptions.previewOnly) {
      await deps.telemetry.status({ text: 'Goal cancelled', phase: 'error', icon: 'warn' });
    }

    const report: AgentReport = {
      goal,
      plan,
      results,
      evaluation,
      iterations: runOptions.previewOnly ? 0 : 1 + autoIterations,
      finishedAt: new Date().toISOString()
    };

    if (!runOptions.previewOnly) {
      await deps.saveReport(report);
      deps.setLastSessionData(deps.cloneSessionData());
      await deps.flushEmbeddings();
      if (deps.shouldEmitPlanArtifact()) {
        const workspaceRoot = deps.getLastWorkspaceRoot() ?? deps.getWorkspaceRoot();
        await deps.exportPlan({ workspaceRoot, goal, plan, results, evaluation }).catch(() => undefined);
      }
    }

    await deps.telemetryHub.postFinal(report);
    deps.clearSession();
    return report;
  }

  return {
    executePlan
  };
}

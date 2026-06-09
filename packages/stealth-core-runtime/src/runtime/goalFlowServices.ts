import type { AgentReport, ExecutionResult, Plan, PlanStep } from '../internalTypes';
import type { ITelemetry, IStepExecutor, PlanUpdateState, CoreRuntime } from '../internalTypes';
import type { InferredGoal } from '../internalTypes';
import type { ExportPlanOptions } from './artifactManager';
import { createGoalRunner } from './goalRunner';
import { createGoalReplayer } from './goalReplay';
import type { StatusPayload } from '../internalTypes';

export interface GoalFlowHost {
  coreRuntime: CoreRuntime;
  telemetry: ITelemetry;
  telemetryHub: {
    postFinal(report: AgentReport): Promise<void>;
    postPlanUpdate(stepId: string, state: PlanUpdateState, meta?: { summary?: string; durationMs?: number; tokens?: number }): Promise<void>;
  };
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
  getLastPlan(): Plan | undefined;
  getLastGoal(): string | undefined;
  getLastSessionSnapshot(goal: string): Record<string, unknown>;
  initializeSession(goal: string, workspaceRoot: string, data: Record<string, unknown>): void;
  cloneActiveSessionData(): Record<string, unknown> | undefined;
  resetCancellation(): void;
  stepExecutor: IStepExecutor;
  stepLifecycle: {
    getStatusIconForStep(step: PlanStep): StatusPayload['icon'];
    getResultStatusIcon(ok: boolean): StatusPayload['icon'];
  };
  estimateTokens(result: ExecutionResult): number;
  promptRewriteRefinement(step: PlanStep): PromiseLike<string | undefined>;
  log(message: string, level: 'info' | 'warn' | 'error'): Promise<void>;
}

export function createGoalFlowServices(host: GoalFlowHost) {
  const goalRunner = createGoalRunner({
    coreRuntime: host.coreRuntime,
    telemetry: host.telemetry,
    telemetryHub: {
      postFinal: (report) => host.telemetryHub.postFinal(report)
    },
    saveReport: (report) => host.saveReport(report),
    flushEmbeddings: () => host.flushEmbeddings(),
    exportPlan: (options) => host.exportPlan(options),
    shouldEmitPlanArtifact: () => host.shouldEmitPlanArtifact(),
    getWorkspaceRoot: () => host.getWorkspaceRoot(),
    getLastWorkspaceRoot: () => host.getLastWorkspaceRoot(),
    setLastSessionData: (data) => host.setLastSessionData(data),
    cloneSessionData: () => host.cloneSessionData(),
    clearSession: () => host.clearSession(),
    isCancelled: () => host.isCancelled(),
    getCurrentInsight: () => host.getCurrentInsight()
  });

  const goalReplayer = createGoalReplayer({
    getLastPlan: () => host.getLastPlan(),
    getLastWorkspaceRoot: () => host.getLastWorkspaceRoot(),
    getLastGoal: () => host.getLastGoal(),
    getLastSessionSnapshot: (goal) => host.getLastSessionSnapshot(goal),
    initializeSession: (goal, workspaceRoot, data) => host.initializeSession(goal, workspaceRoot, data),
    clearSession: () => host.clearSession(),
    cloneActiveSessionData: () => host.cloneActiveSessionData(),
    setLastSessionData: (data) => host.setLastSessionData(data),
    resetCancellation: () => host.resetCancellation(),
    telemetry: host.telemetry,
    postPlanUpdate: (stepId, state, meta) => host.telemetryHub.postPlanUpdate(stepId, state, meta),
    stepExecutor: host.stepExecutor,
    stepLifecycle: host.stepLifecycle,
    estimateTokens: (result) => host.estimateTokens(result),
    promptRewriteRefinement: (step) => host.promptRewriteRefinement(step),
    log: (message, level) => host.log(message, level)
  });

  return { goalRunner, goalReplayer };
}

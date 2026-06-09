import type {
  AgentReport,
  Plan,
  PlanStep,
  ExecutionResult,
  ITelemetry,
  PlanUpdateState,
  InferredGoal,
  StatusPayload
} from '../../internalTypes';
import type { ExportPlanOptions } from '../artifactManager';
import type { GoalFlowHost } from '../goalFlowServices';

export type GoalFlowRuntimeConfig = Omit<GoalFlowHost, 'coreRuntime' | 'stepExecutor'>;

export interface GoalFlowRuntimeDeps {
  telemetry: ITelemetry;
  telemetryHub: {
    postFinal(report: AgentReport): Promise<void>;
    postPlanUpdate(
      stepId: string,
      state: PlanUpdateState,
      meta?: { summary?: string; durationMs?: number; tokens?: number }
    ): Promise<void>;
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
  stepLifecycle: {
    getStatusIconForStep(step: PlanStep): StatusPayload['icon'];
    getResultStatusIcon(ok: boolean): StatusPayload['icon'];
  };
  estimateTokens(result: ExecutionResult): number;
  promptRewriteRefinement(step: PlanStep): PromiseLike<string | undefined>;
  log(message: string, level: 'info' | 'warn' | 'error'): Promise<void>;
}

export function createGoalFlowRuntimeConfig(deps: GoalFlowRuntimeDeps): GoalFlowRuntimeConfig {
  return {
    telemetry: deps.telemetry,
    telemetryHub: deps.telemetryHub,
    saveReport: (report) => deps.saveReport(report),
    flushEmbeddings: () => deps.flushEmbeddings(),
    exportPlan: (options) => deps.exportPlan(options),
    shouldEmitPlanArtifact: () => deps.shouldEmitPlanArtifact(),
    getWorkspaceRoot: () => deps.getWorkspaceRoot(),
    getLastWorkspaceRoot: () => deps.getLastWorkspaceRoot(),
    setLastSessionData: (data) => deps.setLastSessionData(data),
    cloneSessionData: () => deps.cloneSessionData(),
    clearSession: () => deps.clearSession(),
    isCancelled: () => deps.isCancelled(),
    getCurrentInsight: () => deps.getCurrentInsight(),
    getLastPlan: () => deps.getLastPlan(),
    getLastGoal: () => deps.getLastGoal(),
    getLastSessionSnapshot: (goal) => deps.getLastSessionSnapshot(goal),
    initializeSession: (goal, workspaceRoot, data) => deps.initializeSession(goal, workspaceRoot, data),
    cloneActiveSessionData: () => deps.cloneActiveSessionData(),
    resetCancellation: () => deps.resetCancellation(),
    stepLifecycle: deps.stepLifecycle,
    estimateTokens: (result) => deps.estimateTokens(result),
    promptRewriteRefinement: (step) => deps.promptRewriteRefinement(step),
    log: (message, level) => deps.log(message, level)
  };
}

import { createGoalFlowRuntimeConfig } from './goalFlowRuntime';
import type {
  AgentReport,
  ExecutionResult,
  PlanStep,
  ITelemetry,
  PlanUpdateState,
  StatusPayload
} from '../../internalTypes';
import type { SessionRuntime } from '../sessionRuntime';
import type { ExportPlanOptions } from '../artifactManager';

interface WorkspaceConfiguration {
  get<T>(key: string, defaultValue: T): T;
}

export interface GoalFlowHostDeps {
  telemetry: ITelemetry;
  telemetryHub: {
    postFinal(report: AgentReport): Promise<void>;
    postPlanUpdate(stepId: string, state: PlanUpdateState, meta?: { summary?: string; durationMs?: number; tokens?: number }): Promise<void>;
    emitExecutionTelemetry(stepId: string, result: ExecutionResult, tokens: number): Promise<void>;
  };
  saveReport(report: AgentReport): Promise<void>;
  flushEmbeddings(): Promise<void>;
  exportPlan(options: ExportPlanOptions): Promise<void>;
  getWorkspaceRoot(): string;
  sessionRuntime: SessionRuntime;
  getConfiguration(): WorkspaceConfiguration;
  promptRewriteRefinement(step: PlanStep): Promise<string | undefined>;
  estimateTokens(result: ExecutionResult): number;
  log(message: string, level: 'info' | 'warn' | 'error'): Promise<void>;
  stepLifecycle: {
    getStatusIconForStep(step: PlanStep): StatusPayload['icon'];
    getResultStatusIcon(ok: boolean): StatusPayload['icon'];
  };
}

export function createGoalFlowHost(deps: GoalFlowHostDeps) {
  return createGoalFlowRuntimeConfig({
    telemetry: deps.telemetry,
    telemetryHub: {
      postFinal: (report) => deps.telemetryHub.postFinal(report),
      postPlanUpdate: (stepId, state, meta) => deps.telemetryHub.postPlanUpdate(stepId, state, meta)
    },
    saveReport: (report) => deps.saveReport(report),
    flushEmbeddings: () => deps.flushEmbeddings(),
    exportPlan: (options) => deps.exportPlan(options),
    shouldEmitPlanArtifact: () =>
      deps.getConfiguration().get<boolean>('debug.emitPlanJson', true) === true,
    getWorkspaceRoot: () => deps.getWorkspaceRoot(),
    getLastWorkspaceRoot: () => deps.sessionRuntime.getLastWorkspaceRoot(),
    setLastSessionData: (data) => deps.sessionRuntime.setLastSessionData(data),
    cloneSessionData: () => deps.sessionRuntime.cloneSessionData(),
    clearSession: () => deps.sessionRuntime.clearSession(),
    isCancelled: () => deps.sessionRuntime.isCancelled(),
    getCurrentInsight: () => deps.sessionRuntime.getCurrentGoalInsight(),
    getLastPlan: () => deps.sessionRuntime.getLastPlan(),
    getLastGoal: () => deps.sessionRuntime.getLastGoal(),
    getLastSessionSnapshot: (goal) => deps.sessionRuntime.getLastSessionSnapshot(goal),
    initializeSession: (goal, workspaceRoot, data) =>
      deps.sessionRuntime.initializeSession(goal, workspaceRoot, data),
    cloneActiveSessionData: () => deps.sessionRuntime.cloneActiveSessionData(),
    resetCancellation: () => deps.sessionRuntime.resetCancellation(),
    stepLifecycle: deps.stepLifecycle,
    estimateTokens: (result) => deps.estimateTokens(result),
    promptRewriteRefinement: (step) => deps.promptRewriteRefinement(step),
    log: (message, level) => deps.log(message, level)
  });
}

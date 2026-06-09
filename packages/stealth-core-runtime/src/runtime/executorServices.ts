import type { ExecutionResult, Plan, PlanStep } from '../internalTypes';
import type { StatusPayload, LogPayload } from '../internalTypes';
import { createStepExecutor, type StepExecutorDeps } from './stepExecutor';
import { createCoreRuntime } from './coreRuntime';
import { createGoalFlowServices, type GoalFlowHost } from './goalFlowServices';
import type {
  CoreRuntime,
  CoreRuntimeDeps,
  IStepExecutor,
  PlanUpdateState,
  ExecutorAgentConfiguration,
  ExecutorHooks
} from '../internalTypes';

type CoreRuntimeConfig = Omit<CoreRuntimeDeps, 'steps'>;
type GoalFlowConfig = Omit<GoalFlowHost, 'coreRuntime' | 'stepExecutor'>;

interface ExecutorHookDeps {
  previewOnly(): boolean;
  isCancelled(): boolean;
  postStatus(payload: StatusPayload): Promise<void>;
  postLog(payload: LogPayload): Promise<void>;
  postPlanUpdate(
    stepId: string,
    state: PlanUpdateState,
    meta?: { summary?: string; durationMs?: number; tokens?: number }
  ): Promise<void> | void;
  emitExecutionTelemetry(stepId: string, result: ExecutionResult, tokens: number): Promise<void>;
  autoRevise(
    goal: string,
    plan: Plan,
    results: ExecutionResult[],
    config: ExecutorAgentConfiguration
  ): Promise<{ results: ExecutionResult[]; iterations: number }>;
  flushPlanUpdates(): Promise<void> | void;
}

interface ExecutorLifecycleDeps {
  prepareStep(step: PlanStep): Promise<void>;
  finalizeStep(step: PlanStep): void;
  getStatusIconForStep(step: PlanStep): StatusPayload['icon'];
  getResultStatusIcon(ok: boolean): StatusPayload['icon'];
}

export interface ExecutorServicesDeps {
  stepExecutor: StepExecutorDeps;
  coreRuntime: CoreRuntimeConfig;
  goalFlow: GoalFlowConfig;
  hooks: ExecutorHookDeps;
  lifecycle: ExecutorLifecycleDeps;
}

export interface ExecutorServicesResult {
  stepExecutor: IStepExecutor;
  coreRuntime: CoreRuntime;
  goalRunner: ReturnType<typeof createGoalFlowServices>['goalRunner'];
  goalReplayer: ReturnType<typeof createGoalFlowServices>['goalReplayer'];
}

export function createExecutorServices(deps: ExecutorServicesDeps): ExecutorServicesResult {
  const stepExecutor = createStepExecutor(deps.stepExecutor);

  const executorHooks: ExecutorHooks = {
    previewOnly: () => deps.hooks.previewOnly(),
    isCancelled: () => deps.hooks.isCancelled(),
    postStatus: (payload) => deps.hooks.postStatus(payload),
    postLog: (payload) => deps.hooks.postLog(payload),
    postPlanUpdate: (stepId, state, meta) => {
      const typedState = state as PlanUpdateState;
      void deps.hooks.postPlanUpdate(stepId, typedState, meta);
    },
    postTelemetry: (stepId, result) =>
      deps.hooks.emitExecutionTelemetry(stepId, result, deps.goalFlow.estimateTokens(result)),
    getStatusIcon: (step) => deps.lifecycle.getStatusIconForStep(step),
    getResultStatusIcon: (ok) => deps.lifecycle.getResultStatusIcon(ok),
    estimateTokensFromResult: (result) => deps.goalFlow.estimateTokens(result),
    prepareStep: (step) => deps.lifecycle.prepareStep(step),
    executeStep: (step, goal) => stepExecutor.execute(step, goal),
    finalizeStep: (step, _result) => Promise.resolve(deps.lifecycle.finalizeStep(step)),
    autoRevise: (goal, plan, results, config) => deps.hooks.autoRevise(goal, plan, results, config),
    flushPlanUpdates: () => {
      void deps.hooks.flushPlanUpdates();
    }
  };

  const coreRuntime = createCoreRuntime({
    ...deps.coreRuntime,
    steps: stepExecutor,
    executorHooks
  });

  const goalFlow = createGoalFlowServices({
    ...deps.goalFlow,
    coreRuntime,
    stepExecutor
  });

  return {
    stepExecutor,
    coreRuntime,
    goalRunner: goalFlow.goalRunner,
    goalReplayer: goalFlow.goalReplayer
  };
}

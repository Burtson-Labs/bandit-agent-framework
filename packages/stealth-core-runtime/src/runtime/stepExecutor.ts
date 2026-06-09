import type {
  PlanStep,
  ExecutionResult,
  PythonRunCommandAction,
  PythonScanProjectAction,
  PythonReadFileAction,
  PythonWriteFileAction,
  InternalIdentifyHomepageAction,
  InternalLocateFilesAction,
  InternalExtractRelevantSectionAction,
  InternalRunProjectScriptsAction,
  InternalEmitMessageAction,
  InternalReviewDiffAction,
  LlmRewriteAction
} from '../internalTypes';
import type { IStepExecutor, StepOutcome } from '../internalTypes';

type PythonAction =
  | PythonRunCommandAction
  | PythonScanProjectAction
  | PythonReadFileAction
  | PythonWriteFileAction;

type InternalAction =
  | InternalIdentifyHomepageAction
  | InternalLocateFilesAction
  | InternalExtractRelevantSectionAction
  | InternalRunProjectScriptsAction
  | InternalEmitMessageAction
  | InternalReviewDiffAction;

interface ValidationResult {
  ok: boolean;
  error?: string;
  output?: string;
  data?: Record<string, unknown>;
}

export interface StepExecutorDeps {
  preflight(step: PlanStep): Promise<ExecutionResult | undefined>;
  primeStep(step: PlanStep): void;
  executePython(action: PythonAction, stepId: string, step: PlanStep): Promise<StepOutcome>;
  executeInternal(step: PlanStep, action: InternalAction): Promise<StepOutcome>;
  executeRewrite(step: PlanStep, action: LlmRewriteAction, goal: string): Promise<StepOutcome>;
  validate(step: PlanStep, goal: string): Promise<ValidationResult>;
  buildResult(stepId: string, outcome: StepOutcome, startedAt: number): ExecutionResult;
}

export function createStepExecutor(deps: StepExecutorDeps): IStepExecutor {
  type PendingExecution = {
    step: PlanStep;
    goal: string;
    resolve(value: ExecutionResult): void;
    reject(reason: unknown): void;
  };

  const queue: PendingExecution[] = [];
  let processing = false;

  async function processQueue(): Promise<void> {
    if (processing) {
      return;
    }
    processing = true;
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        continue;
      }
      try {
        const result = await runStep(next.step, next.goal);
        next.resolve(result);
      } catch (error) {
        next.reject(error);
      }
    }
    processing = false;
  }

  async function runStep(step: PlanStep, goal: string): Promise<ExecutionResult> {
    const gateFailure = await deps.preflight(step);
    if (gateFailure) {
      return gateFailure;
    }

    const startedAt = Date.now();
    let outcome: StepOutcome = { ok: false };
    deps.primeStep(step);

    try {
      const action = step.action as { type: string };
      switch (action.type) {
        case 'python':
          outcome = await deps.executePython(action as PythonAction, step.id, step);
          break;
        case 'internal':
          outcome = await deps.executeInternal(step, action as InternalAction);
          break;
        case 'llmRewrite':
          outcome = await deps.executeRewrite(step, action as LlmRewriteAction, goal);
          break;
        default:
          outcome = { ok: false, error: `Unsupported step action: ${action.type}` };
          break;
      }
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    if (outcome.ok) {
      const validation = await deps.validate(step, goal);
      if (!validation.ok) {
        outcome = {
          ok: false,
          error: validation.error ?? 'Validation failed.',
          output: validation.output,
          data: {
            ...(outcome.data ?? {}),
            validation
          }
        };
      }
    }

    return deps.buildResult(step.id, outcome, startedAt);
  }

  function enqueue(step: PlanStep, goal: string): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      queue.push({ step, goal, resolve, reject });
      void processQueue();
    });
  }

  return {
    execute(step: PlanStep, goal: string): Promise<ExecutionResult> {
      return enqueue(step, goal);
    }
  };
}

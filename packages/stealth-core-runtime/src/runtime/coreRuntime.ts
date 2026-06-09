import type { Plan, ExecutionResult, Evaluation } from '../internalTypes';
import type { ExecutorHooks, ExecutorAgentConfiguration } from '../internalTypes';
import { StealthExecutorAgent } from '../executorAgent';
import type { CoreRuntime, CoreRuntimeResult, RuntimeRunOptions, CoreRuntimeDeps, DiffTransaction } from '../internalTypes';

export interface CreateCoreRuntimeOptions extends CoreRuntimeDeps {
  executorHooks: ExecutorHooks;
}

function ensureExecutorConfig(options?: RuntimeRunOptions): ExecutorAgentConfiguration {
  if (!options?.executor) {
    throw new Error('Core runtime requires an executor configuration.');
  }
  return options.executor;
}

export function createCoreRuntime(deps: CreateCoreRuntimeOptions): CoreRuntime {
  const executorAgent = new StealthExecutorAgent(deps.executorHooks);
  let disposed = false;

  async function run(plan: Plan, goal: string, options: RuntimeRunOptions): Promise<CoreRuntimeResult> {
    if (disposed) {
      throw new Error('Core runtime has been disposed.');
    }

    let workingPlan = plan;
    await postStartStatus(options.previewOnly === true, deps.telemetry);
    if (!options.skipEnrich) {
      workingPlan = await deps.goal.enrich(plan, plan.goal ?? goal, { insight: options.insight });
    }

    let transaction: DiffTransaction | undefined;
    if (shouldUseDiffTransaction(workingPlan, options)) {
      transaction = deps.diff.beginTransaction();
    }

    const config = ensureExecutorConfig(options);
    let executorResult: Awaited<ReturnType<StealthExecutorAgent['run']>>;
    try {
      executorResult = await executorAgent.run(workingPlan, goal, config);
      if (transaction) {
        const failed = executorResult.results.some((result) => !result.ok);
        if (failed) {
          deps.diff.rollbackTransaction(transaction);
        } else {
          await deps.diff.commitTransaction(transaction);
        }
      }
    } catch (error) {
      if (transaction) {
        deps.diff.rollbackTransaction(transaction);
      }
      throw error;
    }
    const evaluation = await computeEvaluation(
      {
        previewOnly: options.previewOnly === true,
        plan: workingPlan,
        results: executorResult.results,
        goal,
        config,
        autoIterations: executorResult.autoIterations
      },
      deps
    );
    await postFinalStatus({
      previewOnly: options.previewOnly === true,
      evaluation,
      awaitingGuidancePrefix: deps.awaitingGuidancePrefix,
      telemetry: deps.telemetry
    });

    return {
      plan: workingPlan,
      results: executorResult.results,
      autoIterations: executorResult.autoIterations,
      evaluation
    };
  }

  async function dispose(): Promise<void> {
    disposed = true;
  }

  return {
    run,
    dispose
  };
}

async function computeEvaluation(input: {
  previewOnly: boolean;
  plan: Plan;
  results: ExecutionResult[];
  goal: string;
  config: ExecutorAgentConfiguration;
  autoIterations: number;
}, deps: CreateCoreRuntimeOptions): Promise<Evaluation> {
  if (input.previewOnly) {
    return {
      success: false,
      confidence: 0,
      feedback: 'Preview only — run the agent to apply changes.'
    };
  }

  let evaluation = await deps.evaluate({
    plan: input.plan,
    results: input.results,
    goal: input.goal,
    config: input.config
  });

  if (evaluation.success && evaluation.confidence < input.config.confidenceTarget) {
    const confidencePercent = (evaluation.confidence * 100).toFixed(1);
    const targetPercent = (input.config.confidenceTarget * 100).toFixed(1);
    evaluation = {
      ...evaluation,
      success: false,
      feedback: `${evaluation.feedback} Confidence ${confidencePercent}% below target ${targetPercent}%.`
    };
  }

  if (input.autoIterations > 0) {
    evaluation = {
      ...evaluation,
      feedback: `${evaluation.feedback} (auto-revision iterations: ${input.autoIterations})`
    };
  }

  return evaluation;
}

async function postStartStatus(previewOnly: boolean, telemetry: CreateCoreRuntimeOptions['telemetry']): Promise<void> {
  if (previewOnly) {
    await telemetry.status({
      text: 'Plan ready for review',
      phase: 'complete',
      detail: 'Preview only — no changes applied.',
      icon: 'review'
    });
    return;
  }
  await telemetry.status({ text: 'Executing plan…', phase: 'progress', icon: 'plan' });
}

async function postFinalStatus(args: {
  previewOnly: boolean;
  evaluation: Evaluation;
  awaitingGuidancePrefix: string;
  telemetry: CreateCoreRuntimeOptions['telemetry'];
}): Promise<void> {
  if (args.previewOnly) {
    await args.telemetry.status({
      text: 'Plan preview complete',
      phase: 'complete',
      detail: args.evaluation.feedback,
      icon: 'info'
    });
    return;
  }

  const awaitingGuidance =
    !args.evaluation.success && args.evaluation.feedback.startsWith(args.awaitingGuidancePrefix);
  await args.telemetry.status({
    text: args.evaluation.success
      ? 'Goal achieved ✅'
      : awaitingGuidance
        ? 'Awaiting guidance'
        : 'Evaluation complete',
    phase: args.evaluation.success || awaitingGuidance ? 'complete' : 'error',
    detail: args.evaluation.feedback,
    icon: args.evaluation.success ? 'success' : awaitingGuidance ? 'info' : 'warn'
  });
}

function shouldUseDiffTransaction(plan: Plan, options: RuntimeRunOptions): boolean {
  if (options.previewOnly || !plan?.steps?.length) {
    return false;
  }
  return isMultiFilePlan(plan);
}

function isMultiFilePlan(plan: Plan): boolean {
  const metadata = plan.metadata as { multiFile?: boolean; mode?: string } | undefined;
  if (metadata?.multiFile === true) {
    return true;
  }
  if (metadata?.mode && typeof metadata.mode === 'string' && metadata.mode.toLowerCase() === 'multi-file') {
    return true;
  }
  let writeSteps = 0;
  const referencedFiles = new Set<string>();
  for (const step of plan.steps ?? []) {
    if (Array.isArray(step.filesToEdit) && step.filesToEdit.length > 1) {
      return true;
    }
    if (typeof step.targetFile === 'string') {
      referencedFiles.add(step.targetFile);
    }
    if (step.action && step.action.type === 'python' && step.action.name === 'writeFile') {
      writeSteps += 1;
    }
  }
  if (referencedFiles.size > 1) {
    return true;
  }
  return writeSteps > 1;
}

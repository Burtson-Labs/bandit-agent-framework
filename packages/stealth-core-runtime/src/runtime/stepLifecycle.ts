import type { PlanStep, ExecutionResult, LlmRewriteAction, StepAction } from '../internalTypes';
import type {
  IHelperManager,
  ITelemetry,
  RewriteHydrationContext,
  StepOutcome
} from '../internalTypes';
import { parseHelperStepMetadata, parseCallerStepMetadata, parseRelatedStepMetadata } from './stepMetadata';
import type { StatusPayload } from '../internalTypes';

export interface StepLifecycleDeps {
  helperManager: IHelperManager;
  rewriteHydrationManager: {
    buildContext(step: PlanStep, relativePath: string): Promise<RewriteHydrationContext | undefined>;
  };
  getHydrationCache(stepId: string): RewriteHydrationContext | undefined;
  setHydrationCache(stepId: string, context: RewriteHydrationContext | undefined): void;
  getContextValue<T>(key: string): T | undefined;
  setContextValue(key: string, value: unknown): void;
  ensureSession(): void;
  isPreviewOnly(): boolean;
  isDryRunEnabled(): boolean;
  telemetry: ITelemetry;
  buildExecutionResult(stepId: string, outcome: StepOutcome, startedAt: number): ExecutionResult;
}

export function createStepLifecycle(deps: StepLifecycleDeps) {
  function primeStepContext(step: PlanStep): void {
    const helperMeta = parseHelperStepMetadata(step);
    if (helperMeta?.pathRef && helperMeta.helperPath) {
      deps.setContextValue(helperMeta.pathRef, helperMeta.helperPath);
    }
    const relatedMeta = parseRelatedStepMetadata(step);
    if (relatedMeta?.pathRef && relatedMeta.targetPath) {
      deps.setContextValue(relatedMeta.pathRef, relatedMeta.targetPath);
    }
  }

  async function preflightStep(step: PlanStep): Promise<ExecutionResult | undefined> {
    const callerMeta = parseCallerStepMetadata(step);
    const callerGateNeeded = !deps.isPreviewOnly() && !deps.isDryRunEnabled();
    if (!callerGateNeeded || callerMeta?.role !== 'rewrite') {
      return undefined;
    }
    const start = Date.now();
    const preflight = await deps.helperManager.ensureChainReady(callerMeta);
    if (preflight.ok) {
      return undefined;
    }
    return deps.buildExecutionResult(step.id, preflight, start);
  }

  async function prepareStep(step: PlanStep): Promise<void> {
    if (step.action.type !== 'llmRewrite') {
      return;
    }
    try {
      deps.ensureSession();
      const helperMeta = parseHelperStepMetadata(step);
      const action = step.action as LlmRewriteAction;
      const relativePath = resolveRewriteTargetPath(action, helperMeta);
      if (!relativePath) {
        deps.setHydrationCache(step.id, undefined);
        return;
      }
      const hydration = await deps.rewriteHydrationManager.buildContext(step, relativePath);
      if (hydration) {
        deps.setHydrationCache(step.id, hydration);
      } else {
        deps.setHydrationCache(step.id, undefined);
      }
    } catch (error) {
      await deps.telemetry.log({
        message: `Failed to prepare rewrite context for ${step.title}: ${error instanceof Error ? error.message : String(error)}`,
        stepId: step.id,
        level: 'warn'
      });
    }
  }

  function finalizeStep(step: PlanStep): void {
    if (step.action.type === 'llmRewrite') {
      deps.setHydrationCache(step.id, undefined);
    }
  }

  function resolveRewriteTargetPath(
    action: LlmRewriteAction,
    helperMeta?: ReturnType<typeof parseHelperStepMetadata>
  ): string | undefined {
    if (helperMeta?.helperPath) {
      return helperMeta.helperPath;
    }
    if (typeof action.pathRef === 'string') {
      return deps.getContextValue<string>(action.pathRef);
    }
    return undefined;
  }

  function getStatusIconForAction(action: StepAction): StatusPayload['icon'] {
    switch (action.type) {
      case 'python':
        switch (action.name) {
          case 'scanProject':
          case 'readFile':
            return 'search';
          case 'writeFile':
            return 'code';
          case 'runCommand':
            return 'terminal';
          default:
            return 'info';
        }
      case 'internal':
        switch (action.name) {
          case 'identifyHomepage':
          case 'locateFiles':
            return 'search';
          case 'runProjectScripts':
            return 'terminal';
          case 'reviewDiff':
            return 'review';
          case 'emitMessage':
            return 'info';
          default:
            return 'plan';
        }
      case 'llmRewrite':
        return 'code';
      default:
        return 'info';
    }
  }

  function getStatusIconForStep(step: PlanStep): StatusPayload['icon'] {
    return getStatusIconForAction(step.action);
  }

  function getResultStatusIcon(ok: boolean): StatusPayload['icon'] {
    return ok ? 'success' : 'warn';
  }

  return {
    primeStepContext,
    preflightStep,
    prepareStep,
    finalizeStep,
    getStatusIconForStep,
    getResultStatusIcon,
    resolveRewriteTargetPath
  };
}

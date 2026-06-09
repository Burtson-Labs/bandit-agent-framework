import type { ExecutionResult, PlanStep, PythonWriteFileAction } from '../internalTypes';
import type { AdditionalWrite, StepOutcome } from '../internalTypes';

export function estimateTokensFromResult(result: ExecutionResult): number {
  const candidates: string[] = [];
  if (typeof result.output === 'string') {
    candidates.push(result.output);
  }
  const data = result.data as Record<string, unknown> | undefined;
  if (data) {
    if (typeof data.content === 'string') {
      candidates.push(data.content);
    }
    if (typeof data.review === 'string') {
      candidates.push(data.review);
    }
    if (typeof data.diff === 'string') {
      candidates.push(data.diff);
    }
  }
  return estimateTokensFromText(candidates.join('\n'));
}

export function estimateTokensFromText(text: string | undefined): number {
  if (!text) {
    return 0;
  }
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function storeAdditionalWrites(
  setContextValue: (key: string, value: unknown) => void,
  outputKey: string,
  writes: AdditionalWrite[]
): void {
  if (!outputKey) {
    return;
  }
  const segments = outputKey.split('.');
  if (segments.length <= 1) {
    return;
  }
  segments[segments.length - 1] = 'additionalWrites';
  const key = segments.join('.');
  setContextValue(key, writes);
}

export function resolveAdditionalWritesRef(action: PythonWriteFileAction): string | undefined {
  if (Object.prototype.hasOwnProperty.call(action, 'additionalWritesRef')) {
    const reference = action.additionalWritesRef;
    if (typeof reference === 'string' && reference.trim().length > 0) {
      return reference;
    }
    return undefined;
  }
  const segments = action.contentRef?.split('.');
  if (!segments || segments.length <= 1) {
    return undefined;
  }
  segments[segments.length - 1] = 'additionalWrites';
  return segments.join('.');
}

export function getWriteTargetPath(
  getContextValue: <T>(key: string) => T | undefined,
  step: PlanStep
): string | undefined {
  if (step.action.type !== 'python' || step.action.name !== 'writeFile') {
    return undefined;
  }
  const action = step.action as PythonWriteFileAction;
  const contextual = typeof action.pathRef === 'string' ? getContextValue<string>(action.pathRef) : undefined;
  return contextual ?? step.targetFile ?? getContextValue<string>('focus.primary.path');
}

export function buildExecutionResult(stepId: string, outcome: StepOutcome, startedAt: number): ExecutionResult {
  const duration = Math.max(0, Date.now() - startedAt);
  return {
    stepId,
    ok: outcome.ok,
    output: outcome.output,
    error: outcome.error,
    data: {
      ...(outcome.data ?? {}),
      durationMs: duration
    }
  };
}

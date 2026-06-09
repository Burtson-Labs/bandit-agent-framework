import type { Evaluation, Plan, ExecutionResult } from '@burtson-labs/stealth-core-runtime';

interface EvalInput {
  plan: Plan;
  results: ExecutionResult[];
  goal: string;
}

export const AWAITING_GUIDANCE_PREFIX = 'Awaiting user guidance';

export const feedbackService = {
  async evaluate({ plan, results }: EvalInput): Promise<Evaluation> {
    const totalSteps = Math.max(plan.steps.length, results.length) || 1;
    const okCount = results.filter((result) => result.ok).length;
    const semanticScore = clamp(okCount / totalSteps);
    const validationScore = computeValidationScore(results);
    const confidence = clamp(0.7 * semanticScore + 0.3 * validationScore, 0.3, 0.99);

    const firstFailure = results.find((result) => !result.ok);
    if (firstFailure) {
      const failedStep = plan.steps.find((step) => step.id === firstFailure.stepId);
      if (failedStep?.action?.type === 'internal' && failedStep.action.name === 'locateFiles') {
        return {
          success: false,
          feedback: `${AWAITING_GUIDANCE_PREFIX} — no matching files were found. Provide a workspace path or attach a file so I can continue.`,
          confidence,
          semanticScore,
          validationScore
        };
      }
      if (failedStep?.action?.type === 'python' && failedStep.action.name === 'readFile') {
        return {
          success: false,
          feedback: `${AWAITING_GUIDANCE_PREFIX} — I couldn't open the target file yet. Share the workspace path or attach the file so I can continue.`,
          confidence,
          semanticScore,
          validationScore
        };
      }
    }

    const success = okCount >= Math.ceil(plan.steps.length * 0.67);
    const feedback = success ? 'Objectives met.' : 'Increase verification, adjust failing steps, rerun.';
    return { success, feedback, confidence, semanticScore, validationScore };
  }
};

type DiagnosticLike = {
  isTouchedFileError?: boolean;
};

interface ValidationSnapshot {
  ok: boolean;
  diagnostics: DiagnosticLike[];
  ignoredDiagnostics: DiagnosticLike[];
}

function computeValidationScore(results: ExecutionResult[]): number {
  const snapshots = extractValidationSnapshots(results);
  if (snapshots.length === 0) {
    return 1;
  }
  const total = snapshots.reduce((sum, snapshot) => sum + scoreValidationSnapshot(snapshot), 0);
  return clamp(total / snapshots.length);
}

function extractValidationSnapshots(results: ExecutionResult[]): ValidationSnapshot[] {
  const snapshots: ValidationSnapshot[] = [];
  for (const result of results) {
    const data = result.data;
    if (!data || typeof data !== 'object') {
      continue;
    }
    const buildValidation = normalizeValidationOutcome((data as Record<string, unknown>).buildValidation);
    if (buildValidation) {
      snapshots.push(buildValidation);
    }
    const stepValidation = normalizeValidationOutcome((data as Record<string, unknown>).validation);
    if (stepValidation) {
      snapshots.push(stepValidation);
    }
  }
  return snapshots;
}

function normalizeValidationOutcome(value: unknown): ValidationSnapshot | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as {
    ok?: unknown;
    diagnostics?: unknown;
    ignoredDiagnostics?: unknown;
  };
  const ok = candidate.ok !== false;
  return {
    ok,
    diagnostics: normalizeDiagnosticList(candidate.diagnostics),
    ignoredDiagnostics: normalizeDiagnosticList(candidate.ignoredDiagnostics)
  };
}

function normalizeDiagnosticList(value: unknown): DiagnosticLike[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is DiagnosticLike => entry !== null && typeof entry === 'object');
}

function scoreValidationSnapshot(snapshot: ValidationSnapshot): number {
  const hasBlockingRelatedDiagnostics = snapshot.diagnostics.some((diagnostic) => diagnostic.isTouchedFileError !== false);
  if (!snapshot.ok && hasBlockingRelatedDiagnostics) {
    return 0.1;
  }
  if (!snapshot.ok) {
    return 0.5;
  }
  if (snapshot.diagnostics.length > 0 && hasBlockingRelatedDiagnostics) {
    return 0.75;
  }
  if (snapshot.ignoredDiagnostics.length > 0) {
    return 0.95;
  }
  return 1;
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

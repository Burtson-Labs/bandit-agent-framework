import type { PlanOptions, AgentPlan as FrameworkAgentPlan, Goal as FrameworkGoal } from '@burtson-labs/agent-core';
import type { Plan } from '../internalTypes';
import type { InferredGoal } from '../internalTypes';
import type { IGoalEngine, ITelemetry } from '../internalTypes';

export interface PlanGeneratorDeps {
  createAgentPlan(goal: string, options: PlanOptions): Promise<FrameworkAgentPlan>;
  goalEngine: IGoalEngine;
  mapPlan(agentPlan: FrameworkAgentPlan): Plan;
  applyMetadata(plan: Plan): void;
  telemetry: ITelemetry;
  postPlan(plan: Plan): Promise<void>;
  emitGoalTelemetry(goal: FrameworkGoal | undefined, insight?: InferredGoal): void;
  emitTaskTelemetry(): void;
}

export interface PlanGeneratorInput {
  goal: string;
  planOptions: PlanOptions;
  insight?: InferredGoal;
}

const MAX_PLAN_RETRIES = 2;

export async function generatePlan(deps: PlanGeneratorDeps, input: PlanGeneratorInput): Promise<Plan> {
  await deps.telemetry.status({ text: 'Planning…', phase: 'start', icon: 'plan' });

  let lastErrors: string[] = [];
  for (let attempt = 0; attempt <= MAX_PLAN_RETRIES; attempt++) {
    if (attempt > 0) {
      await deps.telemetry.event('plan:retry', {
        attempt,
        previousErrors: lastErrors
      });
      await deps.telemetry.status({ text: `Retrying plan (attempt ${attempt + 1})…`, phase: 'progress', icon: 'plan' });
    }

    const agentPlan = await deps.createAgentPlan(input.goal, input.planOptions);
    const planValidation = validateAgentPlan(agentPlan);

    if (planValidation.ok) {
      if (attempt > 0) {
        await deps.telemetry.log({ message: `Plan succeeded on attempt ${attempt + 1}.` });
      }
      // Proceed with the validated plan below the retry loop
      const basePlan = deps.mapPlan(planValidation.plan);
      const plan = await deps.goalEngine.enrich(basePlan, basePlan.goal || input.goal, { insight: input.insight });
      deps.applyMetadata(plan);
      await deps.telemetry.log({ message: `Plan ready with ${plan.steps.length} steps.` });
      await deps.postPlan(plan);

      const primaryGoal = plan.goals?.[0];
      deps.emitGoalTelemetry(primaryGoal, input.insight);
      deps.emitTaskTelemetry();

      return plan;
    }

    lastErrors = planValidation.errors;
  }

  // All retries exhausted
  await deps.telemetry.event('plan:failed', {
    code: 'PLAN_PARSE_FAILED',
    errors: lastErrors,
    attempts: MAX_PLAN_RETRIES + 1
  });
  const err = Object.assign(
    new Error(`Plan schema validation failed after ${MAX_PLAN_RETRIES + 1} attempts: ${lastErrors.join('; ')}`),
    { code: 'PLAN_PARSE_FAILED' }
  );
  throw err;
}

type PlanValidationResult =
  | { ok: true; plan: FrameworkAgentPlan }
  | { ok: false; errors: string[] };

function validateAgentPlan(raw: unknown): PlanValidationResult {
  const errors: string[] = [];

  if (raw === null || typeof raw !== 'object') {
    return { ok: false, errors: ['Plan is not an object'] };
  }

  const plan = raw as Record<string, unknown>;

  if (typeof plan.id !== 'string' || !plan.id) {
    errors.push('Missing required field: id (string)');
  }
  if (typeof plan.goal !== 'string' || !plan.goal) {
    errors.push('Missing required field: goal (string)');
  }
  if (typeof plan.summary !== 'string') {
    errors.push('Missing required field: summary (string)');
  }
  if (typeof plan.version !== 'string') {
    errors.push('Missing required field: version (string)');
  }
  if (typeof plan.createdAt !== 'number') {
    errors.push('Missing required field: createdAt (number)');
  }
  if (!Array.isArray(plan.steps)) {
    errors.push('Missing required field: steps (array)');
  } else {
    for (let i = 0; i < plan.steps.length; i += 1) {
      const step = plan.steps[i];
      if (step === null || typeof step !== 'object') {
        errors.push(`steps[${i}] is not an object`);
        continue;
      }
      const typedStep = step as Record<string, unknown>;
      if (typeof typedStep.id !== 'string' || !typedStep.id) {
        errors.push(`steps[${i}].id is missing or not a string`);
      }
      if (typeof typedStep.title !== 'string' || !typedStep.title) {
        errors.push(`steps[${i}].title is missing or not a string`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, plan: raw as FrameworkAgentPlan };
}

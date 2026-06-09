export type AgentStepStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AgentStep {
  id: string;
  title: string;
  description?: string;
  status?: AgentStepStatus;
  command?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentPlan {
  id: string;
  goal: string;
  summary: string;
  steps: AgentStep[];
  createdAt: number;
  version: string;
}

export interface AgentContext {
  files: string[];
  goals: string[];
  repository?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentEvent<TPayload = unknown> {
  type: string;
  payload?: TPayload;
  timestamp: number;
}

export interface AgentDiff {
  path: string;
  type: "create" | "update" | "delete";
  preview?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentExecutionResult {
  stepId: string;
  status: AgentStepStatus;
  diff?: AgentDiff[];
  logs?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentReport {
  goal: string;
  summary: string;
  steps: AgentExecutionResult[];
  startedAt: number;
  completedAt: number;
  metadata?: Record<string, unknown>;
}

export interface AgentAskResult {
  prompt: string;
  response: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

// ── Plan validation ─────────────────────────────────────────────────────────

export type PlanValidationResult =
  | { ok: true; plan: AgentPlan }
  | { ok: false; errors: string[] };

/**
 * Structural validator for AgentPlan objects returned by the planner.
 * Used to catch malformed or incomplete plans before they reach the executor.
 * Emits a PLAN_PARSE_FAILED event so the runtime can surface the error cleanly.
 */
export function validateAgentPlan(raw: unknown): PlanValidationResult {
  const errors: string[] = [];

  if (raw === null || typeof raw !== 'object') {
    return { ok: false, errors: ['Plan is not an object'] };
  }

  const plan = raw as Record<string, unknown>;

  if (typeof plan['id'] !== 'string' || !plan['id']) {
    errors.push('Missing required field: id (string)');
  }
  if (typeof plan['goal'] !== 'string' || !plan['goal']) {
    errors.push('Missing required field: goal (string)');
  }
  if (typeof plan['summary'] !== 'string') {
    errors.push('Missing required field: summary (string)');
  }
  if (typeof plan['version'] !== 'string') {
    errors.push('Missing required field: version (string)');
  }
  if (typeof plan['createdAt'] !== 'number') {
    errors.push('Missing required field: createdAt (number)');
  }
  if (!Array.isArray(plan['steps'])) {
    errors.push('Missing required field: steps (array)');
  } else {
    for (let i = 0; i < (plan['steps'] as unknown[]).length; i++) {
      const step = (plan['steps'] as unknown[])[i];
      if (step === null || typeof step !== 'object') {
        errors.push(`steps[${i}] is not an object`);
        continue;
      }
      const s = step as Record<string, unknown>;
      if (typeof s['id'] !== 'string' || !s['id']) {
        errors.push(`steps[${i}].id is missing or not a string`);
      }
      if (typeof s['title'] !== 'string' || !s['title']) {
        errors.push(`steps[${i}].title is missing or not a string`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, plan: raw as AgentPlan };
}

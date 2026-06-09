/**
 * Pure plan-run helpers extracted from extension.ts.
 *
 * Why: extension.ts crossed 9k lines and bandit's self-evaluation
 * flagged it as monolithic. These four functions had no `this`
 * dependency — they take inputs and return outputs — so they're a
 * clean cut. The stateful plan methods (`getPlanSnapshot`,
 * `updatePlanRunStep`, `serializePlanRuns`, `syncPlanStateFromConversation`)
 * stay on the class because they delegate to the ConversationService.
 */
import type { Plan, Task } from '@burtson-labs/stealth-core-runtime';

/**
 * Deep-clone a Plan so downstream mutation (per-step state changes,
 * task reordering, etc.) doesn't bleed back into the model's original
 * payload. Arrays are spread; nested task objects are cloned with
 * their `files` and `metadata` collections copied too — both are the
 * spots most likely to be mutated by step-state machinery.
 */
export function clonePlan(plan: Plan): Plan {
  const cloneTask = (task: Task): Task => ({
    ...task,
    files: Array.isArray(task.files) ? [...task.files] : undefined,
    metadata: task.metadata ? { ...task.metadata } : undefined
  });
  return {
    goal: plan.goal,
    steps: Array.isArray(plan.steps) ? plan.steps.map((step) => ({ ...step })) : [],
    tasks: Array.isArray(plan.tasks) ? plan.tasks.map((task) => cloneTask(task)) : undefined,
    goals: Array.isArray(plan.goals)
      ? plan.goals.map((goal) => ({
          ...goal,
          tasks: Array.isArray(goal.tasks) ? goal.tasks.map((task) => cloneTask(task)) : []
        }))
      : undefined
  };
}

/** Mint a fresh plan-run id — ISO timestamp + short random tail. */
export function createPlanRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `run-${timestamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Make a string safe to use as a path segment: lowercase + digits +
 * `.`, `_`, `-` only; collapse runs of `-`; trim leading/trailing `-`.
 * Caps at 100 chars to keep cross-platform path-length budgets sane.
 * Returns `fallback` when sanitization leaves nothing.
 */
export function sanitizePathSegment(input: string, fallback: string): string {
  const normalized = input.replace(/[^a-z0-9._-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return normalized.length > 0 ? normalized.slice(0, 100) : fallback;
}

/**
 * Build the on-disk artifacts directory for a single plan run, namespaced
 * by the conversation id and the run id. Both segments are sanitized so a
 * conversation name with `/` or unicode never escapes the plans/ root.
 */
export function buildPlanArtifactsPath(conversationId: string, runId: string): string {
  const conversationSegment = sanitizePathSegment(conversationId, 'conversation');
  const runSegment = sanitizePathSegment(runId, 'run');
  return ['plans', conversationSegment, runSegment].join('/');
}

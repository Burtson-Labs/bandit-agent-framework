import type {
  AgentPlan as FrameworkAgentPlan,
  Task,
  TaskStatus
} from '@burtson-labs/agent-core';
import type { Plan, PlanStep, StepAction } from '../types';
import type { ITelemetry } from '../hostTypes';
import type { PlanUpdateState } from './types';

interface PlanUpdatePayload {
  stepId: string;
  state: PlanUpdateState;
  meta?: { summary?: string; durationMs?: number; tokens?: number };
}

export interface PlanContextDeps {
  telemetry: ITelemetry;
  postPlanUpdate(payload: PlanUpdatePayload): Promise<void> | void;
  emitTaskProgress(progress: { goalId?: string; completed: number; total: number }): Promise<void> | void;
}

export interface PlanContext {
  mapAgentPlan(agentPlan: FrameworkAgentPlan): Plan;
  applyPlanMetadata(plan: Plan): void;
  resetTaskTracking(): void;
  getTaskProgressSnapshot(): { goalId?: string; completed: number; total: number };
  postPlanUpdate(stepId: string, state: PlanUpdateState, meta?: { summary?: string; durationMs?: number; tokens?: number }): Promise<void>;
  resetPlanUpdates(): void;
  flushPlanUpdates(): void;
}

export function createPlanContext(deps: PlanContextDeps): PlanContext {
  let taskByStepId = new Map<string, Task[]>();
  let activeGoalId: string | undefined;
  const planUpdateQueue: Array<{ state: PlanUpdateState; payload: PlanUpdatePayload }> = [];
  let planUpdateTimer: NodeJS.Timeout | undefined;
  let lastPlanUpdateAt = 0;
  const planUpdateIntervalMs = 850;

  function extractPlanStepMetadata(
    metadata?: Record<string, unknown>,
    fallback?: Partial<PlanStep>
  ): Record<string, unknown> | undefined {
    if (metadata && typeof metadata.stepMetadata === 'object' && metadata.stepMetadata !== null) {
      return metadata.stepMetadata as Record<string, unknown>;
    }
    if (fallback && typeof fallback.metadata === 'object' && fallback.metadata !== null) {
      return fallback.metadata as Record<string, unknown>;
    }
    return undefined;
  }

  function mapAgentPlan(agentPlan: FrameworkAgentPlan): Plan {
    const steps = agentPlan.steps.map((step) => {
      const metadata = step.metadata as Record<string, unknown> | undefined;
      const stealthMetadata = metadata?.stealth as Partial<PlanStep> | undefined;
      const action = (metadata?.action ?? stealthMetadata?.action) as StepAction | undefined;
      const command = typeof metadata?.command === 'string'
        ? metadata.command
        : typeof stealthMetadata?.command === 'string'
          ? stealthMetadata.command
          : undefined;
      const targetFile = typeof metadata?.targetFile === 'string'
        ? metadata.targetFile
        : typeof stealthMetadata?.targetFile === 'string'
          ? stealthMetadata.targetFile
          : undefined;
      const stepMetadata = extractPlanStepMetadata(metadata, stealthMetadata);

      if (!action) {
        throw new Error(`Agent plan step "${step.id}" is missing execution metadata.`);
      }

      return {
        id: step.id,
        title: step.title,
        details: step.description ?? stealthMetadata?.details ?? '',
        action,
        command,
        targetFile,
        metadata: stepMetadata
      };
    });

    return {
      goal: agentPlan.goal,
      steps
    };
  }

  function logLikelyFilesForTasks(tasks: Task[]): void {
    tasks.forEach((task) => {
      const metadata = task.metadata as { likelyFiles?: unknown } | undefined;
      const likelyFiles = Array.isArray(metadata?.likelyFiles)
        ? metadata.likelyFiles.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
      if (!likelyFiles.length) {
        return;
      }
      void deps.telemetry.log({
        message: `Likely files for "${task.title}": ${likelyFiles.join(', ')}`,
        level: 'info'
      });
    });
  }

  function scrubLikelyFilesFromTasks(tasks: Task[]): void {
    tasks.forEach((task) => {
      const metadata = task.metadata as { likelyFiles?: unknown } | undefined;
      if (metadata && 'likelyFiles' in metadata) {
        delete metadata.likelyFiles;
      }
    });
  }

  function extractTaskStepIds(task: Task): string[] {
    if (!task.metadata || typeof task.metadata !== 'object') {
      return [];
    }
    const metadata = task.metadata as Record<string, unknown>;
    const candidates: string[] = [];
    const single = metadata.stepId;
    const multiple = metadata.stepIds;
    if (typeof single === 'string') {
      candidates.push(single);
    }
    if (Array.isArray(multiple)) {
      for (const value of multiple) {
        if (typeof value === 'string') {
          candidates.push(value);
        }
      }
    }
    return Array.from(new Set(candidates));
  }

  function rebuildTaskIndex(tasks: Task[]): void {
    const nextTaskIndex = new Map<string, Task[]>();
    for (const task of tasks) {
      const stepIds = extractTaskStepIds(task);
      if (!stepIds.length) {
        continue;
      }
      for (const stepId of stepIds) {
        const existing = nextTaskIndex.get(stepId) ?? [];
        existing.push(task);
        nextTaskIndex.set(stepId, existing);
      }
    }
    taskByStepId = nextTaskIndex;
  }

  function applyPlanMetadata(plan: Plan): void {
    const tasks = plan.tasks ?? [];
    if (tasks.length > 0) {
      logLikelyFilesForTasks(tasks);
      scrubLikelyFilesFromTasks(tasks);
      rebuildTaskIndex(tasks);
    } else {
      taskByStepId.clear();
    }
    activeGoalId = plan.goals?.[0]?.id;
  }

  function resetTaskTracking(): void {
    taskByStepId.clear();
    activeGoalId = undefined;
  }

  function getTaskProgressSnapshot(): { goalId?: string; completed: number; total: number } {
    if (taskByStepId.size === 0) {
      return { goalId: activeGoalId, completed: 0, total: 0 };
    }
    const flattened = Array.from(taskByStepId.values()).flat();
    const uniqueTasks = Array.from(new Set(flattened));
    const completed = uniqueTasks.filter((task) => task.status === 'completed').length;
    return {
      goalId: activeGoalId,
      completed,
      total: uniqueTasks.length
    };
  }

  function mapStateToTaskStatus(state: PlanUpdateState): TaskStatus | undefined {
    switch (state) {
      case 'start':
        return 'in_progress';
      case 'complete':
      case 'approved':
        return 'completed';
      case 'error':
      case 'needs-revision':
        return 'failed';
      default:
        return undefined;
    }
  }

  function updateTaskStatusFromState(stepId: string, state: PlanUpdateState): void {
    const tasks = taskByStepId.get(stepId);
    if (!tasks || !tasks.length) {
      return;
    }
    const nextStatus = mapStateToTaskStatus(state);
    if (!nextStatus) {
      return;
    }
    for (const task of tasks) {
      if (task.status === nextStatus) {
        continue;
      }
      if (task.status === 'completed' && nextStatus === 'in_progress') {
        continue;
      }
      task.status = nextStatus;
    }
  }

  async function emitTaskProgress(): Promise<void> {
    const progress = getTaskProgressSnapshot();
    if (progress.total === 0) {
      return;
    }
    await deps.emitTaskProgress(progress);
  }

  function enqueuePlanUpdate(state: PlanUpdateState, payload: PlanUpdatePayload): void {
    const immediateStates: PlanUpdateState[] = ['start', 'error', 'needs-revision'];
    if (immediateStates.includes(state)) {
      lastPlanUpdateAt = Date.now();
      void deps.postPlanUpdate(payload);
      return;
    }
    planUpdateQueue.push({ state, payload });
    if (!planUpdateTimer) {
      const now = Date.now();
      const elapsed = now - lastPlanUpdateAt;
      const delay = Math.max(planUpdateIntervalMs - elapsed, 0);
      scheduleNextPlanUpdate(delay);
    }
  }

  function scheduleNextPlanUpdate(delay: number): void {
    planUpdateTimer = setTimeout(() => {
      planUpdateTimer = undefined;
      const next = planUpdateQueue.shift();
      if (!next) {
        return;
      }
      void deps.postPlanUpdate(next.payload);
      lastPlanUpdateAt = Date.now();
      if (planUpdateQueue.length > 0) {
        scheduleNextPlanUpdate(planUpdateIntervalMs);
      }
    }, Math.max(delay, 0));
  }

  async function postPlanUpdate(
    stepId: string,
    state: PlanUpdateState,
    meta?: { summary?: string; durationMs?: number; tokens?: number }
  ): Promise<void> {
    const payload: PlanUpdatePayload = { stepId, state, meta };
    enqueuePlanUpdate(state, payload);
    updateTaskStatusFromState(stepId, state);
    await emitTaskProgress();
  }

  function resetPlanUpdates(): void {
    planUpdateQueue.length = 0;
    if (planUpdateTimer) {
      clearTimeout(planUpdateTimer);
      planUpdateTimer = undefined;
    }
    lastPlanUpdateAt = 0;
  }

  function flushPlanUpdates(): void {
    if (planUpdateTimer) {
      clearTimeout(planUpdateTimer);
      planUpdateTimer = undefined;
    }
    while (planUpdateQueue.length > 0) {
      const next = planUpdateQueue.shift();
      if (next) {
        void deps.postPlanUpdate(next.payload);
      }
    }
  }

  return {
    mapAgentPlan,
    applyPlanMetadata,
    resetTaskTracking,
    getTaskProgressSnapshot,
    postPlanUpdate,
    resetPlanUpdates,
    flushPlanUpdates
  };
}

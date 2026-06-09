import type { ITelemetry } from '../hostTypes';
import type { Plan, AgentReport, ExecutionResult } from '../types';
import type { PlanUpdateState, DiffStreamUpdate } from './types';
import type { Goal } from '@burtson-labs/agent-core';
import type { InferredGoal } from '../goalInference';
import type { WorkspaceIndexSnapshot } from '../workspaceIndex';

export interface TelemetryHubDeps {
  telemetry: ITelemetry;
  postMessage(message: unknown): Promise<void> | void;
}

export function createTelemetryHub(deps: TelemetryHubDeps) {
  let lastEmbeddingStatusAt: number | undefined;

  function describeFreshness(timestamp?: number): string {
    if (!timestamp) {
      return 'unknown';
    }
    const delta = Date.now() - timestamp;
    if (delta < 30 * 1000) {
      return 'just now';
    }
    const minutes = Math.floor(delta / 60000);
    if (minutes < 2) {
      return '1 minute ago';
    }
    if (minutes < 60) {
      return `${minutes} minutes ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    }
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  function formatBytes(bytes: number | undefined): string {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes)) {
      return 'unknown size';
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
  }

  async function emitHelperTelemetry(helper: { id?: string; path?: string }, outcome: { ok: boolean; error?: string }): Promise<void> {
    await deps.postMessage({
      type: 'agent:telemetry',
      kind: 'helper-extraction',
      helper,
      ok: outcome.ok,
      error: outcome.ok ? undefined : outcome.error
    });
  }

  async function emitGoalCandidateLog(files: string[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    await deps.telemetry.log({
      message: `Goal inference suggested these files: ${files.join(', ')}`,
      level: 'info'
    });
  }

  async function emitGoalInference(goal: Goal | undefined, insight?: InferredGoal): Promise<void> {
    if (!goal || !insight) {
      return;
    }
    await deps.postMessage({
      type: 'agent:telemetry',
      kind: 'goal-inference',
      goal: {
        id: goal.id,
        title: goal.title,
        intent: insight.intent,
        files: insight.files,
        rationale: insight.rationale
      }
    });
  }

  async function emitTaskProgress(progress: { goalId?: string; completed: number; total: number }): Promise<void> {
    if (progress.total === 0) {
      return;
    }
    await deps.postMessage({
      type: 'agent:telemetry',
      kind: 'task-progress',
      progress
    });
  }

  async function emitExecutionTelemetry(stepId: string, result: ExecutionResult, tokens: number): Promise<void> {
    const duration = (result.data as { durationMs?: number } | undefined)?.durationMs ?? 0;
    await deps.postMessage({
      type: 'agent:telemetry',
      stepId,
      durationMs: duration,
      tokens,
      ok: result.ok
    });
  }

  async function postPlan(plan: Plan): Promise<void> {
    await deps.postMessage({ type: 'agent:plan', plan });
  }

  async function postFinal(report: AgentReport): Promise<void> {
    await deps.postMessage({ type: 'agent:final', report });
  }

  async function postPlanUpdate(payload: {
    stepId: string;
    state: PlanUpdateState;
    meta?: { summary?: string; durationMs?: number; tokens?: number };
  }): Promise<void> {
    await deps.postMessage({
      type: 'agent:planUpdate',
      stepId: payload.stepId,
      state: payload.state,
      meta: payload.meta
    });
  }

  async function postEmbedding(event: string, payload: Record<string, unknown>): Promise<void> {
    await deps.postMessage({ type: 'agent:telemetry', kind: 'embedding', event, ...payload });
  }

  async function postStatus(payload: Parameters<ITelemetry['status']>[0]): Promise<void> {
    await deps.telemetry.status(payload);
  }

  async function postLog(payload: Parameters<ITelemetry['log']>[0]): Promise<void> {
    await deps.telemetry.log(payload);
  }

  async function postWorkspaceIndexStatus(snapshot: WorkspaceIndexSnapshot): Promise<void> {
    const totalFiles = snapshot.files.length;
    const detailParts = [
      `Last scanned ${describeFreshness(snapshot.generatedAt)}`,
      `${totalFiles} file${totalFiles === 1 ? '' : 's'}`,
      formatBytes(snapshot.totalBytes)
    ];
    await deps.telemetry.status({
      text: `Workspace index ready — ${totalFiles} file${totalFiles === 1 ? '' : 's'}`,
      phase: 'progress',
      detail: detailParts.join(' • '),
      icon: 'info'
    });
  }

  async function postEmbeddingStatus(input: { stats: { reused: number; computed: number }; totalTracked: number }): Promise<void> {
    lastEmbeddingStatusAt = Date.now();
    const detailParts = [
      `Reused ${input.stats.reused}`,
      `Computed ${input.stats.computed}`,
      `${input.totalTracked} tracked file${input.totalTracked === 1 ? '' : 's'}`,
      `Refreshed ${describeFreshness(lastEmbeddingStatusAt)}`
    ];
    await deps.telemetry.status({
      text: 'Embedding cache updated',
      phase: 'progress',
      detail: detailParts.join(' • '),
      icon: 'search'
    });
  }

  async function postDiffSnapshot(payload: {
    path: string;
    diff: string;
    summary?: { added: number; removed: number };
    confidence?: number;
  }): Promise<void> {
    await deps.postMessage({
      type: 'agent:diffSnapshot',
      path: payload.path,
      diff: payload.diff,
      summary: payload.summary,
      confidence: payload.confidence
    });
  }

  async function postDiffStream(update: DiffStreamUpdate): Promise<void> {
    await deps.postMessage({
      type: 'agent:diffStream',
      path: update.path,
      kind: update.kind,
      content: update.content
    });
  }

  async function promptRewriteRefinement(step: Plan): Promise<string | undefined> {
    await deps.postMessage({ type: 'agent:promptRewriteRefinement', step });
    return undefined;
  }

  return {
    emitHelperTelemetry,
    emitGoalCandidateLog,
    emitGoalInference,
    emitTaskProgress,
    emitExecutionTelemetry,
    postPlan,
    postFinal,
    postPlanUpdate,
    postEmbedding,
    postStatus,
    postLog,
    postWorkspaceIndexStatus,
    postEmbeddingStatus,
    postDiffSnapshot,
    postDiffStream,
    promptRewriteRefinement
  };
}

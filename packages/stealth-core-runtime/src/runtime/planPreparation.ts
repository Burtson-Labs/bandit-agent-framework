import type {
  AgentPlan as FrameworkAgentPlan,
  Goal as FrameworkGoal,
  PlanOptions
} from '@burtson-labs/agent-core';
import type { Plan } from '../internalTypes';
import type { InferredGoal } from '../internalTypes';
import type { EmbeddingSearchHit } from '../internalTypes';
import type { PlanContext } from '../internalTypes';
import type { ArtifactSetupOptions } from './artifactManager';
import type { GoalContextDeps } from './insight';
import type {
  IGoalEngine,
  IDiffManager,
  ITelemetry,
  TypeScriptValidator
} from '../internalTypes';
import type { WorkspaceIndexSnapshot } from '../internalTypes';
import type { EmbeddingCache } from '../internalTypes';
import { collectGoalContext } from './insight';
import { generatePlan } from './planGenerator';

interface Configuration {
  get<T>(section: string, defaultValue: T): T;
}

interface ArtifactManager {
  setup(options: ArtifactSetupOptions): Promise<void>;
  getArtifactRoot(): string;
}

interface PlanTelemetryHooks {
  postPlan(plan: Plan): Promise<void>;
  emitGoal(goal: FrameworkGoal | undefined, insight?: InferredGoal): void;
  emitTask(progress: { goalId?: string; completed: number; total: number }): void;
}

export interface PlanPreparationRunOptions {
  lightweight: boolean;
  previewOnly: boolean;
  modelTier?: 'small' | 'medium' | 'large';
}

export interface PlanPreparationInput {
  goal: string;
  workspaceRoot: string;
  runOptions: PlanPreparationRunOptions;
}

export interface PlanPreparationResult {
  plan: Plan;
  insight?: InferredGoal;
}

export interface PlanPreparer {
  run(input: PlanPreparationInput): Promise<PlanPreparationResult>;
}

export interface PlanPreparationDeps {
  diffManager: Pick<IDiffManager, 'enableReviewMode' | 'clear'>;
  artifactManager: ArtifactManager;
  planContext: Pick<
    PlanContext,
    'resetPlanUpdates' | 'resetTaskTracking' | 'mapAgentPlan' | 'applyPlanMetadata' | 'getTaskProgressSnapshot'
  >;
  telemetry: ITelemetry;
  telemetryHooks: PlanTelemetryHooks;
  goalContext: GoalContextDeps;
  embeddingCache: Pick<EmbeddingCache, 'prepare'>;
  typescriptValidator: Pick<TypeScriptValidator, 'captureBaseline'>;
  goalEngine: IGoalEngine;
  createAgentPlan(goal: string, options: PlanOptions): Promise<FrameworkAgentPlan>;
  normalizeRelativePath(value: string): string | undefined;
  getWorkspaceIndexSnapshot(): WorkspaceIndexSnapshot | undefined;
  getConfiguration(): Configuration;
  getArtifactPaths(): { storagePath?: string; globalStoragePath?: string };
}

export function createPlanPreparer(deps: PlanPreparationDeps): PlanPreparer {
  async function run(input: PlanPreparationInput): Promise<PlanPreparationResult> {
    const configuration = deps.getConfiguration();
    deps.diffManager.enableReviewMode(configuration.get<boolean>('diff.reviewMode', false));

    const artifactPaths = deps.getArtifactPaths();
    await deps.artifactManager.setup({
      workspaceRoot: input.workspaceRoot,
      emitArtifacts: configuration.get<boolean>('debug.emitPlanJson', true),
      storagePath: artifactPaths.storagePath,
      globalStoragePath: artifactPaths.globalStoragePath
    });

    deps.planContext.resetPlanUpdates();
    deps.diffManager.clear();
    deps.planContext.resetTaskTracking();

    const { embeddingHits, goalInsight, enrichedInsight } = await collectGoalContext(
      deps.goalContext,
      input.goal
    );
    const planInsight = enrichedInsight ?? goalInsight;

    if (!input.runOptions.lightweight) {
      await deps.embeddingCache
        .prepare(input.workspaceRoot, deps.artifactManager.getArtifactRoot())
        .catch(() => undefined);
    }

    if (!input.runOptions.previewOnly) {
      void deps.typescriptValidator.captureBaseline().catch(() => undefined);
    }

    const planOptions = buildPlanOptions({
      runOptions: input.runOptions,
      insight: planInsight,
      embeddingHits,
      snapshot: deps.getWorkspaceIndexSnapshot(),
      normalizeRelativePath: deps.normalizeRelativePath
    });

    const plan = await generatePlan(
      {
        createAgentPlan: (targetGoal, options) => deps.createAgentPlan(targetGoal, options),
        goalEngine: deps.goalEngine,
        mapPlan: (agentPlan) => deps.planContext.mapAgentPlan(agentPlan),
        applyMetadata: (candidate) => deps.planContext.applyPlanMetadata(candidate),
        telemetry: deps.telemetry,
        postPlan: (candidate) => deps.telemetryHooks.postPlan(candidate),
        emitGoalTelemetry: (goalCandidate, insight) => deps.telemetryHooks.emitGoal(goalCandidate, insight),
        emitTaskTelemetry: () => {
          const progress = deps.planContext.getTaskProgressSnapshot();
          deps.telemetryHooks.emitTask(progress);
        }
      },
      { goal: input.goal, planOptions, insight: planInsight }
    );

    return { plan, insight: planInsight };
  }

  return { run };
}

function buildPlanOptions(input: {
  runOptions: PlanPreparationRunOptions;
  insight?: InferredGoal;
  embeddingHits: EmbeddingSearchHit[];
  snapshot?: WorkspaceIndexSnapshot;
  normalizeRelativePath: (value: string) => string | undefined;
}): PlanOptions {
  const metadata: Record<string, unknown> = {
    lightweight: input.runOptions.lightweight,
    previewOnly: input.runOptions.previewOnly
  };

  if (input.runOptions.modelTier) {
    metadata.modelTier = input.runOptions.modelTier;
  }

  if (input.insight) {
    metadata.goalInference = {
      title: input.insight.title,
      intent: input.insight.intent,
      files: input.insight.files,
      rationale: input.insight.rationale
    };
  }

  const embeddingCandidates = buildEmbeddingCandidates(input.embeddingHits, input.normalizeRelativePath);
  if (embeddingCandidates.length > 0) {
    metadata.embeddingCandidates = embeddingCandidates;
  }

  const contextFiles = buildContextFiles({
    insight: input.insight,
    embeddingCandidates,
    snapshot: input.snapshot,
    normalizeRelativePath: input.normalizeRelativePath
  });
  if (contextFiles.length > 0) {
    metadata.contextFiles = contextFiles;
  }

  const snapshotSummary = buildWorkspaceIndexMetadata(input.snapshot);
  if (snapshotSummary) {
    metadata.workspaceIndex = snapshotSummary;
  }

  return {
    metadata,
    context: contextFiles.length > 0 ? { files: contextFiles } : undefined
  };
}

function buildEmbeddingCandidates(
  hits: EmbeddingSearchHit[],
  normalizeRelativePath: (value: string) => string | undefined
): Array<{ path: string; score?: number }> {
  if (!hits.length) {
    return [];
  }
  const seen = new Set<string>();
  return hits
    .map((hit) => {
      const normalizedPath = normalizeRelativePath(hit.path) ?? hit.path;
      if (!normalizedPath) {
        return undefined;
      }
      const key = normalizedPath.toLowerCase();
      if (seen.has(key)) {
        return undefined;
      }
      seen.add(key);
      const score = typeof hit.score === 'number' ? Number(hit.score.toFixed(4)) : undefined;
      return {
        path: normalizedPath,
        ...(typeof score === 'number' ? { score } : {})
      };
    })
    .filter((entry): entry is { path: string; score?: number } => Boolean(entry?.path));
}

const MAX_CONTEXT_FILES = 40;

function buildContextFiles(input: {
  insight?: InferredGoal;
  embeddingCandidates: Array<{ path: string }>;
  snapshot?: WorkspaceIndexSnapshot;
  normalizeRelativePath: (value: string) => string | undefined;
}): string[] {
  const collected: string[] = [];
  const seen = new Set<string>();
  const add = (value?: string) => {
    if (!value) {
      return;
    }
    const normalized = input.normalizeRelativePath(value) ?? value;
    if (!normalized) {
      return;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    collected.push(normalized);
  };

  input.insight?.files?.forEach((file) => add(file));
  input.embeddingCandidates.forEach((entry) => add(entry.path));

  if (collected.length < MAX_CONTEXT_FILES && input.snapshot?.files?.length) {
    for (const file of input.snapshot.files) {
      add(file.path);
      if (collected.length >= MAX_CONTEXT_FILES) {
        break;
      }
    }
  }

  return collected.slice(0, MAX_CONTEXT_FILES);
}

function buildWorkspaceIndexMetadata(
  snapshot: WorkspaceIndexSnapshot | undefined
): Record<string, unknown> | undefined {
  if (!snapshot || snapshot.files.length === 0) {
    return undefined;
  }
  const slice = snapshot.files.slice(0, 400);
  return {
    generatedAt: snapshot.generatedAt,
    totalFiles: snapshot.files.length,
    totalBytes: snapshot.totalBytes,
    files: slice.map((file) => ({
      path: file.path,
      size: file.size,
      hash: file.hash,
      preview: file.preview ? truncatePreview(file.preview) : undefined
    }))
  };
}

function truncatePreview(value: string, max = 240): string {
  if (!value) {
    return '';
  }
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

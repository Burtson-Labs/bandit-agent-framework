import type { AgentPlan as FrameworkAgentPlan, Goal as FrameworkGoal, PlanOptions } from '@burtson-labs/agent-core';
import { clampDiffPreview, summarizeDiff } from './diffPresenter';
import { createHelperManager } from './helpers';
import { createDiffManager } from './diffManager';
import { createUndoManager } from './undoManager';
import { createArtifactManager } from './artifactManager';
import { createWorkspacePackageManager, type WorkspacePackageManager } from './workspacePackages';
import { createWorkspaceIndexService } from './workspaceIndexService';
import { createTypeScriptValidator } from './typescriptValidator';
import { createPlanPreparer } from './planPreparation';
import type {
  IFsAdapter,
  ITelemetry,
  IGoalEngine,
  IHelperManager,
  IDiffManager,
  TypeScriptValidator,
  ValidationOutcome
} from './types';
import type { PlanContext } from './planContext';
import type { WorkspaceIndexSnapshot } from '../workspaceIndex';
import type { EmbeddingCache } from '../embeddingCache';
import type { EmbeddingManager } from './embeddingManager';
import type { EmbeddingSearchHit } from '../embeddingClient';
import type { InferredGoal } from '../goalInference';
import type { Plan } from '../types';

interface WorkspaceConfiguration {
  get<T>(section: string, defaultValue: T): T;
}

interface PlannerAgent {
  createPlan(goal: string, options: PlanOptions): Promise<FrameworkAgentPlan>;
}

export interface WorkspaceServicesDeps {
  telemetry: ITelemetry;
  telemetryHub: {
    postDiffSnapshot(entry: { path: string; diff: string; summary?: { added: number; removed: number }; confidence?: number }): Promise<void>;
    postDiffStream(update: { path: string; kind: 'start' | 'progress' | 'complete'; content?: string }): Promise<void>;
    postWorkspaceIndexStatus(snapshot: WorkspaceIndexSnapshot): Promise<void>;
    postPlan(plan: Plan): Promise<void>;
    emitGoal(goal: FrameworkGoal | undefined, insight?: InferredGoal): void;
    emitTask(progress: { goalId?: string; completed: number; total: number }): void;
  };
  fs: IFsAdapter;
  workspace: {
    readFile(target: string, encoding?: BufferEncoding): Promise<string>;
    writeFile(target: string, content: string, encoding?: BufferEncoding): Promise<void>;
    normalizeRelativePath(value: string): string | undefined;
    isPathInside(base: string, target: string): boolean;
  };
  planContext: PlanContext;
  validationUtils: {
    findTsConfigFile(): Promise<string | undefined>;
    buildTypeScriptValidationCommands(args: string[]): Promise<Array<{ command: string; args: string[] }>>;
    spawnValidationProcess(command: string, args: string[], cwd: string): Promise<ValidationOutcome>;
    getCommandName(base: string): string;
  };
  validationController: {
    shouldSkipValidations(): boolean;
    isThrottled(kind: string): boolean;
    markRun(kind: string): void;
  };
  embeddingManager: EmbeddingManager;
  embeddingCache: EmbeddingCache;
  goalEngine: IGoalEngine;
  plannerAgent: PlannerAgent;
  loadWorkspaceIndex(force?: boolean): Promise<string[]>;
  setContextValue(key: string, value: unknown): void;
  getContextValue<T>(key: string): T | undefined;
  getWorkspaceRoot(): string;
  getLastWorkspaceRoot(): string | undefined;
  clampSnippet(content: string, limit?: number): string;
  conversationMarkerPatterns: RegExp[];
  computeDiff(before: string, after: string, relativePath: string): Promise<string | undefined>;
  resolvePlanRunDirectory(workspaceRoot: string): string;
  getRunContext(): { conversationId?: string | null; runId?: string | null } | undefined;
  getConfiguration(): WorkspaceConfiguration;
  getArtifactPaths(): { storagePath?: string; globalStoragePath?: string };
  searchEmbeddingCandidates(goal: string): Promise<EmbeddingSearchHit[]>;
  runGoalInference(goal: string, index: string[]): Promise<InferredGoal | undefined>;
  mergeInsightWithEmbeddings(insight: InferredGoal | undefined, hits: EmbeddingSearchHit[]): InferredGoal | undefined;
  runTypeCheck(options?: { files?: string[] }): Promise<{ ok: boolean; output?: string }>;
  helperImportExtensions: string[];
}

export interface WorkspaceServicesResult {
  helperManager: IHelperManager;
  diffManager: IDiffManager;
  undoManager: ReturnType<typeof createUndoManager>;
  artifactManager: ReturnType<typeof createArtifactManager>;
  workspacePackageManager: WorkspacePackageManager;
  workspaceIndex: ReturnType<typeof createWorkspaceIndexService>;
  typescriptValidator: TypeScriptValidator;
  planPreparer: ReturnType<typeof createPlanPreparer>;
}

export function createWorkspaceServices(deps: WorkspaceServicesDeps): WorkspaceServicesResult {
  const workspaceRoot = () => deps.getLastWorkspaceRoot() ?? deps.getWorkspaceRoot();

  const diffManager = createDiffManager({
    postSnapshot: async ({ path, diff, summary, confidence }) => {
      const snapshotDiff = typeof diff === 'string' ? clampDiffPreview(diff, 200) : '';
      await deps.telemetryHub.postDiffSnapshot({
        path,
        diff: snapshotDiff,
        summary,
        confidence
      });
    },
    postStream: (update) => deps.telemetryHub.postDiffStream(update),
    computeDiff: (before, after, relativePath) => deps.computeDiff(before, after, relativePath),
    summarizeDiff: (diff) => summarizeDiff(diff)
  });

  const undoManager = createUndoManager({
    diffManager,
    fs: deps.fs
  });

  const artifactManager = createArtifactManager({
    fs: deps.fs,
    resolvePlanRunDirectory: (root) => deps.resolvePlanRunDirectory(root),
    getRunContext: () => deps.getRunContext(),
    writeWorkspaceFile: (target, content) => deps.workspace.writeFile(target, content, 'utf8'),
    readWorkspaceFile: (target) => deps.workspace.readFile(target)
  });

  const workspacePackageManager = createWorkspacePackageManager({
    readWorkspaceFile: (target) => deps.workspace.readFile(target),
    normalizeRelativePath: (value) => deps.workspace.normalizeRelativePath(value),
    spawnValidationProcess: (command, args, cwd) => deps.validationUtils.spawnValidationProcess(command, args, cwd),
    getCommandName: (base) => deps.validationUtils.getCommandName(base)
  });

  const workspaceIndex = createWorkspaceIndexService({
    getWorkspaceRoot: () => workspaceRoot(),
    getArtifactRoot: (root) => artifactManager.getArtifactRootOrDefault(root),
    setWorkspaceIndexContext: (summary) => deps.setContextValue('workspace.index', summary),
    postStatus: (snapshot) => deps.telemetryHub.postWorkspaceIndexStatus(snapshot),
    updateWorkspacePackages: (snapshot) => workspacePackageManager.updateFromSnapshot(snapshot),
    normalizeRelativePath: (value) => deps.workspace.normalizeRelativePath(value)
  });

  const helperManager = createHelperManager({
    fs: deps.fs,
    getWorkspaceRoot: () => workspaceRoot(),
    getContextValue: (key) => deps.getContextValue(key),
    setContextValue: (key, value) => deps.setContextValue(key, value),
    runTypeCheck: (options) => deps.runTypeCheck(options),
    normalizeRelativePath: (value) => deps.workspace.normalizeRelativePath(value),
    resolveWorkspaceImportTarget: (relativePath) =>
      workspaceIndex.resolveImportTarget(relativePath, deps.helperImportExtensions),
    ensureWorkspaceIndex: () => deps.loadWorkspaceIndex().then(() => undefined),
    conversationMarkerPatterns: deps.conversationMarkerPatterns,
    clampSnippet: (content, limit) => deps.clampSnippet(content, limit)
  });

  const typescriptValidator = createTypeScriptValidator({
    telemetry: deps.telemetry,
    shouldSkipValidations: () => deps.validationController.shouldSkipValidations(),
    getWorkspaceRoot: () => workspaceRoot(),
    findTsConfigFile: () => deps.validationUtils.findTsConfigFile(),
    buildValidationCommands: (args) => deps.validationUtils.buildTypeScriptValidationCommands(args),
    spawnValidationProcess: (command, args, cwd) => deps.validationUtils.spawnValidationProcess(command, args, cwd),
    isValidationThrottled: (kind) => deps.validationController.isThrottled(kind),
    markValidationRun: (kind) => deps.validationController.markRun(kind),
    normalizeRelativePath: (value) => deps.workspace.normalizeRelativePath(value),
    mapDiagnosticsToWorkspace: (diagnostics) => workspaceIndex.mapDiagnosticsToWorkspace(diagnostics)
  });

  const planPreparer = createPlanPreparer({
    diffManager,
    artifactManager,
    planContext: deps.planContext,
    telemetry: deps.telemetry,
    telemetryHooks: {
      postPlan: (candidate) => deps.telemetryHub.postPlan(candidate),
      emitGoal: (goalCandidate, insight) => deps.telemetryHub.emitGoal(goalCandidate, insight),
      emitTask: (progress) => deps.telemetryHub.emitTask(progress)
    },
    goalContext: {
      loadWorkspaceIndex: () => deps.loadWorkspaceIndex(),
      searchEmbeddingCandidates: (targetGoal) => deps.searchEmbeddingCandidates(targetGoal),
      runGoalInference: (targetGoal, index) => deps.runGoalInference(targetGoal, index),
      mergeInsightWithEmbeddings: (insight, hits) => deps.mergeInsightWithEmbeddings(insight, hits)
    },
    embeddingCache: deps.embeddingCache,
    typescriptValidator,
    goalEngine: deps.goalEngine,
    createAgentPlan: (targetGoal, planOptions) => deps.plannerAgent.createPlan(targetGoal, planOptions),
    normalizeRelativePath: (value) => deps.workspace.normalizeRelativePath(value),
    getWorkspaceIndexSnapshot: () => workspaceIndex.getSnapshot(),
    getConfiguration: () => deps.getConfiguration(),
    getArtifactPaths: () => deps.getArtifactPaths()
  });

  return {
    helperManager,
    diffManager,
    undoManager,
    artifactManager,
    workspacePackageManager,
    workspaceIndex,
    typescriptValidator,
    planPreparer
  };
}

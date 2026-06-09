import { createWorkspaceRuntimeServices, type WorkspaceRuntimeResult } from '../workspaceRuntime';
import type {
  ITelemetry,
  IGoalEngine,
  IFsAdapter,
  ValidationOutcome,
  IPythonEnv,
  IShellAdapter
} from '../types';
import type { EventBus } from '../eventBus';
import type { PlanContext } from '../planContext';
import type { Plan, PlanStep } from '../../types';
import type { WorkspaceIndexSnapshot } from '../../workspaceIndex';
import type { Goal as FrameworkGoal, PlanOptions, AgentPlan } from '@burtson-labs/agent-core';
import type { EmbeddingCache } from '../../embeddingCache';
import type { EmbeddingManager } from '../embeddingManager';
import type { InferredGoal } from '../../goalInference';
import type { EmbeddingSearchHit } from '../../embeddingClient';
import type { SessionRuntime } from '../sessionRuntime';
import type { createValidationController } from '../validationController';

interface WorkspaceConfiguration {
  get<T>(key: string, defaultValue: T): T;
}

interface PlannerAgent {
  createPlan(goal: string, options: PlanOptions): Promise<AgentPlan>;
}

export interface WorkspaceHostDeps {
  telemetry: ITelemetry;
  telemetryHub: {
    postDiffSnapshot(entry: { path: string; diff: string; summary?: { added: number; removed: number }; confidence?: number }): Promise<void>;
    postDiffStream(update: { path: string; kind: 'start' | 'progress' | 'complete'; content?: string }): Promise<void>;
    postWorkspaceIndexStatus(snapshot: WorkspaceIndexSnapshot): Promise<void>;
    postPlan(plan: Plan): Promise<void>;
    emitGoal(goal: FrameworkGoal | undefined, insight?: InferredGoal): void;
    emitTask(progress: { goalId?: string; completed: number; total: number }): void;
  };
  fsAdapter: IFsAdapter;
  workspaceService: {
    readFile(target: string, encoding?: BufferEncoding): Promise<string>;
    writeFile(target: string, content: string, encoding?: BufferEncoding): Promise<void>;
    normalizeRelativePath(value: string): string | undefined;
    isPathInside(base: string, target: string): boolean;
    fileExists(path: string): Promise<boolean>;
    pathExists(target: string): Promise<boolean>;
  };
  planContext: PlanContext;
  validationUtils: {
    findTsConfigFile(): Promise<string | undefined>;
    buildTypeScriptValidationCommands(args: string[]): Promise<Array<{ command: string; args: string[] }>>;
    spawnValidationProcess(command: string, args: string[], cwd: string): Promise<ValidationOutcome>;
    getCommandName(base: string): string;
  };
  validationController: ReturnType<typeof createValidationController>;
  embeddingManager: EmbeddingManager;
  embeddingCache: EmbeddingCache;
  goalEngine: IGoalEngine;
  plannerAgent: PlannerAgent;
  sessionRuntime: SessionRuntime;
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
  pythonEnv: IPythonEnv;
  shellAdapter: IShellAdapter;
  isDryRunEnabled(): boolean;
  getRunOptions(): { previewOnly?: boolean };
  getWriteTargetPath(step: PlanStep): string | undefined;
  loadWorkspaceFileIndex(force?: boolean): Promise<string[]>;
  isDevelopmentMode(): boolean;
  shouldSkipValidationInDev(): boolean;
  diagnosticsBus: EventBus;
}

export function createAgentWorkspaceRuntime(deps: WorkspaceHostDeps): WorkspaceRuntimeResult {
  return createWorkspaceRuntimeServices({
    workspace: {
      telemetry: deps.telemetry,
      telemetryHub: deps.telemetryHub,
      fs: deps.fsAdapter,
      workspace: {
        readFile: (target, encoding) => deps.workspaceService.readFile(target, encoding),
        writeFile: (target, content, encoding) => deps.workspaceService.writeFile(target, content, encoding),
        normalizeRelativePath: (value) => deps.workspaceService.normalizeRelativePath(value),
        isPathInside: (base, target) => deps.workspaceService.isPathInside(base, target)
      },
      planContext: deps.planContext,
      validationUtils: deps.validationUtils,
      validationController: deps.validationController,
      embeddingManager: deps.embeddingManager,
      embeddingCache: deps.embeddingCache,
      goalEngine: deps.goalEngine,
      plannerAgent: deps.plannerAgent,
      loadWorkspaceIndex: (force) => deps.loadWorkspaceIndex(force),
      setContextValue: (key, value) => deps.setContextValue(key, value),
      getContextValue: (key) => deps.getContextValue(key),
      getWorkspaceRoot: () => deps.getWorkspaceRoot(),
      getLastWorkspaceRoot: () => deps.getLastWorkspaceRoot(),
      clampSnippet: (content, limit) => deps.clampSnippet(content, limit),
      conversationMarkerPatterns: deps.conversationMarkerPatterns,
      computeDiff: (before, after, relativePath) => deps.computeDiff(before, after, relativePath),
      resolvePlanRunDirectory: (workspaceRoot) => deps.resolvePlanRunDirectory(workspaceRoot),
      getRunContext: () => deps.getRunContext(),
      getConfiguration: () => deps.getConfiguration(),
      getArtifactPaths: () => deps.getArtifactPaths(),
      searchEmbeddingCandidates: (goal) => deps.searchEmbeddingCandidates(goal),
      runGoalInference: (goal, index) => deps.runGoalInference(goal, index),
      mergeInsightWithEmbeddings: (insight, hits) => deps.mergeInsightWithEmbeddings(insight, hits),
      runTypeCheck: (options) => deps.runTypeCheck(options),
      helperImportExtensions: deps.helperImportExtensions
    },
    write: {
      telemetry: deps.telemetry,
      workspace: {
        readFile: (target, encoding) => deps.workspaceService.readFile(target, encoding),
        writeFile: (target, content, encoding) => deps.workspaceService.writeFile(target, content, encoding),
        normalizeRelativePath: (value) => deps.workspaceService.normalizeRelativePath(value),
        isPathInside: (base, target) => deps.workspaceService.isPathInside(base, target),
        fileExists: (absPath) => deps.workspaceService.fileExists(absPath)
      },
      embeddingManager: deps.embeddingManager,
      getSessionWorkspaceRoot: () => deps.sessionRuntime.getSessionWorkspaceRoot(),
      getCurrentInsight: () => deps.sessionRuntime.getCurrentGoalInsight(),
      getContextValue: (key) => deps.getContextValue(key),
      setContextValue: (key, value) => deps.setContextValue(key, value)
    },
    diagnostics: {
      telemetry: deps.telemetry,
      eventBus: deps.diagnosticsBus,
      pythonEnv: deps.pythonEnv,
      shellAdapter: deps.shellAdapter,
      pathExists: (target) => deps.workspaceService.pathExists(target),
      getWorkspaceRoot: () => deps.getLastWorkspaceRoot() ?? deps.getWorkspaceRoot(),
      isDryRunEnabled: () => deps.isDryRunEnabled(),
      getRunOptions: () => deps.getRunOptions(),
      getWriteTargetPath: (step) => deps.getWriteTargetPath(step),
      normalizeRelativePath: (value) => deps.workspaceService.normalizeRelativePath(value),
      loadWorkspaceFileIndex: (force) => deps.loadWorkspaceFileIndex(force),
      isDevelopmentMode: () => deps.isDevelopmentMode(),
      shouldSkipValidationInDev: () => deps.shouldSkipValidationInDev(),
      validationUtils: deps.validationUtils,
      validationController: deps.validationController
    }
  });
}

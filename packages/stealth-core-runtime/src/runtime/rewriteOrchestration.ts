import type { ProviderKind, ProviderSettings, ChatProvider } from '../internalTypes';
import type {
  IHelperManager,
  IDiffManager,
  ITelemetry,
  RewriteHydrationContext,
  StepOutcome,
  AgentSession,
  TypeScriptValidator,
  AdditionalWrite,
  HelperStepMetadata,
  CallerStepMetadata
} from '../internalTypes';
import type { WorkspaceFileRecord } from '../internalTypes';
import type { InferredGoal } from '../internalTypes';
import type {
  PlanStep,
  ExecutionResult,
  PythonRunCommandAction,
  PythonScanProjectAction,
  PythonReadFileAction,
  PythonWriteFileAction
} from '../internalTypes';
import type { TaskQueue, TaskQueueOptions } from '../internalTypes';
import type { PersistenceManager } from './persistence';
import { createRewriteHydrationManager } from './rewriteHydration';
import { createStepLifecycle } from './stepLifecycle';
import { createRewriteRuntimeServices } from './rewriteRuntime';
import type { EventBus } from '../internalTypes';
import type { TypeCheckRunner } from './typeCheckRunner';

export interface WorkspaceConfiguration {
  get<T>(section: string, defaultValue: T): T;
}

type PythonAction =
  | PythonRunCommandAction
  | PythonScanProjectAction
  | PythonReadFileAction
  | PythonWriteFileAction;

export interface RewriteOrchestrationDeps {
  helperManager: IHelperManager;
  diffManager: IDiffManager;
  telemetry: ITelemetry;
  workspace: {
    normalizeRelativePath(value: string): string | undefined;
    readFile(target: string, encoding?: BufferEncoding): Promise<string>;
  };
  workspaceIndex: {
    getFileRecord(relativePath: string): WorkspaceFileRecord | undefined;
  };
  hydrationCache: Map<string, RewriteHydrationContext>;
  ensureSession(): AgentSession;
  getWorkspaceRoot(): string;
  getContextValue<T>(key: string): T | undefined;
  setContextValue(key: string, value: unknown): void;
  isPreviewOnly(): boolean;
  isDryRunEnabled(): boolean;
  getRunOptions(): { previewOnly?: boolean };
  getCurrentGoalInsight(): InferredGoal | undefined;
  buildExecutionResult(stepId: string, outcome: StepOutcome, startedAt: number): ExecutionResult;
  additionalWriteManager: {
    applyAdditionalWrites(config: {
      workspaceRoot: string;
      writes: AdditionalWrite[];
      encoding: BufferEncoding;
      dryRun: boolean;
      stepId?: string;
    }): Promise<Array<Record<string, unknown>>>;
  };
  pendingInferenceTracker: {
    resolvePendingFiles(): Promise<string[]>;
  };
  typescriptValidator: TypeScriptValidator;
  typeCheckRunner: TypeCheckRunner;
  executePythonStep(action: PythonAction, stepId?: string, step?: PlanStep): Promise<StepOutcome>;
  clampDiffPreview(diff: string, maxLines?: number): string;
  buildContentSample(content: string, maxLines?: number, maxLength?: number): string;
  truncateText(value: string, max?: number): string;
  summarizeDiff(diff: string): { added: number; removed: number };
  stripCodeFences(value: string): string;
  getProjectSummary(): string;
  telemetryHub: {
    emitHelperTelemetry(meta: HelperStepMetadata, outcome: StepOutcome): Promise<void>;
    promptRewriteRefinement(step: PlanStep): Promise<string | undefined>;
  };
  provider: {
    getConfiguration(): WorkspaceConfiguration;
    getProviderKind(configuration: WorkspaceConfiguration): ProviderKind;
    getModel(configuration: WorkspaceConfiguration, provider: ProviderKind): string;
    buildProviderSettings(configuration: WorkspaceConfiguration, apiKey: string): ProviderSettings;
    getTopP(configuration: WorkspaceConfiguration): number | undefined;
    fetchApiKey(): Promise<string | undefined>;
    createProvider(settings: ProviderSettings): Promise<ChatProvider>;
    fetchSecret(key: string): PromiseLike<string | undefined>;
  };
  createTaskQueue(options?: TaskQueueOptions): TaskQueue;
  persistence: PersistenceManager;
  storeAdditionalWrites(outputKey: string, writes: AdditionalWrite[]): void;
  filterAdditionalWrites(raw: unknown, normalize: (value: string) => string | undefined): AdditionalWrite[];
  parseHelperStepMetadata(step?: PlanStep): HelperStepMetadata | undefined;
  parseCallerStepMetadata(step?: PlanStep): CallerStepMetadata | undefined;
  isCancelled(): boolean;
  hydrationLimits: {
    maxEditable: number;
    maxReadonly: number;
    maxSecondaryContext: number;
  };
  fileOpsMarkers: { start: string; end: string };
  eventBus: EventBus;
}

export interface RewriteOrchestrationResult {
  rewriteHydrationManager: ReturnType<typeof createRewriteHydrationManager>;
  stepLifecycle: ReturnType<typeof createStepLifecycle>;
  rewriteGenerator: ReturnType<typeof createRewriteRuntimeServices>['rewriteGenerator'];
  rewriteEngine: ReturnType<typeof createRewriteRuntimeServices>['rewriteEngine'];
  healingEngine: ReturnType<typeof createRewriteRuntimeServices>['healingEngine'];
}

export function createRewriteOrchestration(deps: RewriteOrchestrationDeps): RewriteOrchestrationResult {
  const rewriteHydrationManager = createRewriteHydrationManager(
    {
      normalizeRelativePath: (value) => deps.workspace.normalizeRelativePath(value),
      getWorkspaceFileRecord: (relativePath) => deps.workspaceIndex.getFileRecord(relativePath),
      getWorkspaceRoot: () => deps.getWorkspaceRoot(),
      readWorkspaceFile: (target) => deps.workspace.readFile(target)
    },
    deps.hydrationLimits
  );

  const stepLifecycle = createStepLifecycle({
    helperManager: deps.helperManager,
    rewriteHydrationManager,
    getHydrationCache: (stepId) => deps.hydrationCache.get(stepId),
    setHydrationCache: (stepId, context) => {
      if (!context) {
        deps.hydrationCache.delete(stepId);
      } else {
        deps.hydrationCache.set(stepId, context);
      }
    },
    getContextValue: (key) => deps.getContextValue(key),
    setContextValue: (key, value) => deps.setContextValue(key, value),
    ensureSession: () => {
      deps.ensureSession();
    },
    isPreviewOnly: () => deps.isPreviewOnly(),
    isDryRunEnabled: () => deps.isDryRunEnabled(),
    telemetry: deps.telemetry,
    buildExecutionResult: (stepId, outcome, startedAt) =>
      deps.buildExecutionResult(stepId, outcome, startedAt)
  });

  const rewriteRuntime = createRewriteRuntimeServices({
    rewrite: {
      getConfiguration: () => deps.provider.getConfiguration(),
      getProviderKind: (configuration) => deps.provider.getProviderKind(configuration),
      getModel: (configuration, providerKind) => deps.provider.getModel(configuration, providerKind),
      buildProviderSettings: (configuration, apiKey) => deps.provider.buildProviderSettings(configuration, apiKey),
      getTopP: (configuration) => deps.provider.getTopP(configuration),
      fetchApiKey: () => deps.provider.fetchApiKey(),
      createProvider: (settings) => deps.provider.createProvider(settings),
      diffManager: deps.diffManager,
      rewriteHydrationManager: {
        buildBlocks: (hydration, relativePath) => rewriteHydrationManager.buildBlocks(hydration, relativePath),
        buildContext: (step, relativePath) => rewriteHydrationManager.buildContext(step, relativePath)
      },
      normalizeRelativePath: (value) => deps.workspace.normalizeRelativePath(value),
      isCancelled: () => deps.isCancelled(),
      fileOpsMarkers: deps.fileOpsMarkers,
      ensureSession: () => deps.ensureSession(),
      getHelperMetadata: (step) => deps.parseHelperStepMetadata(step),
      getCallerMetadata: (step) => deps.parseCallerStepMetadata(step),
      helperManager: deps.helperManager,
      hydrationCache: {
        get: (stepId) => deps.hydrationCache.get(stepId),
        set: (stepId, context) => {
          if (!context) {
            deps.hydrationCache.delete(stepId);
          } else {
            deps.hydrationCache.set(stepId, context);
          }
        }
      },
      context: {
        get: (key) => deps.getContextValue(key),
        set: (key, value) => deps.setContextValue(key, value)
      },
      storeAdditionalWrites: (outputKey, writes) => deps.storeAdditionalWrites(outputKey, writes),
      filterAdditionalWrites: (raw, normalize) => deps.filterAdditionalWrites(raw, normalize),
      isDryRunEnabled: () => deps.isDryRunEnabled(),
      isPreviewOnly: () => deps.isPreviewOnly(),
      telemetry: deps.telemetry,
      additionalWriteManager: deps.additionalWriteManager,
      getCurrentGoalInsight: () => deps.getCurrentGoalInsight(),
      typescriptValidator: deps.typescriptValidator,
      resolveRewriteTargetPath: (_step, action, helperMeta) =>
        stepLifecycle.resolveRewriteTargetPath(action, helperMeta)
    },
    healing: {
      telemetry: deps.telemetry,
      diffManager: deps.diffManager,
      helperManager: deps.helperManager,
      pendingInferenceTracker: {
        resolvePendingFiles: () => deps.pendingInferenceTracker.resolvePendingFiles()
      },
      runProjectTypeCheck: (options) => deps.typeCheckRunner.runProjectTypeCheck(options),
      isDryRunEnabled: () => deps.isDryRunEnabled(),
      getRunOptions: () => deps.getRunOptions(),
      ensureSession: () => deps.ensureSession(),
      getContextValue: (key) => deps.getContextValue(key),
      setContextValue: (key, value) => deps.setContextValue(key, value),
      readWorkspaceFile: (target) => deps.workspace.readFile(target),
      executePythonStep: (action, stepId, step) => deps.executePythonStep(action, stepId, step),
      emitHelperTelemetry: (meta, outcome) => deps.telemetryHub.emitHelperTelemetry(meta, outcome),
      getHelperStepMetadata: (step) => deps.parseHelperStepMetadata(step),
      clampDiffPreview: (diff, maxLines) => deps.clampDiffPreview(diff, maxLines),
      buildContentSample: (content, maxLines, maxLength) =>
        deps.buildContentSample(content, maxLines, maxLength),
      truncateText: (value, max) => deps.truncateText(value, max),
      summarizeDiff: (diff) => deps.summarizeDiff(diff),
      stripCodeFences: (value) => deps.stripCodeFences(value),
      getRewriteHint: (pathValue) => deps.typescriptValidator.getRewriteHint(pathValue),
      normalizeRelativePath: (value) => deps.workspace.normalizeRelativePath(value),
      provider: {
        getProviderKind: () => deps.provider.getProviderKind(deps.provider.getConfiguration()),
        getModel: (kind) => deps.provider.getModel(deps.provider.getConfiguration(), kind),
        buildProviderSettings: (apiKey) => deps.provider.buildProviderSettings(deps.provider.getConfiguration(), apiKey),
        getTopP: () => deps.provider.getTopP(deps.provider.getConfiguration()),
        fetchSecret: (key) => deps.provider.fetchSecret(key),
        createProvider: (settings) => deps.provider.createProvider(settings)
      },
      createTaskQueue: (options?: TaskQueueOptions) => deps.createTaskQueue(options),
      persistence: deps.persistence,
      buildExecutionResult: (stepId, outcome, startedAt) =>
        deps.buildExecutionResult(stepId, outcome, startedAt),
      getProjectSummary: () => deps.getProjectSummary(),
      isCancelled: () => deps.isCancelled(),
      eventBus: deps.eventBus
    }
  });

  return {
    rewriteHydrationManager,
    stepLifecycle,
    rewriteGenerator: rewriteRuntime.rewriteGenerator,
    rewriteEngine: rewriteRuntime.rewriteEngine,
    healingEngine: rewriteRuntime.healingEngine
  };
}

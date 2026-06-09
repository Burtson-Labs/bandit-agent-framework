import type {
  IHelperManager,
  IDiffManager,
  ITelemetry,
  RewriteHydrationContext,
  StepOutcome,
  TypeScriptValidator,
  AdditionalWrite,
  ExecutionResult,
  HelperStepMetadata,
  CallerStepMetadata
} from '../types';
import type { TaskQueue, TaskQueueOptions } from '../taskQueue';
import type { EventBus } from '../eventBus';
import type { SessionRuntime } from '../sessionRuntime';
import type {
  PlanStep,
  PythonScanProjectAction,
  PythonReadFileAction,
  PythonWriteFileAction,
  PythonRunCommandAction
} from '../../types';
import type { PersistenceManager } from '../persistence';
import { createRewriteOrchestration, type RewriteOrchestrationResult } from '../rewriteOrchestration';
import type { TypeCheckRunner } from '../typeCheckRunner';
import type { WorkspaceFileRecord } from '../../workspaceIndex';
import type { ProviderHost } from './providerHost';

interface WorkspaceFacade {
  normalizeRelativePath(value: string): string | undefined;
  readFile(target: string, encoding?: BufferEncoding): Promise<string>;
}

interface WorkspaceIndexFacade {
  getFileRecord(relativePath: string): WorkspaceFileRecord | undefined;
}

interface TelemetryHooks {
  emitHelperTelemetry(meta: { helperId?: string; helperPath?: string }, outcome: StepOutcome): Promise<void>;
  promptRewriteRefinement(step: PlanStep): Promise<string | undefined>;
}

export interface RewriteHostDeps {
  helperManager: IHelperManager;
  diffManager: IDiffManager;
  telemetry: ITelemetry;
  workspace: WorkspaceFacade;
  workspaceIndex: WorkspaceIndexFacade;
  hydrationCache: Map<string, RewriteHydrationContext>;
  sessionRuntime: SessionRuntime;
  getWorkspaceRoot(): string;
  getContextValue<T>(key: string): T | undefined;
  setContextValue(key: string, value: unknown): void;
  isDryRunEnabled(): boolean;
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
  executePythonStep(
    action: PythonScanProjectAction | PythonReadFileAction | PythonWriteFileAction | PythonRunCommandAction,
    stepId?: string,
    step?: PlanStep
  ): Promise<StepOutcome>;
  clampDiffPreview(diff: string, maxLines?: number): string;
  buildContentSample(content: string, maxLines?: number, maxLength?: number): string;
  truncateText(value: string, max?: number): string;
  summarizeDiff(diff: string): { added: number; removed: number };
  stripCodeFences(value: string): string;
  getProjectSummary(): string;
  telemetryHub: TelemetryHooks;
  provider: ProviderHost;
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
  diagnosticsBus: EventBus;
}

export function createAgentRewriteOrchestration(deps: RewriteHostDeps): RewriteOrchestrationResult {
  return createRewriteOrchestration({
    helperManager: deps.helperManager,
    diffManager: deps.diffManager,
    telemetry: deps.telemetry,
    workspace: {
      normalizeRelativePath: (value) => deps.workspace.normalizeRelativePath(value),
      readFile: (target, encoding) => deps.workspace.readFile(target, encoding)
    },
    workspaceIndex: {
      getFileRecord: (relativePath) => deps.workspaceIndex.getFileRecord(relativePath)
    },
    hydrationCache: deps.hydrationCache,
    ensureSession: () => deps.sessionRuntime.ensureSession(),
    getWorkspaceRoot: () => deps.getWorkspaceRoot(),
    getContextValue: (key) => deps.getContextValue(key),
    setContextValue: (key, value) => deps.setContextValue(key, value),
    isPreviewOnly: () => deps.sessionRuntime.isPreviewOnly(),
    isDryRunEnabled: () => deps.isDryRunEnabled(),
    getRunOptions: () => deps.sessionRuntime.getRunOptions(),
    getCurrentGoalInsight: () => deps.sessionRuntime.getCurrentGoalInsight(),
    buildExecutionResult: (stepId, outcome, startedAt) => deps.buildExecutionResult(stepId, outcome, startedAt),
    additionalWriteManager: deps.additionalWriteManager,
    pendingInferenceTracker: deps.pendingInferenceTracker,
    typescriptValidator: deps.typescriptValidator,
    typeCheckRunner: deps.typeCheckRunner,
    executePythonStep: (action, stepId, step) => deps.executePythonStep(action, stepId, step),
    clampDiffPreview: (diff, maxLines) => deps.clampDiffPreview(diff, maxLines),
    buildContentSample: (content, maxLines, maxLength) =>
      deps.buildContentSample(content, maxLines, maxLength),
    truncateText: (value, max) => deps.truncateText(value, max),
    summarizeDiff: (diff) => deps.summarizeDiff(diff),
    stripCodeFences: (value) => deps.stripCodeFences(value),
    getProjectSummary: () => deps.getProjectSummary(),
    telemetryHub: {
      emitHelperTelemetry: (meta, outcome) =>
        deps.telemetryHub.emitHelperTelemetry(
          { helperId: meta.helperId, helperPath: meta.helperPath },
          outcome
        ),
      promptRewriteRefinement: (step) => deps.telemetryHub.promptRewriteRefinement(step)
    },
    provider: {
      getConfiguration: () => deps.provider.getConfiguration(),
      getProviderKind: (configuration) => deps.provider.getProviderKind(configuration),
      getModel: (configuration, provider) => deps.provider.getModel(configuration, provider),
      buildProviderSettings: (configuration, apiKey) =>
        deps.provider.buildProviderSettings(configuration, apiKey),
      getTopP: (configuration) => deps.provider.getTopP(configuration),
      fetchApiKey: () => deps.provider.fetchApiKey(),
      createProvider: (settings) => deps.provider.createProvider(settings),
      fetchSecret: (key) => deps.provider.fetchSecret(key)
    },
    createTaskQueue: (options) => deps.createTaskQueue(options),
    persistence: deps.persistence,
    storeAdditionalWrites: (outputKey, writes) =>
      deps.storeAdditionalWrites(outputKey, writes),
    filterAdditionalWrites: (raw, normalize) => deps.filterAdditionalWrites(raw, normalize),
    parseHelperStepMetadata: (step) => deps.parseHelperStepMetadata(step),
    parseCallerStepMetadata: (step) => deps.parseCallerStepMetadata(step),
    isCancelled: () => deps.isCancelled(),
    hydrationLimits: deps.hydrationLimits,
    fileOpsMarkers: deps.fileOpsMarkers,
    eventBus: deps.diagnosticsBus
  });
}

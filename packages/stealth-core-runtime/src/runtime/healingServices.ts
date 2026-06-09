import type { ExecutionResult, PlanStep, PythonWriteFileAction } from '../internalTypes';
import type { ProviderKind, ProviderSettings, ChatProvider } from '../internalTypes';
import type { TaskQueue, TaskQueueOptions } from '../internalTypes';
import type { PersistenceManager } from './persistence';
import type {
  HelperStepMetadata,
  IHelperManager,
  IDiffManager,
  ITelemetry,
  StepOutcome
} from '../internalTypes';
import type { EventBus } from '../internalTypes';
import { createHealingEngine } from './healingEngine';
import type { TypeCheckRunner } from './typeCheckRunner';

export interface HealingServicesDeps {
  telemetry: ITelemetry;
  diffManager: IDiffManager;
  helperManager: IHelperManager;
  eventBus: EventBus;
  rewriteEngine: {
    createMissingHelperFiles(goal: string, files: string[]): Promise<string[]>;
  };
  pendingInferenceTracker: {
    resolvePendingFiles(): Promise<string[]>;
  };
  runProjectTypeCheck: TypeCheckRunner['runProjectTypeCheck'];
  isDryRunEnabled(): boolean;
  getRunOptions(): { previewOnly?: boolean };
  ensureSession(): { workspaceRoot: string; goal: string };
  getContextValue<T>(key: string): T | undefined;
  setContextValue(key: string, value: unknown): void;
  readWorkspaceFile(path: string): Promise<string>;
  generateRewrite(
    goal: string,
    relativePath: string,
    currentContent: string,
    projectSummary: string,
    instructions?: string
  ): Promise<StepOutcome>;
  executePythonStep(
    action: PythonWriteFileAction,
    stepId?: string,
    step?: PlanStep
  ): Promise<StepOutcome>;
  emitHelperTelemetry(meta: HelperStepMetadata, outcome: StepOutcome): Promise<void>;
  getHelperStepMetadata(step?: PlanStep): HelperStepMetadata | undefined;
  clampDiffPreview(diff: string, maxLines?: number): string;
  buildContentSample(content: string, maxLines?: number, maxLength?: number): string;
  truncateText(value: string, max?: number): string;
  summarizeDiff(diff: string): { added: number; removed: number };
  stripCodeFences(content: string): string;
  getRewriteHint(relativePath: string): string | undefined;
  normalizeRelativePath(value: string): string | undefined;
  provider: {
    getProviderKind(): ProviderKind;
    getModel(kind: ProviderKind): string;
    buildProviderSettings(apiKey: string): ProviderSettings;
    getTopP(): number | undefined;
    fetchSecret(key: string): PromiseLike<string | undefined>;
    createProvider(settings: ProviderSettings): Promise<ChatProvider>;
  };
  createTaskQueue(options?: TaskQueueOptions): TaskQueue;
  persistence: PersistenceManager;
  buildExecutionResult(stepId: string, outcome: StepOutcome, startedAt: number): ExecutionResult;
  getProjectSummary(): string;
  isCancelled(): boolean;
}

export function createHealingServices(deps: HealingServicesDeps) {
  const healingEngine = createHealingEngine({
    telemetry: deps.telemetry,
    diffManager: deps.diffManager,
    helperManager: deps.helperManager,
    rewriteEngine: deps.rewriteEngine,
    pendingInferenceTracker: deps.pendingInferenceTracker,
    runProjectTypeCheck: (options) => deps.runProjectTypeCheck(options),
    isDryRun: () => deps.isDryRunEnabled(),
    getRunOptions: () => deps.getRunOptions(),
    ensureSession: () => deps.ensureSession(),
    getContextValue: (key) => deps.getContextValue(key),
    setContextValue: (key, value) => deps.setContextValue(key, value),
    readWorkspaceFile: (path) => deps.readWorkspaceFile(path),
    generateRewrite: (goal, relativePath, currentContent, projectSummary, instructions) =>
      deps.generateRewrite(goal, relativePath, currentContent, projectSummary, instructions),
    executePythonStep: (action, stepId, step) => deps.executePythonStep(action, stepId, step),
    emitHelperTelemetry: (meta, outcome) => deps.emitHelperTelemetry(meta, outcome),
    getHelperStepMetadata: (step) => deps.getHelperStepMetadata(step),
    clampDiffPreview: (diff, maxLines) => deps.clampDiffPreview(diff, maxLines),
    buildContentSample: (content, maxLines, maxLength) => deps.buildContentSample(content, maxLines, maxLength),
    truncateText: (value, max) => deps.truncateText(value, max),
    summarizeDiff: (diff) => deps.summarizeDiff(diff),
    stripCodeFences: (content) => deps.stripCodeFences(content),
    getRewriteHint: (path) => deps.getRewriteHint(path),
    normalizeRelativePath: (value) => deps.normalizeRelativePath(value),
    eventBus: deps.eventBus,
    getProviderKind: () => deps.provider.getProviderKind(),
    getModel: (kind) => deps.provider.getModel(kind),
    buildProviderSettings: (apiKey) => deps.provider.buildProviderSettings(apiKey),
    getTopP: () => deps.provider.getTopP(),
    fetchSecret: (key) => deps.provider.fetchSecret(key),
    createProvider: (settings) => deps.provider.createProvider(settings),
    createTaskQueue: (options) => deps.createTaskQueue(options),
    persistence: deps.persistence,
    buildExecutionResult: (stepId, outcome, startedAt) => deps.buildExecutionResult(stepId, outcome, startedAt),
    getProjectSummary: () => deps.getProjectSummary(),
    isCancelled: () => deps.isCancelled()
  });

  return { healingEngine };
}

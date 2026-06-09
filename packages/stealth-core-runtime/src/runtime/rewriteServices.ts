import type { ProviderKind, ProviderSettings, ChatProvider } from '../internalTypes';
import type { PlanStep, LlmRewriteAction } from '../internalTypes';
import type { InferredGoal } from '../internalTypes';
import { createRewriteGenerator } from './rewriteGenerator';
import { createRewriteEngine } from './rewriteEngine';
import type {
  AdditionalWrite,
  HelperStepMetadata,
  CallerStepMetadata,
  IDiffManager,
  IHelperManager,
  ITelemetry,
  RewriteHydrationContext,
  TypeScriptValidator
} from '../internalTypes';

interface Configuration {
  get<T>(section: string, defaultValue: T): T;
}

export interface RewriteServicesDeps {
  getConfiguration(): Configuration;
  getProviderKind(configuration: Configuration): ProviderKind;
  getModel(configuration: Configuration, provider: ProviderKind): string;
  buildProviderSettings(configuration: Configuration, apiKey: string): ProviderSettings;
  getTopP(configuration: Configuration): number | undefined;
  fetchApiKey(): Promise<string | undefined>;
  createProvider(settings: ProviderSettings): Promise<ChatProvider>;
  diffManager: Pick<IDiffManager, 'isReviewModeEnabled' | 'postDiffStream'>;
  rewriteHydrationManager: {
    buildBlocks(hydration: RewriteHydrationContext | undefined, relativePath: string): string[];
    buildContext(step: PlanStep, relativePath: string): Promise<RewriteHydrationContext | undefined>;
  };
  normalizeRelativePath(value: string): string | undefined;
  isCancelled(): boolean;
  fileOpsMarkers: { start: string; end: string };
  ensureSession(): { workspaceRoot: string };
  getHelperMetadata(step: PlanStep): HelperStepMetadata | undefined;
  getCallerMetadata(step: PlanStep): CallerStepMetadata | undefined;
  helperManager: IHelperManager;
  hydrationCache: {
    get(stepId: string): RewriteHydrationContext | undefined;
    set(stepId: string, context: RewriteHydrationContext | undefined): void;
  };
  context: {
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
  };
  storeAdditionalWrites(outputKey: string, writes: AdditionalWrite[]): void;
  filterAdditionalWrites(raw: unknown, normalize: (value: string) => string | undefined): AdditionalWrite[];
  isDryRunEnabled(): boolean;
  isPreviewOnly(): boolean;
  telemetry: ITelemetry;
  additionalWriteManager: {
    applyAdditionalWrites(config: {
      workspaceRoot: string;
      writes: AdditionalWrite[];
      encoding: BufferEncoding;
      dryRun: boolean;
      stepId: string;
    }): Promise<Array<Record<string, unknown>>>;
  };
  getCurrentGoalInsight(): InferredGoal | undefined;
  typescriptValidator: TypeScriptValidator;
  resolveRewriteTargetPath(
    step: PlanStep,
    action: LlmRewriteAction,
    helperMeta?: HelperStepMetadata
  ): string | undefined;
}

export function createRewriteServices(deps: RewriteServicesDeps) {
  const rewriteGenerator = createRewriteGenerator({
    getConfiguration: () => deps.getConfiguration(),
    getProviderKind: (configuration) => deps.getProviderKind(configuration),
    getModel: (configuration, provider) => deps.getModel(configuration, provider),
    buildProviderSettings: (configuration, apiKey) => deps.buildProviderSettings(configuration, apiKey),
    getTopP: (configuration) => deps.getTopP(configuration),
    fetchApiKey: () => deps.fetchApiKey(),
    createProvider: (settings) => deps.createProvider(settings),
    diffManager: {
      isReviewModeEnabled: () => deps.diffManager.isReviewModeEnabled(),
      postDiffStream: (update) => deps.diffManager.postDiffStream(update)
    },
    buildHydrationBlocks: (hydration, relativePath) => deps.rewriteHydrationManager.buildBlocks(hydration, relativePath),
    normalizeRelativePath: (value) => deps.normalizeRelativePath(value),
    isCancelled: () => deps.isCancelled(),
    fileOpsMarkers: deps.fileOpsMarkers
  });

  const rewriteEngine = createRewriteEngine({
    ensureSession: () => deps.ensureSession(),
    getHelperStepMetadata: (step) => deps.getHelperMetadata(step),
    getCallerStepMetadata: (step) => deps.getCallerMetadata(step),
    helperManager: deps.helperManager,
    rewriteHydrationManager: {
      buildContext: (step, relativePath) => deps.rewriteHydrationManager.buildContext(step, relativePath)
    },
    getHydrationCache: (stepId) => deps.hydrationCache.get(stepId),
    setHydrationCache: (stepId, context) => deps.hydrationCache.set(stepId, context),
    generateRewrite: (goal, relativePath, currentContent, projectSummary, instructions, hydration) =>
      rewriteGenerator.generateRewrite(goal, relativePath, currentContent, projectSummary, instructions, hydration),
    setContextValue: (key, value) => deps.context.set(key, value),
    getContextValue: (key) => deps.context.get(key),
    storeAdditionalWrites: (outputKey, writes) => deps.storeAdditionalWrites(outputKey, writes),
    normalizeRelativePath: (value) => deps.normalizeRelativePath(value),
    filterAdditionalWrites: (raw, normalize) => deps.filterAdditionalWrites(raw, normalize),
    isDryRunEnabled: () => deps.isDryRunEnabled(),
    isPreviewOnly: () => deps.isPreviewOnly(),
    telemetry: deps.telemetry,
    additionalWriteManager: deps.additionalWriteManager,
    getCurrentGoalInsight: () => deps.getCurrentGoalInsight(),
    typescriptValidator: deps.typescriptValidator,
    resolveTargetPath: (step, action, helperMeta) => deps.resolveRewriteTargetPath(step, action, helperMeta)
  });

  return { rewriteGenerator, rewriteEngine };
}

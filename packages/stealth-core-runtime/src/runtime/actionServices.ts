import type {
  PlanStep,
  PythonRunCommandAction,
  PythonWriteFileAction,
  InternalReviewDiffAction
} from '../internalTypes';
import type {
  HelperStepMetadata,
  AdditionalWrite,
  ITelemetry,
  IDiffManager,
  IUndoManager,
  PythonResponse,
  StepOutcome
} from '../internalTypes';
import { createInternalActionExecutor } from './internalActions';
import { createPythonActionExecutor } from './pythonActions';

export interface ActionServicesHost {
  ensureSession(): { workspaceRoot: string };
  getContextValue<T>(key: string): T | undefined;
  setContextValue(key: string, value: unknown): void;
  normalizeRelativePath(value: string): string | undefined;
  parseHelperStepMetadata(step: PlanStep | undefined): HelperStepMetadata | undefined;
  resolveRootParam(ref?: string): string;
  isDryRunEnabled(): boolean;
  isPreviewOnly(): boolean;
  telemetry: ITelemetry;
  embeddingCache: {
    indexFiles(workspaceRoot: string, files: string[]): Promise<{ reused: number; computed: number }>;
  };
  embeddingManager: {
    scheduleEmbeddingUpsert(relativePath: string, content: string): void;
  };
  postEmbeddingStatus(stats: { reused: number; computed: number }, total: number): Promise<void>;
  captureExtractionSection(content: string): void;
  extractRelevantSection(content: string, patterns?: string[]): string;
  clampSnippet(content: string, limit?: number): string;
  buildProjectSummary(data: Record<string, unknown> | undefined): string;
  describeScanResponse(data: Record<string, unknown> | undefined): string | undefined;
  buildContentSample(content: string, maxLines?: number, maxLength?: number): string;
  applyIncrementalEdits(
    original: string,
    content: string,
    relativePath: string
  ): { content: string; replaced: number; total: number; confidence: number };
  applyImportHints(meta: HelperStepMetadata | undefined, content: string): string;
  diffManager: Pick<IDiffManager, 'registerPendingDiff'>;
  additionalWriteManager: {
    applyAdditionalWrites(config: {
      workspaceRoot: string;
      writes: AdditionalWrite[];
      encoding: BufferEncoding;
      dryRun: boolean;
      stepId?: string;
    }): Promise<Array<Record<string, unknown>>>;
  };
  undoManager: IUndoManager;
  recordWriteContext(paths: (string | undefined)[], helperStep: boolean): void;
  clearPendingWriteContext(): void;
  pendingInferenceTracker: {
    flagMissingFiles(relativePath: string, writes: AdditionalWrite[]): Promise<void>;
  };
  filterAdditionalWrites(raw: unknown, normalize: (value: string) => string | undefined): AdditionalWrite[];
  resolveAdditionalWritesRef(action: PythonWriteFileAction): string | undefined;
  runPython(action: string, payload: unknown): Promise<PythonResponse>;
  runPythonStep(action: PythonRunCommandAction, stepId?: string, step?: PlanStep): Promise<StepOutcome>;
  reviewDiff(action: InternalReviewDiffAction, step?: PlanStep): Promise<StepOutcome>;
  isCancelled(): boolean;
}

export function createActionServices(host: ActionServicesHost) {
  const internalActions = createInternalActionExecutor({
    getContextValue: (key) => host.getContextValue(key),
    setContextValue: (key, value) => host.setContextValue(key, value),
    normalizeRelativePath: (value) => host.normalizeRelativePath(value),
    runPythonStep: (action, stepId, step) => host.runPythonStep(action, stepId, step),
    isCancelled: () => host.isCancelled(),
    reviewDiff: (action, step) => host.reviewDiff(action, step),
    extractRelevantSection: (content, patterns) => host.extractRelevantSection(content, patterns),
    clampSnippet: (content, limit) => host.clampSnippet(content, limit)
  });

  const pythonActions = createPythonActionExecutor({
    ensureSession: () => host.ensureSession(),
    getContextValue: (key) => host.getContextValue(key),
    setContextValue: (key, value) => host.setContextValue(key, value),
    normalizeRelativePath: (value) => host.normalizeRelativePath(value),
    getHelperStepMetadata: (step) => host.parseHelperStepMetadata(step),
    resolveRootParam: (ref) => host.resolveRootParam(ref),
    isDryRunEnabled: () => host.isDryRunEnabled(),
    isPreviewOnly: () => host.isPreviewOnly(),
    telemetry: {
      status: (payload) => host.telemetry.status(payload),
      log: (payload) => host.telemetry.log(payload)
    },
    embeddingCache: host.embeddingCache,
    embeddingManager: host.embeddingManager,
    postEmbeddingStatus: (stats, total) => host.postEmbeddingStatus(stats, total),
    captureExtractionSection: (content) => host.captureExtractionSection(content),
    buildProjectSummary: (data) => host.buildProjectSummary(data),
    describeScanResponse: (data) => host.describeScanResponse(data),
    buildContentSample: (content, maxLines, maxLength) => host.buildContentSample(content, maxLines, maxLength),
    applyIncrementalEdits: (original, content, relativePath) =>
      host.applyIncrementalEdits(original, content, relativePath),
    helperManager: {
      applyImportHints: (meta, content) => host.applyImportHints(meta, content)
    },
    diffManager: host.diffManager,
    additionalWriteManager: host.additionalWriteManager,
    undoManager: host.undoManager,
    recordWriteContext: (paths, helperStep) => host.recordWriteContext(paths, helperStep),
    clearPendingWriteContext: () => host.clearPendingWriteContext(),
    pendingInferenceTracker: host.pendingInferenceTracker,
    filterAdditionalWrites: (raw, normalize) => host.filterAdditionalWrites(raw, normalize),
    resolveAdditionalWritesRef: (action) => host.resolveAdditionalWritesRef(action),
    runPython: (name, payload) => host.runPython(name, payload)
  });

  return { internalActions, pythonActions };
}

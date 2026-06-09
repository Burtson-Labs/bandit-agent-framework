import { createActionRuntimeServices, type ActionRuntimeResult } from '../actionRuntime';
import type {
  ITelemetry,
  IDiffManager,
  IUndoManager,
  AdditionalWrite,
  TypeScriptValidator,
  StepOutcome,
  PythonResponse
} from '../types';
import type { SessionRuntime } from '../sessionRuntime';
import type {
  PlanStep,
  PythonRunCommandAction,
  PythonScanProjectAction,
  PythonReadFileAction,
  PythonWriteFileAction,
  InternalReviewDiffAction
} from '../../types';
import type { WorkspacePackageManager } from '../workspacePackages';
import type { ActionServicesHost } from '../actionServices';

interface WorkspaceFacade {
  readFile(target: string, encoding?: BufferEncoding): Promise<string>;
  writeFile(target: string, content: string, encoding?: BufferEncoding): Promise<void>;
  normalizeRelativePath(value: string): string | undefined;
}

interface EmbeddingCacheFacade {
  indexFiles(workspaceRoot: string, files: string[]): Promise<{ reused: number; computed: number }>;
}

interface EmbeddingManagerFacade {
  scheduleEmbeddingUpsert(relativePath: string, content: string): void;
}

interface TelemetryHubFacade {
  postEmbeddingStatus(input: { stats: { reused: number; computed: number }; totalTracked: number }): Promise<void>;
}

interface DiagnosticsFacade {
  recordWriteContext(paths: (string | undefined)[], helperStep: boolean): void;
  clearPendingWriteContext(): void;
}

interface PendingInferenceFacade {
  flagMissingFiles(relativePath: string, writes: AdditionalWrite[]): Promise<void>;
}

export interface ActionHostDeps {
  sessionRuntime: SessionRuntime;
  telemetry: ITelemetry;
  workspace: WorkspaceFacade;
  helperManager: { applyImportHints(meta: Parameters<ActionServicesHost['applyImportHints']>[0], content: string): string };
  embeddingCache: EmbeddingCacheFacade;
  embeddingManager: EmbeddingManagerFacade;
  telemetryHub: TelemetryHubFacade;
  extraction: {
    captureExtractionSection(content: string): void;
    extractRelevantSection(content: string, patterns?: string[]): string;
    clampSnippet(content: string, limit?: number): string;
  };
  diffManager: IDiffManager;
  additionalWriteManager: ActionServicesHost['additionalWriteManager'];
  undoManager: IUndoManager;
  diagnostics: DiagnosticsFacade;
  pendingInferenceTracker: PendingInferenceFacade;
  filterAdditionalWrites(raw: unknown, normalize: (value: string) => string | undefined): AdditionalWrite[];
  resolveAdditionalWritesRef(action: PythonWriteFileAction): string | undefined;
  runPython(name: string, payload: unknown): Promise<PythonResponse>;
  executePythonStep(
    action: PythonScanProjectAction | PythonReadFileAction | PythonWriteFileAction | PythonRunCommandAction,
    stepId?: string,
    step?: PlanStep
  ): Promise<StepOutcome>;
  reviewDiff(action: InternalReviewDiffAction, step?: PlanStep): Promise<StepOutcome>;
  buildProjectSummary(data: Record<string, unknown> | undefined): string;
  describeScanResponse(data: Record<string, unknown> | undefined): string | undefined;
  buildContentSample(content: string, maxLines?: number, maxLength?: number): string;
  applyIncrementalEdits(
    original: string,
    content: string,
    relativePath: string
  ): { content: string; replaced: number; total: number; confidence: number };
  isDryRunEnabled(): boolean;
  getWorkspaceRoot(): string;
  getProjectSummary(): string;
  resolveRootParam(ref?: string): string;
  parseHelperMetadata(step?: PlanStep): ReturnType<ActionServicesHost['parseHelperStepMetadata']>;
  typescriptValidator: TypeScriptValidator;
  workspacePackageManager: WorkspacePackageManager;
  generateRewrite(
    goal: string,
    relativePath: string,
    currentContent: string,
    projectSummary: string,
    instructions: string
  ): Promise<StepOutcome>;
}

export function createAgentActionRuntime(deps: ActionHostDeps): ActionRuntimeResult {
  return createActionRuntimeServices({
    actionHost: {
      ensureSession: () => deps.sessionRuntime.ensureSession(),
      getContextValue: (key) => deps.sessionRuntime.getContextValue(key),
      setContextValue: (key, value) => deps.sessionRuntime.setContextValue(key, value),
      normalizeRelativePath: (value) => deps.workspace.normalizeRelativePath(value),
      parseHelperStepMetadata: (step) => deps.parseHelperMetadata(step),
      resolveRootParam: (ref) => deps.resolveRootParam(ref),
      isDryRunEnabled: () => deps.isDryRunEnabled(),
      isPreviewOnly: () => deps.sessionRuntime.isPreviewOnly(),
      telemetry: deps.telemetry,
      embeddingCache: deps.embeddingCache,
      embeddingManager: deps.embeddingManager,
      postEmbeddingStatus: (stats, total) =>
        deps.telemetryHub.postEmbeddingStatus({ stats, totalTracked: total }),
      captureExtractionSection: (content) => deps.extraction.captureExtractionSection(content),
      extractRelevantSection: (content, patterns) => deps.extraction.extractRelevantSection(content, patterns),
      clampSnippet: (content, limit) => deps.extraction.clampSnippet(content, limit),
      buildProjectSummary: (data) => deps.buildProjectSummary(data),
      describeScanResponse: (data) => deps.describeScanResponse(data),
      buildContentSample: (content, maxLines, maxLength) =>
        deps.buildContentSample(content, maxLines, maxLength),
      applyIncrementalEdits: (original, content, relativePath) =>
        deps.applyIncrementalEdits(original, content, relativePath),
      applyImportHints: (meta, content) => deps.helperManager.applyImportHints(meta, content),
      diffManager: { registerPendingDiff: (pathValue, original, updated, confidence) =>
        deps.diffManager.registerPendingDiff(pathValue, original, updated, confidence)
      },
      additionalWriteManager: deps.additionalWriteManager,
      undoManager: deps.undoManager,
      recordWriteContext: (paths, helperStep) => deps.diagnostics.recordWriteContext(paths, helperStep),
      clearPendingWriteContext: () => deps.diagnostics.clearPendingWriteContext(),
      pendingInferenceTracker: deps.pendingInferenceTracker,
      filterAdditionalWrites: (raw, normalize) => deps.filterAdditionalWrites(raw, normalize),
      resolveAdditionalWritesRef: (action) => deps.resolveAdditionalWritesRef(action),
      runPython: (name, payload) => deps.runPython(name, payload),
      runPythonStep: (action, stepId, step) => deps.executePythonStep(action, stepId, step),
      reviewDiff: (action, step) => deps.reviewDiff(action, step),
      isCancelled: () => deps.sessionRuntime.isCancelled()
    },
    autoHealer: {
      telemetry: deps.telemetry,
      diffManager: deps.diffManager,
      typescriptValidator: deps.typescriptValidator,
      workspacePackageManager: deps.workspacePackageManager,
      ensureSession: () => deps.sessionRuntime.ensureSession(),
      readWorkspaceFile: (target, encoding) => deps.workspace.readFile(target, encoding),
      writeWorkspaceFile: (target, content, encoding) => deps.workspace.writeFile(target, content, encoding),
      normalizeRelativePath: (value) => deps.workspace.normalizeRelativePath(value),
      getProjectSummary: () => deps.getProjectSummary(),
      generateRewrite: (goal, relativePath, currentContent, projectSummary, instructions) =>
        deps.generateRewrite(goal, relativePath, currentContent, projectSummary, instructions),
      isDryRunEnabled: () => deps.isDryRunEnabled(),
      isPreviewOnly: () => deps.sessionRuntime.isPreviewOnly(),
      scheduleEmbeddingUpsert: (relativePath, content) =>
        deps.embeddingManager.scheduleEmbeddingUpsert(relativePath, content),
      undoManager: deps.undoManager,
      getWorkspaceRoot: () => deps.getWorkspaceRoot()
    }
  });
}

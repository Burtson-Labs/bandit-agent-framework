import type { StealthHostBindings, ITelemetry } from '../hostTypes';
import type { StealthRuntime } from './stealthRuntimeTypes';
import { EmbeddingCache } from '../embeddingCache';
import { createEventBus } from './eventBus';
import { createGoalEngine } from './goalEngine';
import { createSessionRuntime } from './sessionRuntime';
import { createBaseServices } from './hosts/baseServices';
import { createPythonBridge } from './pythonBridge';
import { createEmbeddingServices } from './hosts/embeddingServices';
import { createAgentWorkspaceRuntime } from './hosts/workspaceHost';
import { createAgentRewriteOrchestration } from './hosts/rewriteHost';
import { createAgentActionRuntime } from './hosts/actionHost';
import { createProviderHost } from './hosts/providerHost';
import { createGoalFlowHost } from './hosts/goalFlowHost';
import { createExecutorServices } from './executorServices';
import { createValidationUtils } from './validationUtils';
import { createValidationController } from './validationController';
import { createTypeCheckRunner } from './typeCheckRunner';
import { assertWritableWorkspace } from './workspaceAssertions';
import {
  clampDiffPreview,
  summarizeDiff,
  buildContentSample,
  truncateText
} from './diffPresenter';
import {
  estimateTokensFromResult,
  getWriteTargetPath,
  resolveAdditionalWritesRef,
  storeAdditionalWrites,
  buildExecutionResult
} from './runtimeHelpers';
import { filterAdditionalWrites } from './rewritePayload';
import { parseHelperStepMetadata, parseCallerStepMetadata } from './stepMetadata';
import { createTaskQueue } from './taskQueue';
import { buildProjectSummary, describeScanResponse } from './projectSummary';
import { CONVERSATION_MARKER_REGEXES, stripCodeFences } from './textSanitizer';
import { feedbackService, AWAITING_GUIDANCE_PREFIX } from './feedbackService';
import type {
  Plan,
  PlanStep,
  PythonScanProjectAction,
  PythonReadFileAction,
  PythonWriteFileAction,
  PythonRunCommandAction
} from '../types';
import type { AgentGoalOptions, StepOutcome } from './types';

const API_KEY_SECRET_KEY = 'banditStealth.apiKey';
const MAX_SECONDARY_REWRITE_CONTEXT = 8000;
const MAX_HYDRATED_EDIT_FILES = 3;
const MAX_HYDRATED_READONLY_FILES = 4;
const HELPER_IMPORT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'];

export function createStealthRuntime(host: StealthHostBindings): StealthRuntime {
  const embeddingCache = new EmbeddingCache();
  const diagnosticsBus = createEventBus();
  // eslint-disable-next-line prefer-const
  let workspaceIndexService: ReturnType<typeof createAgentWorkspaceRuntime>['workspaceIndex'] | undefined;
  // eslint-disable-next-line prefer-const
  let workspaceIndexerService: ReturnType<typeof createAgentWorkspaceRuntime>['workspaceIndexer'] | undefined;
  // eslint-disable-next-line prefer-const
  let pythonActionsRef: ReturnType<typeof createAgentActionRuntime>['pythonActions'] | undefined;
  const runPythonStep = (
    action: PythonScanProjectAction | PythonReadFileAction | PythonWriteFileAction | PythonRunCommandAction,
    stepId?: string,
    step?: PlanStep
  ): Promise<StepOutcome> => {
    if (!pythonActionsRef) {
      return Promise.reject(new Error('Python runtime not initialised.'));
    }
    return pythonActionsRef.execute(action, stepId, step);
  };

  const getWorkspaceRoot = () => host.workspace.getInitialWorkspaceRoot();

  // eslint-disable-next-line prefer-const
  let workspaceRuntime: ReturnType<typeof createAgentWorkspaceRuntime> | undefined;
  // eslint-disable-next-line prefer-const
  let executorRuntime: ReturnType<typeof createExecutorServices> | undefined;

  const sessionRuntime = createSessionRuntime({
    getWorkspaceRoot,
    getPlanPreparer: () => workspaceRuntime?.planPreparer,
    getGoalRunner: () => executorRuntime?.goalRunner,
    getAgentConfiguration: () => getAgentConfiguration(host)
  });

  const baseServices = createBaseServices({
    environment: {
      postMessage: (message) => runMaybePromise(host.env.postMessage?.(message))
    },
    getWorkspaceRoot: () => sessionRuntime.getLastWorkspaceRoot() ?? getWorkspaceRoot(),
    setContextValue: (key, value) => sessionRuntime.setContextValue(key, value),
    getContextValue: (key) => sessionRuntime.getContextValue(key),
    getSessionGoal: () => sessionRuntime.getSessionGoal(),
    python: {
      ensure: () => host.python.ensure(),
      clearCache: () => host.python.clearCache()
    },
    fsAdapter: host.fs,
    shellAdapter: host.shell,
    onPythonDetected: (info) => {
      void host.telemetry.log({
        level: 'info',
        message: `Using ${info.command} (Python ${info.version})`
      });
    },
    onPythonError: (message) => {
      void host.telemetry.log({ level: 'error', message });
    }
  });

  const telemetry = baseServices.telemetry;
  const telemetryHub = baseServices.telemetryHub;
  const planContext = baseServices.planContext;
  const fsAdapter = baseServices.fsAdapter;
  const workspaceService = baseServices.workspace;
  const extraction = baseServices.extraction;
  const persistence = baseServices.persistence;
  const shellAdapter = baseServices.shellAdapter;
  const pythonEnv = baseServices.pythonEnv;

  const validationUtils = createValidationUtils({
    shellAdapter,
    pathExists: (target) => workspaceService.pathExists(target),
    getWorkspaceRoot: () => sessionRuntime.getLastWorkspaceRoot() ?? getWorkspaceRoot()
  });

  const validationController = createValidationController({
    isDevelopmentMode: () => host.flags.isDevelopmentMode(),
    getSkipValidationSetting: () => host.flags.shouldSkipValidationInDev(),
    throttleMs: 4000
  });

  const pythonBridge = createPythonBridge({
    pythonEnv,
    shellAdapter,
    getScriptPath: () => host.python.scriptPath,
    getWorkingDirectory: () => host.python.getWorkingDirectory(),
    onMissingPython: (detail) => notifyMissingPython(host, telemetry, detail)
  });

  const embeddingServices = createEmbeddingServices({
    telemetryHub,
    workspace: {
      normalizeRelativePath: (value) => workspaceService.normalizeRelativePath(value)
    },
    setContextValue: (key, value) => sessionRuntime.setContextValue(key, value),
    getConfiguration: () => createConfigurationAdapter(host),
    getWorkspaceRoot: () => sessionRuntime.getLastWorkspaceRoot() ?? getWorkspaceRoot(),
    fetchApiKey: () => host.secrets.get(API_KEY_SECRET_KEY)
  });

  const embeddingManager = embeddingServices.embeddingManager;
  const connectorBus = embeddingServices.connectorBus;

  const goalEngine = createGoalEngine({
    getWorkspaceIndexer: () => workspaceIndexerService
  });

  workspaceRuntime = createAgentWorkspaceRuntime({
    telemetry,
    telemetryHub: {
      postDiffSnapshot: (entry) => telemetryHub.postDiffSnapshot(entry),
      postDiffStream: (update) => telemetryHub.postDiffStream(update),
      postWorkspaceIndexStatus: (snapshot) => telemetryHub.postWorkspaceIndexStatus(snapshot),
      postPlan: (plan) => telemetryHub.postPlan(plan),
      emitGoal: (goal, insight) => telemetryHub.emitGoalInference(goal, insight),
      emitTask: (progress) => telemetryHub.emitTaskProgress(progress)
    },
    fsAdapter,
    workspaceService: {
      readFile: (target, encoding) => workspaceService.readFile(target, encoding),
      writeFile: (target, content, encoding) => workspaceService.writeFile(target, content, encoding),
      normalizeRelativePath: (value) => workspaceService.normalizeRelativePath(value),
      isPathInside: (base, target) => workspaceService.isPathInside(base, target),
      fileExists: (target) => workspaceService.fileExists(target),
      pathExists: (target) => workspaceService.pathExists(target)
    },
    planContext,
    validationUtils,
    validationController,
    embeddingManager,
    embeddingCache,
    goalEngine,
    plannerAgent: host.planner,
    sessionRuntime,
    loadWorkspaceIndex: (force?: boolean) => workspaceIndexService?.load(force) ?? Promise.resolve([]),
    setContextValue: (key, value) => sessionRuntime.setContextValue(key, value),
    getContextValue: (key) => sessionRuntime.getContextValue(key),
    getWorkspaceRoot,
    getLastWorkspaceRoot: () => sessionRuntime.getLastWorkspaceRoot(),
    clampSnippet: (content, limit) => extraction.clampSnippetLength(content, limit),
    conversationMarkerPatterns: CONVERSATION_MARKER_REGEXES,
    computeDiff: (before, after, relativePath) => computeDiff(pythonBridge, before, after, relativePath),
    resolvePlanRunDirectory: (workspaceRoot) => host.env.resolvePlanRunDirectory(workspaceRoot),
    getRunContext: () => normalizeRunContext(host),
    getConfiguration: () => createConfigurationAdapter(host),
    getArtifactPaths: () => ({
      storagePath: host.artifacts.getStoragePath(),
      globalStoragePath: host.artifacts.getGlobalStoragePath()
    }),
    searchEmbeddingCandidates: (targetGoal) => embeddingManager.searchEmbeddingCandidates(targetGoal),
    runGoalInference: (targetGoal, index) => sessionRuntime.runGoalInference(targetGoal, index),
    mergeInsightWithEmbeddings: (insight, hits) =>
      embeddingManager.mergeInsightWithEmbeddings(insight, hits),
    runTypeCheck: (options) => typeCheckRunner.runProjectTypeCheck(options),
    helperImportExtensions: HELPER_IMPORT_EXTENSIONS,
    pythonEnv,
    shellAdapter,
    isDryRunEnabled: () => host.flags.isDryRunEnabled(),
    getRunOptions: () => sessionRuntime.getRunOptions(),
    getWriteTargetPath: (step) => getWriteTargetPath((key) => sessionRuntime.getContextValue(key), step),
    loadWorkspaceFileIndex: (force?: boolean) => workspaceIndexService?.load(force) ?? Promise.resolve([]),
    isDevelopmentMode: () => host.flags.isDevelopmentMode(),
    shouldSkipValidationInDev: () => host.flags.shouldSkipValidationInDev(),
    diagnosticsBus
  });

  workspaceIndexService = workspaceRuntime.workspaceIndex;
  workspaceIndexerService = workspaceRuntime.workspaceIndexer;

  const helperManager = workspaceRuntime.helperManager;
  const diffManager = workspaceRuntime.diffManager;
  const undoManager = workspaceRuntime.undoManager;
  const artifactManager = workspaceRuntime.artifactManager;
  const workspacePackageManager = workspaceRuntime.workspacePackageManager;
  const workspaceIndex = workspaceRuntime.workspaceIndex;
  const typescriptValidator = workspaceRuntime.typescriptValidator;
  const additionalWriteManager = workspaceRuntime.additionalWriteManager;
  const pendingInferenceTracker = workspaceRuntime.pendingInferenceTracker;

  const typeCheckRunner = createTypeCheckRunner({
    runPythonCommand: (payload) => pythonBridge.run('runCommand', payload),
    getProjectRoot: () => host.workspace.getInitialWorkspaceRoot(),
    getWorkspaceRoot: () => sessionRuntime.getLastWorkspaceRoot() ?? getWorkspaceRoot(),
    normalizeRelativePath: (value) => workspaceService.normalizeRelativePath(value),
    getBaselineDiagnostics: () => typescriptValidator.getBaselineDiagnostics()
  });

  const rewriteRuntimeInstance = createAgentRewriteOrchestration({
    helperManager,
    diffManager,
    telemetry,
    workspace: {
      normalizeRelativePath: (value) => workspaceService.normalizeRelativePath(value),
      readFile: (target, encoding) => workspaceService.readFile(target, encoding)
    },
    workspaceIndex,
    hydrationCache: new Map(),
    sessionRuntime,
    getWorkspaceRoot,
    getContextValue: (key) => sessionRuntime.getContextValue(key),
    setContextValue: (key, value) => sessionRuntime.setContextValue(key, value),
    isDryRunEnabled: () => host.flags.isDryRunEnabled(),
    buildExecutionResult: (stepId, outcome, startedAt) =>
      buildExecutionResult(stepId, outcome, startedAt),
    additionalWriteManager,
    pendingInferenceTracker,
    typescriptValidator,
    typeCheckRunner,
    executePythonStep: (action, stepId, step) => runPythonStep(action, stepId, step),
    clampDiffPreview: (diff, maxLines) => clampDiffPreview(diff, maxLines),
    buildContentSample: (content, maxLines, maxLength) =>
      buildContentSample(content, maxLines, maxLength),
    truncateText: (value, max) => truncateText(value, max),
    summarizeDiff: (diff) => summarizeDiff(diff),
    stripCodeFences: (value) => stripCodeFences(value),
    getProjectSummary: () => {
      const base = sessionRuntime.getContextValue<string>('project.summary') ?? 'No project summary available.';
      const semantic = sessionRuntime.getContextValue<string>('semantic.context');
      return semantic ? `${base}\n\nRelevant codebase context:\n${semantic}` : base;
    },
    telemetryHub: {
      emitHelperTelemetry: async (meta, outcome) => {
        await telemetryHub.emitHelperTelemetry(
          { id: meta.helperId, path: meta.helperPath },
          { ok: outcome.ok, error: outcome.error }
        );
      },
      promptRewriteRefinement: async (_step) =>
        host.ui.promptInput({
          title: 'Refine rewrite instructions',
          prompt: 'Add clarifying instructions for this plan step'
        })
    },
    provider: createProviderHost({
      getConfiguration: () => createConfigurationAdapter(host),
      fetchApiKey: () => host.secrets.get(API_KEY_SECRET_KEY),
      fetchSecret: (key) => host.secrets.get(key)
    }),
    createTaskQueue: (options) => createTaskQueue(options),
    persistence,
    storeAdditionalWrites: (outputKey, writes) =>
      storeAdditionalWrites((key, value) => sessionRuntime.setContextValue(key, value), outputKey, writes),
    filterAdditionalWrites: (raw, normalize) => filterAdditionalWrites(raw, normalize),
    parseHelperStepMetadata: (step) => (step ? parseHelperStepMetadata(step) : undefined),
    parseCallerStepMetadata: (step) => (step ? parseCallerStepMetadata(step) : undefined),
    isCancelled: () => sessionRuntime.isCancelled(),
    hydrationLimits: {
      maxEditable: MAX_HYDRATED_EDIT_FILES,
      maxReadonly: MAX_HYDRATED_READONLY_FILES,
      maxSecondaryContext: MAX_SECONDARY_REWRITE_CONTEXT
    },
    fileOpsMarkers: {
      start: '[[BANDIT_FILE_OPS]]',
      end: '[[/BANDIT_FILE_OPS]]'
    },
    diagnosticsBus
  });

  const actionRuntime = createAgentActionRuntime({
    sessionRuntime,
    telemetry,
    workspace: {
      readFile: (target, encoding) => workspaceService.readFile(target, encoding),
      writeFile: (target, content, encoding) => workspaceService.writeFile(target, content, encoding),
      normalizeRelativePath: (value) => workspaceService.normalizeRelativePath(value)
    },
    helperManager,
    embeddingCache: {
      indexFiles: (workspaceRoot, files) => embeddingCache.indexFiles(workspaceRoot, files)
    },
    embeddingManager: {
      scheduleEmbeddingUpsert: (relativePath, content) =>
        embeddingManager.scheduleEmbeddingUpsert(relativePath, content)
    },
    telemetryHub: {
      postEmbeddingStatus: (input) => telemetryHub.postEmbeddingStatus(input)
    },
    extraction: {
      captureExtractionSection: (content) => extraction.captureExtractionSection(content),
      extractRelevantSection: (content, patterns) => extraction.extractRelevantSection(content, patterns),
      clampSnippet: (content, limit) => extraction.clampSnippetLength(content, limit)
    },
    diffManager,
    additionalWriteManager: {
      applyAdditionalWrites: (config) => additionalWriteManager.applyAdditionalWrites(config)
    },
    undoManager,
    diagnostics: {
      recordWriteContext: (paths, helperStep) =>
        diagnosticsBus.emit('diagnostics:recordWriteContext', { paths, helperStep }).catch(() => undefined),
      clearPendingWriteContext: () =>
        diagnosticsBus.emit('diagnostics:clearPendingWriteContext', undefined).catch(() => undefined)
    },
    pendingInferenceTracker: {
      flagMissingFiles: (relativePath, writes) =>
        pendingInferenceTracker.flagMissingFiles(relativePath, writes)
    },
    filterAdditionalWrites: (raw, normalize) => filterAdditionalWrites(raw, normalize),
    resolveAdditionalWritesRef: (action) => resolveAdditionalWritesRef(action),
    runPython: (name, payload) => pythonBridge.run(name, payload),
    executePythonStep: (action, stepId, step) => runPythonStep(action, stepId, step),
    reviewDiff: (action) => {
      const original = sessionRuntime.getContextValue<string>(action.originalContentRef ?? '') ?? '';
      const updated = sessionRuntime.getContextValue<string>(action.updatedContentRef ?? '') ?? '';

      if (!updated.trim()) {
        return Promise.resolve({ ok: false, error: 'Rewrite produced empty content — aborting write.' });
      }

      // Guard against severe shrinkage: if the model returned < 30% of the original, it almost
      // certainly truncated or hallucinated. Reject rather than destroy the file.
      const MIN_RATIO = 0.3;
      const MIN_ORIGINAL_SIZE = 200; // only apply the guard for non-trivial files
      if (original.length > MIN_ORIGINAL_SIZE && updated.length < original.length * MIN_RATIO) {
        return Promise.resolve({
          ok: false,
          error: `Rewrite is suspiciously short: ${updated.length} chars vs original ${original.length} chars (${Math.round((updated.length / original.length) * 100)}%). Likely a truncated or incorrect model response — write blocked.`
        });
      }

      return Promise.resolve({ ok: true, output: `Diff review passed (${updated.length} chars).` });
    },
    buildProjectSummary: (data) => buildProjectSummary(data),
    describeScanResponse: (data) => describeScanResponse(data),
    buildContentSample: (content, maxLines, maxLength) => buildContentSample(content, maxLines, maxLength),
    applyIncrementalEdits: (original, content, _relativePath) => ({
      content,
      replaced: 0,
      total: original.length,
      confidence: 1
    }),
    isDryRunEnabled: () => host.flags.isDryRunEnabled(),
    getWorkspaceRoot: () => sessionRuntime.getLastWorkspaceRoot() ?? getWorkspaceRoot(),
    getProjectSummary: () => {
      const base = sessionRuntime.getContextValue<string>('project.summary') ?? 'No project summary available.';
      const semantic = sessionRuntime.getContextValue<string>('semantic.context');
      return semantic ? `${base}\n\nRelevant codebase context:\n${semantic}` : base;
    },
    resolveRootParam: (ref) =>
      resolveRootParam(sessionRuntime, ref, host.workspace.getInitialWorkspaceRoot()),
    parseHelperMetadata: (step) => (step ? parseHelperStepMetadata(step) : undefined),
    typescriptValidator,
    workspacePackageManager,
    generateRewrite: (goal, relativePath, currentContent, projectSummary, instructions) =>
      rewriteRuntimeInstance?.rewriteGenerator.generateRewrite(goal, relativePath, currentContent, projectSummary, instructions) ??
      Promise.resolve({ ok: false, error: 'Rewrite unavailable.' })
  });

  const rewriteRuntime = rewriteRuntimeInstance;
  const { pythonActions, autoHealer } = actionRuntime;
  pythonActionsRef = pythonActions;

  const diagnosticsServices = workspaceRuntime.createDiagnostics(autoHealer);
  const diagnostics = diagnosticsServices.diagnostics;

  const goalFlowConfig = createGoalFlowHost({
    telemetry,
    telemetryHub: {
      postFinal: (report) => telemetryHub.postFinal(report),
      postPlanUpdate: (stepId, state, meta) => planContext.postPlanUpdate(stepId, state, meta),
      emitExecutionTelemetry: (stepId, result, tokens) =>
        telemetryHub.emitExecutionTelemetry(stepId, result, tokens)
    },
    saveReport: (report) => runMaybePromise(host.env.saveReport?.(report)),
    flushEmbeddings: () => embeddingCache.flush(),
    exportPlan: (options) => artifactManager.exportPlan(options),
    getWorkspaceRoot,
    sessionRuntime,
    getConfiguration: () => createConfigurationAdapter(host),
    promptRewriteRefinement: (_step) =>
      host.ui.promptInput({
        title: 'Refine rewrite instructions',
        prompt: 'Add clarifying instructions for this plan step'
      }),
    estimateTokens: (result) => estimateTokensFromResult(result),
    log: (message, level) => host.telemetry.log({ message, level }),
    stepLifecycle: rewriteRuntime?.stepLifecycle ?? {
      getStatusIconForStep: () => 'plan',
      getResultStatusIcon: () => 'info'
    }
  });

  executorRuntime = createExecutorServices({
    stepExecutor: {
      preflight: (step) => rewriteRuntime?.stepLifecycle.preflightStep(step) ?? Promise.resolve(),
      primeStep: (step) => rewriteRuntime?.stepLifecycle.primeStepContext(step) ?? Promise.resolve(),
      executePython: (action, stepId, step) => runPythonStep(action, stepId, step),
      executeInternal: (step, action) => actionRuntime.internalActions.execute(step, action),
      executeRewrite: (step, action, goal) =>
        rewriteRuntime?.rewriteEngine.execute(step, action, goal) ?? Promise.resolve({ ok: false }),
      validate: (step, goal) => diagnostics.runValidation(step, goal),
      buildResult: (stepId, outcome, startedAt) =>
        buildExecutionResult(stepId, outcome, startedAt)
    },
    coreRuntime: {
      fs: fsAdapter,
      shell: shellAdapter,
      goal: goalEngine,
      helpers: helperManager,
      diff: diffManager,
      py: pythonEnv,
      telemetry,
      bus: connectorBus,
      awaitingGuidancePrefix: AWAITING_GUIDANCE_PREFIX,
      evaluate: (args) => feedbackService.evaluate(args)
    },
    goalFlow: goalFlowConfig,
    hooks: {
      previewOnly: () => sessionRuntime.isPreviewOnly(),
      isCancelled: () => sessionRuntime.isCancelled(),
      postStatus: (payload) => telemetry.status(payload),
      postLog: (payload) => host.telemetry.log(payload),
      postPlanUpdate: (stepId, state, meta) => planContext.postPlanUpdate(stepId, state, meta),
      emitExecutionTelemetry: (stepId, result, tokens) =>
        telemetryHub.emitExecutionTelemetry(stepId, result, tokens),
      autoRevise: () => Promise.resolve({ results: [], iterations: 0 }),
      flushPlanUpdates: () => Promise.resolve()
    },
    lifecycle: rewriteRuntime?.stepLifecycle ?? {
      prepareStep: async () => {},
      finalizeStep: () => {},
      getStatusIconForStep: () => 'task',
      getResultStatusIcon: () => 'info'
    }
  });

  return {
    async preparePlan(goal, options) {
      await assertWritableWorkspace({
        env: host.env,
        workspace: host.workspace,
        config: host.config,
        fs: fsAdapter,
        telemetry
      });
      return sessionRuntime.preparePlan(goal as string, options as AgentGoalOptions);
    },
    async executePlan(plan, goal, options) {
      await assertWritableWorkspace({
        env: host.env,
        workspace: host.workspace,
        config: host.config,
        fs: fsAdapter,
        telemetry
      });
      return sessionRuntime.executePlan(plan as Plan, goal as string, options as AgentGoalOptions);
    },
    startGoal(goal, options) {
      return sessionRuntime.startGoal(goal as string, options as AgentGoalOptions);
    },
    replayStep(stepId, mode) {
      return executorRuntime.goalReplayer.replayStep(stepId, mode ?? 'replay');
    },
    cancel() {
      sessionRuntime.cancel();
    },
    getUndoManager() {
      return undoManager;
    }
  };
}

function createConfigurationAdapter(host: StealthHostBindings) {
  return {
    get<T>(key: string, defaultValue: T): T {
      const value = host.config.get<T>(key, defaultValue);
      return typeof value === 'undefined' ? defaultValue : value;
    }
  };
}

function runMaybePromise(value?: Promise<void> | void) {
  return value ?? Promise.resolve();
}

function getAgentConfiguration(host: StealthHostBindings) {
  const maxIterations = host.config.get<number>('agent.maxIterations', 6) ?? 6;
  const confidenceTarget = host.config.get<number>('agent.confidenceTarget', 0.9) ?? 0.9;
  return {
    maxIterations: Number.isFinite(maxIterations) ? Math.max(0, Math.round(maxIterations)) : 6,
    confidenceTarget: clampConfidence(confidenceTarget)
  };
}

function clampConfidence(value: number) {
  if (!Number.isFinite(value)) {
    return 0.9;
  }
  return Math.min(1, Math.max(0, value));
}

async function computeDiff(
  pythonBridge: ReturnType<typeof createPythonBridge>,
  before: string,
  after: string,
  relativePath: string
) {
  const response = await pythonBridge.run('diffText', {
    before,
    after,
    fromFile: `${relativePath} (old)`,
    toFile: `${relativePath} (new)`
  });

  if (response.status === 'SUCCESS') {
    return typeof response.data?.diff === 'string' ? response.data.diff : response.output;
  }
  return undefined;
}

function normalizeRunContext(host: StealthHostBindings) {
  const context = host.env.getRunContext();
  if (context && typeof context === 'object') {
    const payload = context as { conversationId?: unknown | null; runId?: unknown | null };
    return {
      conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : null,
      runId: typeof payload.runId === 'string' ? payload.runId : null
    };
  }
  return undefined;
}

function resolveRootParam(
  sessionRuntime: ReturnType<typeof createSessionRuntime>,
  ref: string | undefined,
  fallback: string
) {
  if (!ref) {
    return sessionRuntime.ensureSession().workspaceRoot;
  }
  return sessionRuntime.getContextValue<string>(ref) ?? fallback;
}

async function notifyMissingPython(host: StealthHostBindings, telemetry: ITelemetry, detail?: string) {
  const message = detail
    ? `Python 3 is required but could not be started. ${detail}`
    : 'Python 3 is required but was not detected.';
  const detailText = detail ?? message;
   
  console.error('[Bandit Stealth] Python error:', detailText);
  await telemetry.log({ level: 'error', message: `${message} | detail: ${detailText}` });
  await host.ui.showError('Bandit Stealth requires Python 3 to run agent tasks.', detailText);
}

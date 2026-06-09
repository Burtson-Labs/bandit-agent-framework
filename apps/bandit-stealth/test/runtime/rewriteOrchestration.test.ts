import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const rewriteHydrationModule = require(
  '@burtson-labs/stealth-core-runtime/dist/runtime/rewriteHydration.js'
);
const stepLifecycleModule = require(
  '@burtson-labs/stealth-core-runtime/dist/runtime/stepLifecycle.js'
);
const rewriteRuntimeModule = require(
  '@burtson-labs/stealth-core-runtime/dist/runtime/rewriteRuntime.js'
);
const { createRewriteOrchestration } = require('@burtson-labs/stealth-core-runtime');

const createRewriteHydrationManagerMock = vi.fn();
const createStepLifecycleMock = vi.fn();
const createRewriteRuntimeServicesMock = vi.fn();

vi.spyOn(rewriteHydrationModule, 'createRewriteHydrationManager').mockImplementation(
  createRewriteHydrationManagerMock
);
vi.spyOn(stepLifecycleModule, 'createStepLifecycle').mockImplementation(createStepLifecycleMock);
vi.spyOn(rewriteRuntimeModule, 'createRewriteRuntimeServices').mockImplementation(
  createRewriteRuntimeServicesMock
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createRewriteOrchestration', () => {
  it('composes hydration, lifecycle, and runtime services', () => {
    const hydrationManager = { buildBlocks: vi.fn(), buildContext: vi.fn() };
    const stepLifecycle = {
      prepareStep: vi.fn(),
      finalizeStep: vi.fn(),
      resolveRewriteTargetPath: vi.fn()
    };
    const runtimeResult = {
      rewriteGenerator: { id: 'generator' },
      rewriteEngine: { id: 'engine' },
      healingEngine: { id: 'healing' }
    };

    createRewriteHydrationManagerMock.mockReturnValue(hydrationManager);
    createStepLifecycleMock.mockReturnValue(stepLifecycle);
    createRewriteRuntimeServicesMock.mockReturnValue(runtimeResult);

    const hydrationCache = new Map();
    const telemetry = { status: vi.fn(), log: vi.fn(), event: vi.fn() };
    const deps = {
      helperManager: { buildHelperGuidance: vi.fn(), buildCallerGuidance: vi.fn() },
      diffManager: { id: 'diff' },
      telemetry,
      workspace: {
        normalizeRelativePath: vi.fn((value: string) => value),
        readFile: vi.fn()
      },
      workspaceIndex: {
        getFileRecord: vi.fn()
      },
      hydrationCache,
      ensureSession: vi.fn().mockReturnValue({ workspaceRoot: '/tmp' }),
      getWorkspaceRoot: vi.fn().mockReturnValue('/tmp'),
      getContextValue: vi.fn(),
      setContextValue: vi.fn(),
      isPreviewOnly: () => false,
      isDryRunEnabled: () => false,
      getRunOptions: () => ({ previewOnly: false }),
      getCurrentGoalInsight: () => undefined,
      buildExecutionResult: vi.fn(),
      additionalWriteManager: { applyAdditionalWrites: vi.fn() },
      pendingInferenceTracker: { resolvePendingFiles: vi.fn() },
      typescriptValidator: {
        getRewriteHint: vi.fn(),
        getBaselineDiagnostics: vi.fn().mockReturnValue([])
      },
      typeCheckRunner: { runProjectTypeCheck: vi.fn() },
      executePythonStep: vi.fn(),
      clampDiffPreview: vi.fn(),
      buildContentSample: vi.fn(),
      truncateText: vi.fn(),
      summarizeDiff: vi.fn(),
      stripCodeFences: vi.fn(),
      getProjectSummary: () => 'summary',
      telemetryHub: {
        emitHelperTelemetry: vi.fn(),
        promptRewriteRefinement: vi.fn()
      },
      provider: {
        getConfiguration: vi.fn().mockReturnValue({ get: vi.fn() }),
        getProviderKind: vi.fn(),
        getModel: vi.fn(),
        buildProviderSettings: vi.fn(),
        getTopP: vi.fn(),
        fetchApiKey: vi.fn(),
        createProvider: vi.fn(),
        fetchSecret: vi.fn()
      },
      createTaskQueue: vi.fn().mockReturnValue({
        enqueue: vi.fn(),
        cancelPending: vi.fn(),
        getSize: vi.fn()
      }),
      persistence: { id: 'persistence' },
      storeAdditionalWrites: vi.fn(),
      filterAdditionalWrites: vi.fn(),
      parseHelperStepMetadata: vi.fn(),
      parseCallerStepMetadata: vi.fn(),
      isCancelled: () => false,
      hydrationLimits: { maxEditable: 1, maxReadonly: 2, maxSecondaryContext: 3 },
      fileOpsMarkers: { start: '[[', end: ']]' },
      diagnosticsBus: {
        emit: vi.fn(),
        on: vi.fn().mockReturnValue(() => undefined)
      },
      eventBus: {
        emit: vi.fn(),
        on: vi.fn().mockReturnValue(() => undefined)
      }
    } as const;

    const result = createRewriteOrchestration(deps);

    expect(createRewriteHydrationManagerMock).toHaveBeenCalledWith(
      expect.objectContaining({ normalizeRelativePath: expect.any(Function) }),
      deps.hydrationLimits
    );
    expect(createStepLifecycleMock).toHaveBeenCalled();
    expect(createRewriteRuntimeServicesMock).toHaveBeenCalledWith(
      expect.objectContaining({ rewrite: expect.any(Object), healing: expect.any(Object) })
    );

    expect(result.rewriteHydrationManager).toBe(hydrationManager);
    expect(result.stepLifecycle).toBe(stepLifecycle);
    expect(result.rewriteGenerator).toBe(runtimeResult.rewriteGenerator);
    expect(result.rewriteEngine).toBe(runtimeResult.rewriteEngine);
    expect(result.healingEngine).toBe(runtimeResult.healingEngine);
  });
});

import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionServicesHost, AutoHealer, AutoHealerDeps } from '@burtson-labs/stealth-core-runtime';

const require = createRequire(import.meta.url);
const actionServicesModule = require(
  '@burtson-labs/stealth-core-runtime/dist/runtime/actionServices.js'
);
const autoHealerModule = require('@burtson-labs/stealth-core-runtime/dist/runtime/autoHealer.js');
const { createActionRuntimeServices } = require('@burtson-labs/stealth-core-runtime');

const createActionServicesMock = vi.fn();
const createAutoHealerMock = vi.fn();

vi.spyOn(actionServicesModule, 'createActionServices').mockImplementation(createActionServicesMock);
vi.spyOn(autoHealerModule, 'createAutoHealer').mockImplementation(createAutoHealerMock);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createActionRuntimeServices', () => {
  it('wires action services and auto-healer dependencies', () => {
    const internalActions = { kind: 'internal' } as const;
    const pythonActions = { kind: 'python' } as const;
    const autoHealer = { autoHealTypeScriptErrors: vi.fn() } as AutoHealer;

    createActionServicesMock.mockReturnValue({ internalActions, pythonActions });
    createAutoHealerMock.mockReturnValue(autoHealer);

    const actionHost: ActionServicesHost = {
      ensureSession: () => ({ workspaceRoot: '/tmp' }),
      getContextValue: vi.fn(),
      setContextValue: vi.fn(),
      normalizeRelativePath: vi.fn(),
      parseHelperStepMetadata: vi.fn(),
      resolveRootParam: vi.fn(),
      isDryRunEnabled: () => false,
      isPreviewOnly: () => false,
      telemetry: { status: vi.fn(), log: vi.fn(), event: vi.fn() },
      embeddingCache: { indexFiles: vi.fn() },
      embeddingManager: { scheduleEmbeddingUpsert: vi.fn() },
      postEmbeddingStatus: vi.fn(),
      captureExtractionSection: vi.fn(),
      extractRelevantSection: vi.fn(),
      clampSnippet: vi.fn(),
      buildProjectSummary: vi.fn(),
      describeScanResponse: vi.fn(),
      buildContentSample: vi.fn(),
      applyIncrementalEdits: vi.fn(),
      applyImportHints: vi.fn(),
      diffManager: { registerPendingDiff: vi.fn() },
      additionalWriteManager: { applyAdditionalWrites: vi.fn() },
      undoManager: { recordSnapshot: vi.fn() },
      recordWriteContext: vi.fn(),
      clearPendingWriteContext: vi.fn(),
      pendingInferenceTracker: { flagMissingFiles: vi.fn() },
      filterAdditionalWrites: vi.fn(),
      resolveAdditionalWritesRef: vi.fn(),
      runPython: vi.fn(),
      runPythonStep: vi.fn(),
      reviewDiff: vi.fn(),
      isCancelled: () => false
    };

    const autoHealerDeps = {
      telemetry: { status: vi.fn(), log: vi.fn(), event: vi.fn() },
      diffManager: { clear: vi.fn(), getPendingDiff: vi.fn(), registerPendingDiff: vi.fn(), recordSnapshot: vi.fn(),
        popSnapshot: vi.fn(), hasSnapshots: vi.fn(), getSnapshotCount: vi.fn(), enableReviewMode: vi.fn(),
        isReviewModeEnabled: vi.fn(), postDiffStream: vi.fn() },
      typescriptValidator: {
        captureBaseline: vi.fn(),
        runValidation: vi.fn(),
        indexDiagnosticsByFile: vi.fn(),
        getBaselineDiagnostics: vi.fn().mockReturnValue([]),
        getRewriteHint: vi.fn()
      },
      workspacePackageManager: { updateFromSnapshot: vi.fn(), runLintValidation: vi.fn() },
      ensureSession: () => ({ workspaceRoot: '/tmp' }),
      readWorkspaceFile: vi.fn(),
      writeWorkspaceFile: vi.fn(),
      normalizeRelativePath: vi.fn(),
      getProjectSummary: () => 'summary',
      generateRewrite: vi.fn(),
      isDryRunEnabled: () => false,
      isPreviewOnly: () => false,
      scheduleEmbeddingUpsert: vi.fn(),
      undoManager: { recordSnapshot: vi.fn() },
      getWorkspaceRoot: () => '/tmp'
    } as unknown as AutoHealerDeps;

    const runtime = createActionRuntimeServices({ actionHost, autoHealer: autoHealerDeps });

    expect(createActionServicesMock).toHaveBeenCalledWith(actionHost);
    expect(createAutoHealerMock).toHaveBeenCalledWith(autoHealerDeps);
    expect(runtime.internalActions).toBe(internalActions);
    expect(runtime.pythonActions).toBe(pythonActions);
    expect(runtime.autoHealer).toBe(autoHealer);
  });
});

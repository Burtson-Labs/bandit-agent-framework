import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const workspaceServicesModule = require(
  '@burtson-labs/stealth-core-runtime/dist/runtime/workspaceServices.js'
);
const writeServicesModule = require(
  '@burtson-labs/stealth-core-runtime/dist/runtime/writeServices.js'
);
const diagnosticsServicesModule = require(
  '@burtson-labs/stealth-core-runtime/dist/runtime/diagnosticsServices.js'
);
const { createWorkspaceRuntimeServices } = require('@burtson-labs/stealth-core-runtime');

const createWorkspaceServicesMock = vi.fn();
const createWriteServicesMock = vi.fn();
const createDiagnosticsServicesMock = vi.fn();

vi.spyOn(workspaceServicesModule, 'createWorkspaceServices').mockImplementation(
  createWorkspaceServicesMock
);
vi.spyOn(writeServicesModule, 'createWriteServices').mockImplementation(createWriteServicesMock);
vi.spyOn(diagnosticsServicesModule, 'createDiagnosticsServices').mockImplementation(
  createDiagnosticsServicesMock
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createWorkspaceRuntimeServices', () => {
  it('composes workspace, write, and diagnostics services', () => {
    const workspaceIndex = { getFileIndex: vi.fn().mockReturnValue(['a.ts']) };
    const workspaceServicesResult = {
      helperManager: { id: 'helpers' },
      diffManager: { id: 'diff' },
      undoManager: { id: 'undo' },
      artifactManager: { id: 'artifact' },
      workspacePackageManager: { id: 'pkg' },
      workspaceIndex,
      typescriptValidator: { id: 'ts' },
      planPreparer: { id: 'plan' }
    };
    createWorkspaceServicesMock.mockReturnValue(workspaceServicesResult);

    const writeServicesResult = {
      additionalWriteManager: { id: 'writes' },
      pendingInferenceTracker: { id: 'tracker' }
    };
    createWriteServicesMock.mockReturnValue(writeServicesResult);

    const diagnosticsServicesResult = {
      diagnostics: { id: 'diagnostics' },
      validationUtils: { id: 'val' },
      validationController: { id: 'controller' }
    };
    createDiagnosticsServicesMock.mockReturnValue(diagnosticsServicesResult);

    const workspaceDeps = { workspace: {}, write: {}, diagnostics: {} } as any;
    const runtime = createWorkspaceRuntimeServices(workspaceDeps);

    expect(createWorkspaceServicesMock).toHaveBeenCalledWith(workspaceDeps.workspace);
    expect(createWriteServicesMock).toHaveBeenCalledTimes(1);
    const writeCall = createWriteServicesMock.mock.calls[0][0];
    expect(writeCall.getWorkspaceFileIndex()).toEqual(['a.ts']);

    expect(runtime.helperManager).toBe(workspaceServicesResult.helperManager);
    expect(runtime.diffManager).toBe(workspaceServicesResult.diffManager);
    expect(runtime.additionalWriteManager).toBe(writeServicesResult.additionalWriteManager);
    expect(runtime.pendingInferenceTracker).toBe(writeServicesResult.pendingInferenceTracker);

    const diag = runtime.createDiagnostics({} as any);
    expect(createDiagnosticsServicesMock).toHaveBeenCalledTimes(1);
    const diagCall = createDiagnosticsServicesMock.mock.calls[0][0];
    expect(diagCall.autoHealer).toEqual({});
    expect(diagCall.getWorkspaceFileIndex()).toEqual(['a.ts']);
    expect(diag.diagnostics).toBe(diagnosticsServicesResult.diagnostics);
  });
});

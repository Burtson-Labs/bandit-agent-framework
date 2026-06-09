import * as path from 'path';
import { createWorkspaceServices, type WorkspaceServicesDeps } from './workspaceServices';
import { createWriteServices, type WriteServicesDeps } from './writeServices';
import { createDiagnosticsServices, type DiagnosticsServicesDeps } from './diagnosticsServices';
import { createWorkspaceIndexer } from './workspaceIndexer';
import type { AutoHealer } from './autoHealer';

type WriteServicesHostDeps = Omit<WriteServicesDeps, 'diffManager' | 'undoManager' | 'getWorkspaceFileIndex'>;
type DiagnosticsServicesHostDeps = Omit<
  DiagnosticsServicesDeps,
  'diffManager' | 'typescriptValidator' | 'workspacePackageManager' | 'autoHealer' | 'getWorkspaceFileIndex'
>;

export interface WorkspaceRuntimeDeps {
  workspace: WorkspaceServicesDeps & {
    getLastWorkspaceRoot(): string | undefined;
    loadWorkspaceIndex(force?: boolean): Promise<string[]>;
  };
  write: WriteServicesHostDeps;
  diagnostics: DiagnosticsServicesHostDeps;
}

export function createWorkspaceRuntimeServices(deps: WorkspaceRuntimeDeps) {
  const workspaceServices = createWorkspaceServices(deps.workspace);

  const writeServices = createWriteServices({
    ...deps.write,
    diffManager: workspaceServices.diffManager,
    getWorkspaceFileIndex: () => workspaceServices.workspaceIndex.getFileIndex(),
    undoManager: workspaceServices.undoManager
  });

  const workspaceIndexer = createWorkspaceIndexer({
    getWorkspaceRoot: () => deps.workspace.getLastWorkspaceRoot() ?? deps.workspace.getWorkspaceRoot(),
    loadWorkspaceIndex: (force) => deps.workspace.loadWorkspaceIndex(force),
    getWorkspaceIndexSnapshot: () => workspaceServices.workspaceIndex.getSnapshot(),
    readWorkspaceFile: async (relativePath) => {
      const workspaceRoot = deps.workspace.getLastWorkspaceRoot() ?? deps.workspace.getWorkspaceRoot();
      const absolutePath = path.join(workspaceRoot, relativePath);
      return deps.workspace.workspace.readFile(absolutePath, 'utf8');
    },
    normalizeRelativePath: (value) => deps.workspace.workspace.normalizeRelativePath(value)
  });

  function createDiagnostics(autoHealer: AutoHealer) {
    return createDiagnosticsServices({
      ...deps.diagnostics,
      diffManager: workspaceServices.diffManager,
      typescriptValidator: workspaceServices.typescriptValidator,
      workspacePackageManager: workspaceServices.workspacePackageManager,
      autoHealer,
      getWorkspaceFileIndex: () => workspaceServices.workspaceIndex.getFileIndex()
    });
  }

  return {
    helperManager: workspaceServices.helperManager,
    diffManager: workspaceServices.diffManager,
    undoManager: workspaceServices.undoManager,
    artifactManager: workspaceServices.artifactManager,
    workspacePackageManager: workspaceServices.workspacePackageManager,
    workspaceIndex: workspaceServices.workspaceIndex,
    typescriptValidator: workspaceServices.typescriptValidator,
    planPreparer: workspaceServices.planPreparer,
    workspaceIndexer,
    additionalWriteManager: writeServices.additionalWriteManager,
    pendingInferenceTracker: writeServices.pendingInferenceTracker,
    createDiagnostics
  };
}

export type WorkspaceRuntimeResult = ReturnType<typeof createWorkspaceRuntimeServices>;

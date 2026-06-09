import { WorkspaceIndex } from '../workspaceIndex';
import type { WorkspaceIndexSnapshot, WorkspaceFileRecord, TypeScriptDiagnostic } from '../internalTypes';

export interface WorkspaceIndexServiceDeps {
  getWorkspaceRoot(): string;
  getArtifactRoot(workspaceRoot: string): string;
  setWorkspaceIndexContext(summary: { generatedAt: number; totalFiles: number; totalBytes: number }): void;
  postStatus(snapshot: WorkspaceIndexSnapshot): Promise<void> | void;
  updateWorkspacePackages(snapshot: WorkspaceIndexSnapshot): Promise<void> | void;
  normalizeRelativePath(value: string): string | undefined;
}

export interface WorkspaceIndexService {
  load(force?: boolean): Promise<string[]>;
  clear(): void;
  getFileIndex(): string[];
  getSnapshot(): WorkspaceIndexSnapshot | undefined;
  getFileRecord(relativePath: string): WorkspaceFileRecord | undefined;
  resolveImportTarget(relativePath: string, extensions: string[]): string | undefined;
  mapDiagnosticsToWorkspace(diagnostics: TypeScriptDiagnostic[]): TypeScriptDiagnostic[];
}

export function createWorkspaceIndexService(deps: WorkspaceIndexServiceDeps): WorkspaceIndexService {
  let fileIndex: string[] = [];
  let manager: WorkspaceIndex | undefined;
  let snapshot: WorkspaceIndexSnapshot | undefined;
  let lookup: Map<string, WorkspaceFileRecord> | undefined;
  let pathLookup: Map<string, string> | undefined;

  function clear(): void {
    fileIndex = [];
    snapshot = undefined;
    lookup = undefined;
    manager = undefined;
    pathLookup = undefined;
  }

  async function load(force = false): Promise<string[]> {
    let workspaceRoot: string;
    try {
      workspaceRoot = deps.getWorkspaceRoot();
    } catch {
      clear();
      return [];
    }
    const artifactRoot = deps.getArtifactRoot(workspaceRoot);
    if (!manager || manager.getRoot() !== workspaceRoot) {
      manager = new WorkspaceIndex({ workspaceRoot, artifactRoot });
    }
    try {
      const loaded = await manager.load(force);
      snapshot = loaded;
      lookup = new Map(loaded.files.map((file) => [file.path.toLowerCase(), file]));
      fileIndex = loaded.files.map((file) => file.path);
      pathLookup = new Map(fileIndex.map((file) => [file.toLowerCase(), file]));
      deps.setWorkspaceIndexContext({
        generatedAt: loaded.generatedAt,
        totalFiles: loaded.files.length,
        totalBytes: loaded.totalBytes
      });
      await Promise.resolve(deps.postStatus(loaded)).catch(() => undefined);
      await Promise.resolve(deps.updateWorkspacePackages(loaded)).catch(() => undefined);
      return fileIndex;
    } catch (error) {
      console.warn('Failed to build workspace index for goal inference', error);
      fileIndex = [];
      lookup = undefined;
      pathLookup = undefined;
      return [];
    }
  }

  function getFileIndex(): string[] {
    return fileIndex;
  }

  function getSnapshot(): WorkspaceIndexSnapshot | undefined {
    return snapshot;
  }

  function getFileRecord(relativePath: string): WorkspaceFileRecord | undefined {
    if (!snapshot) {
      return undefined;
    }
    if (!lookup) {
      lookup = new Map(snapshot.files.map((file) => [file.path.toLowerCase(), file]));
    }
    const normalized = deps.normalizeRelativePath(relativePath) ?? relativePath;
    if (!normalized) {
      return undefined;
    }
    return lookup.get(normalized.toLowerCase());
  }

  function resolveImportTarget(relativePath: string, extensions: string[]): string | undefined {
    if (!relativePath) {
      return undefined;
    }
    const normalized = relativePath.replace(/\\/g, '/');
    if (!normalized) {
      return undefined;
    }
    if (!pathLookup || pathLookup.size === 0) {
      pathLookup = new Map(fileIndex.map((file) => [file.toLowerCase(), file]));
    }
    if (!pathLookup || pathLookup.size === 0) {
      return undefined;
    }
    const candidates = new Set<string>();
    candidates.add(normalized.toLowerCase());
    extensions.forEach((ext) => {
      if (!normalized.endsWith(ext)) {
        candidates.add(`${normalized}${ext}`.toLowerCase());
      }
      candidates.add(`${normalized}/index${ext}`.toLowerCase());
    });
    for (const candidate of candidates) {
      const match = pathLookup.get(candidate);
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  function mapDiagnosticsToWorkspace(diagnostics: TypeScriptDiagnostic[]): TypeScriptDiagnostic[] {
    if (!snapshot || !diagnostics.length) {
      return diagnostics;
    }
    const lookup = new Map<string, string>();
    snapshot.files.forEach((file) => {
      lookup.set(file.path.toLowerCase(), file.path);
    });
    return diagnostics.map((diagnostic) => {
      const normalized = deps.normalizeRelativePath(diagnostic.file) ?? diagnostic.file;
      const canonical = normalized ? lookup.get(normalized.toLowerCase()) : undefined;
      if (canonical) {
        diagnostic.file = canonical;
      } else if (normalized) {
        diagnostic.file = normalized;
      }
      return diagnostic;
    });
  }

  return {
    load,
    clear,
    getFileIndex,
    getSnapshot,
    getFileRecord,
    resolveImportTarget,
    mapDiagnosticsToWorkspace
  };
}

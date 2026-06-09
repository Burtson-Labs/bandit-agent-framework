import { createChangeTracker } from './changeTracker';
import type {
  Disposable,
  FileChangeSnapshot,
  FilePreWriteState,
  IDiffManager,
  IFsAdapter,
  IUndoManager
} from '../internalTypes';

export interface UndoManagerDeps {
  diffManager: IDiffManager;
  fs: IFsAdapter;
}

export function createUndoManager(deps: UndoManagerDeps): IUndoManager {
  const listeners = new Set<(count: number) => void>();
  const changeTracker = createChangeTracker({
    diffManager: deps.diffManager,
    fs: deps.fs,
    notifySnapshotCount: (count) => notify(count)
  });

  function notify(count: number): void {
    for (const listener of listeners) {
      try {
        listener(count);
      } catch (error) {
        console.warn('UndoManager listener failed', error);
      }
    }
  }

  function recordSnapshot(snapshot: FileChangeSnapshot): void {
    changeTracker.recordSnapshot(snapshot);
  }

  function capturePreWriteState(
    workspaceRoot: string,
    relativePath: string,
    encoding: BufferEncoding,
    fallback?: string
  ): Promise<FilePreWriteState> {
    return changeTracker.capturePreWriteState(workspaceRoot, relativePath, encoding, fallback);
  }

  function createBackup(workspaceRoot: string, relativePath: string, content: string): Promise<string> {
    return changeTracker.createBackup(workspaceRoot, relativePath, content);
  }

  function hasSnapshots(): boolean {
    return changeTracker.hasSnapshots();
  }

  function getSnapshotCount(): number {
    return changeTracker.getSnapshotCount();
  }

  function undoLastChange(): Promise<FileChangeSnapshot | null> {
    return changeTracker.undoLastChange();
  }

  function onDidUpdateSnapshots(listener: (count: number) => void): Disposable {
    listeners.add(listener);
    return {
      dispose: () => listeners.delete(listener)
    };
  }

  return {
    recordSnapshot,
    capturePreWriteState,
    createBackup,
    hasSnapshots,
    getSnapshotCount,
    undoLastChange,
    onDidUpdateSnapshots
  };
}

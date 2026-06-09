import { createAdditionalWriteManager } from './additionalWrites';
import { createPendingInferenceTracker } from './pendingInference';
import type { ITelemetry, IDiffManager } from '../internalTypes';
import type { EmbeddingManager } from './embeddingManager';
import type { InferredGoal } from '../internalTypes';

export interface WriteServicesDeps {
  telemetry: ITelemetry;
  diffManager: IDiffManager;
  workspace: {
    readFile(target: string, encoding?: BufferEncoding): Promise<string>;
    writeFile(target: string, content: string, encoding?: BufferEncoding): Promise<void>;
    normalizeRelativePath(value: string): string | undefined;
    isPathInside(base: string, target: string): boolean;
    fileExists(path: string): Promise<boolean>;
  };
  undoManager: { recordSnapshot(snapshot: unknown): void };
  embeddingManager: EmbeddingManager;
  getSessionWorkspaceRoot(): string | undefined;
  getCurrentInsight(): InferredGoal | undefined;
  getWorkspaceFileIndex(): string[];
  getContextValue<T>(key: string): T | undefined;
  setContextValue(key: string, value: unknown): void;
}

export function createWriteServices(deps: WriteServicesDeps) {
  const additionalWriteManager = createAdditionalWriteManager({
    telemetry: deps.telemetry,
    diffManager: deps.diffManager,
    readWorkspaceFile: (target, encoding) => deps.workspace.readFile(target, encoding),
    writeWorkspaceFile: (target, content, encoding) => deps.workspace.writeFile(target, content, encoding),
    normalizeRelativePath: (value) => deps.workspace.normalizeRelativePath(value),
    isPathInside: (base, target) => deps.workspace.isPathInside(base, target),
    undoManager: deps.undoManager,
    scheduleEmbeddingUpsert: (relativePath, content) => deps.embeddingManager.scheduleEmbeddingUpsert(relativePath, content)
  });

  const pendingInferenceTracker = createPendingInferenceTracker({
    getCurrentInsight: () => deps.getCurrentInsight(),
    getWorkspaceRoot: () => deps.getSessionWorkspaceRoot(),
    getWorkspaceFileIndex: () => deps.getWorkspaceFileIndex(),
    normalizeRelativePath: (value) => deps.workspace.normalizeRelativePath(value),
    workspaceFileExists: (absPath) => deps.workspace.fileExists(absPath),
    getPendingFiles: () => deps.getContextValue<string[]>('focus.primary.expectedAdditionalFiles') ?? [],
    setPendingFiles: (files) => deps.setContextValue('focus.primary.expectedAdditionalFiles', files),
    logWarning: (message) => deps.telemetry.log({ message, level: 'warn' })
  });

  return {
    additionalWriteManager,
    pendingInferenceTracker
  };
}

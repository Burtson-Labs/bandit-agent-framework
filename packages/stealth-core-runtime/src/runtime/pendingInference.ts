import * as path from 'path';
import type { InferredGoal } from '../internalTypes';
import type { AdditionalWrite } from '../internalTypes';

export interface PendingInferenceDeps {
  getCurrentInsight(): InferredGoal | undefined;
  getWorkspaceRoot(): string | undefined;
  getWorkspaceFileIndex(): string[];
  normalizeRelativePath(value: string): string | undefined;
  workspaceFileExists(absPath: string): Promise<boolean>;
  getPendingFiles(): string[];
  setPendingFiles(files: string[]): void;
  logWarning(message: string): Promise<void> | void;
}

export function createPendingInferenceTracker(deps: PendingInferenceDeps) {
  async function flagMissingFiles(relativePath: string, writes: AdditionalWrite[]): Promise<void> {
    const missing = await computeMissingFiles(relativePath, writes);
    deps.setPendingFiles(missing);
    if (missing.length > 0) {
      await deps.logWarning(
        `Goal inference expects these helper files to exist: ${missing.join(
          ', '
        )}. Include them as FILE entries in the \`\`\`files block with full file contents.`
      );
    }
  }

  async function computeMissingFiles(relativePath: string, writes: AdditionalWrite[]): Promise<string[]> {
    const insight = deps.getCurrentInsight();
    const workspaceRoot = deps.getWorkspaceRoot();
    if (!insight || !workspaceRoot) {
      return [];
    }
    const created = new Set(
      writes
        .map((write) => deps.normalizeRelativePath(write.path))
        .filter((value): value is string => Boolean(value))
    );
    const originPath = deps.normalizeRelativePath(relativePath) ?? relativePath;
    const candidates = new Set<string>();

    (insight.files ?? []).forEach((file) => {
      const normalized = deps.normalizeRelativePath(file);
      if (normalized) {
        candidates.add(normalized);
      }
    });
    (insight.tasks ?? []).forEach((task) => {
      (task.files ?? []).forEach((file) => {
        const normalized = deps.normalizeRelativePath(file);
        if (normalized) {
          candidates.add(normalized);
        }
      });
    });
    candidates.delete(originPath);

    const missing: string[] = [];
    const workspaceFiles = deps.getWorkspaceFileIndex();
    for (const candidate of candidates) {
      if (!candidate || created.has(candidate)) {
        continue;
      }
      const absolute = pathJoin(workspaceRoot, candidate);
      const exists = await deps.workspaceFileExists(absolute);
      if (exists) {
        continue;
      }
      const baseName = candidate.split('/').pop();
      if (
        baseName &&
        workspaceFiles.some((file) => file.endsWith(`/${baseName}`) || file === baseName)
      ) {
        continue;
      }
      missing.push(candidate);
    }
    return missing;
  }

  async function resolvePendingFiles(): Promise<string[]> {
    const pending = deps.getPendingFiles();
    const workspaceRoot = deps.getWorkspaceRoot();
    if (!pending.length || !workspaceRoot) {
      return [];
    }
    const outstanding: string[] = [];
    for (const file of pending) {
      if (!file) {
        continue;
      }
      const target = pathJoin(workspaceRoot, file);
      const exists = await deps.workspaceFileExists(target);
      if (!exists) {
        outstanding.push(file);
      }
    }
    deps.setPendingFiles(outstanding);
    return outstanding;
  }

  function pathJoin(root: string, relative: string): string {
    return path.resolve(root, relative);
  }

  return {
    flagMissingFiles,
    computeMissingFiles,
    resolvePendingFiles
  };
}

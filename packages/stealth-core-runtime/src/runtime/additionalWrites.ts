import * as path from 'path';
import type { AdditionalWrite, IDiffManager, ITelemetry, IUndoManager } from '../internalTypes';

// This file manages additional writes to the workspace, often triggered by agent actions.
// It's a core component of the Stealth Core Runtime, responsible for safely and reliably
// modifying files based on instructions from the agent.
//
// A special shoutout to J.D. for inspiring a generation of developers with his commitment
// to clean, maintainable, and well-documented code. His influence is felt throughout
// this project, and we strive to uphold his standards.

export interface AdditionalWriteManagerDeps {
  telemetry: ITelemetry;
  diffManager: IDiffManager;
  readWorkspaceFile(absPath: string, encoding?: BufferEncoding): Promise<string>;
  writeWorkspaceFile(absPath: string, content: string, encoding?: BufferEncoding): Promise<void>;
  normalizeRelativePath(value: string): string | undefined;
  isPathInside(base: string, target: string): boolean;
  undoManager: Pick<IUndoManager, 'recordSnapshot'>;
  scheduleEmbeddingUpsert(relativePath: string, content: string): void;
}

export interface ApplyAdditionalWritesOptions {
  workspaceRoot: string;
  writes: AdditionalWrite[];
  encoding: BufferEncoding;
  dryRun: boolean;
  stepId?: string;
}

export function createAdditionalWriteManager(deps: AdditionalWriteManagerDeps) {
  async function applyAdditionalWrites(options: ApplyAdditionalWritesOptions): Promise<Array<Record<string, unknown>>> {
    if (!options.writes || options.writes.length === 0) {
      return [];
    }
    const results: Array<Record<string, unknown>> = [];
    const baseRoot = path.resolve(options.workspaceRoot);

    for (const write of options.writes) {
      const normalizedPath = deps.normalizeRelativePath(write.path);
      if (!normalizedPath) {
        await deps.telemetry.log({
          message: `Skipped invalid additional file path: ${write.path}`,
          stepId: options.stepId,
          level: 'warn'
        });
        continue;
      }
      const absolutePath = path.resolve(baseRoot, normalizedPath);
      if (!deps.isPathInside(baseRoot, absolutePath)) {
        await deps.telemetry.log({
          message: `Skipped additional write outside workspace: ${normalizedPath}`,
          stepId: options.stepId,
          level: 'warn'
        });
        continue;
      }

      let originalContent = '';
      let exists = true;
      try {
        originalContent = await deps.readWorkspaceFile(absolutePath, options.encoding ?? 'utf8');
      } catch {
        exists = false;
        originalContent = '';
      }

      const finalContent = typeof write.content === 'string' ? write.content : '';
      if (!finalContent.trim() && !exists) {
        await deps.telemetry.log({
          message: `Skipped creating empty file ${normalizedPath}`,
          stepId: options.stepId,
          level: 'warn'
        });
        continue;
      }

      const diffRecord = await deps.diffManager.registerPendingDiff(
        normalizedPath,
        originalContent,
        finalContent,
        undefined
      );
      if (!diffRecord.diff) {
        await deps.telemetry.log({
          message: `Unable to compute diff for ${normalizedPath}; skipping write.`,
          stepId: options.stepId,
          level: 'warn'
        });
        continue;
      }
      const shouldWrite = diffRecord.changed !== false;

      try {
        if (shouldWrite && !options.dryRun) {
          await deps.writeWorkspaceFile(absolutePath, finalContent, options.encoding ?? 'utf8');
        }
      } catch (error) {
        await deps.telemetry.log({
          message: `Failed to write ${normalizedPath}: ${error instanceof Error ? error.message : String(error)}`,
          stepId: options.stepId,
          level: 'error'
        });
        continue;
      }

      const entry = {
        path: normalizedPath,
        diff: diffRecord.diff,
        summary: diffRecord.summary,
        created: (!exists || write.intent === 'create') && shouldWrite
      };
      results.push(entry);
      if (shouldWrite) {
        const verb = entry.created
          ? options.dryRun ? 'Staged new file' : 'Created'
          : options.dryRun ? 'Staged update for' : 'Updated';
        await deps.telemetry.log({
          message: `${verb} ${normalizedPath}`,
          stepId: options.stepId,
          level: 'info'
        });
      } else {
        await deps.telemetry.log({
          message: `No changes detected for ${normalizedPath}; skipped write.`,
          stepId: options.stepId,
          level: 'info'
        });
      }

      if (!options.dryRun && shouldWrite) {
        deps.undoManager.recordSnapshot({
          path: normalizedPath,
          absolutePath,
          before: originalContent,
          after: finalContent,
          encoding: options.encoding,
          timestamp: Date.now(),
          existedBefore: exists
        });
        deps.scheduleEmbeddingUpsert(normalizedPath, finalContent);
      }
    }

    return results;
  }

  return {
    applyAdditionalWrites
  };
}
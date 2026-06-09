import * as path from 'path';
import type {
  PlanStep,
  PythonScanProjectAction,
  PythonReadFileAction,
  PythonWriteFileAction,
  PythonRunCommandAction
} from '../internalTypes';
import type {
  HelperStepMetadata,
  AdditionalWrite,
  StepOutcome,
  StatusPayload,
  LogPayload,
  PythonResponse,
  FilePreWriteState,
  IUndoManager
} from '../internalTypes';

export type PythonAction =
  | PythonScanProjectAction
  | PythonReadFileAction
  | PythonWriteFileAction
  | PythonRunCommandAction;

export interface PythonActionDeps {
  ensureSession(): { workspaceRoot: string };
  getContextValue<T>(key: string): T | undefined;
  setContextValue(key: string, value: unknown): void;
  normalizeRelativePath(value: string): string | undefined;
  getHelperStepMetadata(step: PlanStep | undefined): HelperStepMetadata | undefined;
  resolveRootParam(ref?: string): string;
  isDryRunEnabled(): boolean;
  isPreviewOnly(): boolean;
  telemetry: {
    status(payload: StatusPayload): Promise<void>;
    log(payload: LogPayload): Promise<void>;
  };
  embeddingCache: {
    indexFiles(workspaceRoot: string, files: string[]): Promise<{ reused: number; computed: number }>;
  };
  embeddingManager: {
    scheduleEmbeddingUpsert(path: string, content: string): void;
  };
  postEmbeddingStatus(stats: { reused: number; computed: number }, total: number): Promise<void>;
  captureExtractionSection(content: string): void;
  buildProjectSummary(data: Record<string, unknown> | undefined): string;
  describeScanResponse(data: Record<string, unknown> | undefined): string | undefined;
  buildContentSample(content: string, maxLines?: number, maxLength?: number): string;
  applyIncrementalEdits(
    original: string,
    content: string,
    relativePath: string
  ): { content: string; replaced: number; total: number; confidence: number };
  helperManager: {
    applyImportHints(meta: HelperStepMetadata | undefined, content: string): string;
  };
  diffManager: {
    registerPendingDiff(
      path: string,
      original: string,
      updated: string,
      confidence?: number
    ): Promise<{ diff?: string; summary?: { added: number; removed: number }; changed?: boolean; confidence?: number }>;
  };
  additionalWriteManager: {
    applyAdditionalWrites(config: {
      workspaceRoot: string;
      writes: AdditionalWrite[];
      encoding: BufferEncoding;
      dryRun: boolean;
      stepId?: string;
    }): Promise<Array<Record<string, unknown>>>;
  };
  undoManager: Pick<IUndoManager, 'createBackup' | 'capturePreWriteState' | 'recordSnapshot'>;
  recordWriteContext(paths: (string | undefined)[], helperStep: boolean): void;
  clearPendingWriteContext(): void;
  pendingInferenceTracker: {
    flagMissingFiles(relativePath: string, writes: AdditionalWrite[]): Promise<void>;
  };
  filterAdditionalWrites(raw: unknown, normalize: (value: string) => string | undefined): AdditionalWrite[];
  resolveAdditionalWritesRef(action: PythonWriteFileAction): string | undefined;
  runPython(action: string, payload: unknown): Promise<PythonResponse>;
}

interface RewriteGuardConfig {
  maxRemovedLineRatio?: number;
  maxChangedLineRatio?: number;
  minOriginalLineCount?: number;
  reason?: string;
}

const coerceNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const coerceRewriteGuard = (value: unknown): RewriteGuardConfig | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const maxRemovedLineRatio = coerceNumber(record.maxRemovedLineRatio);
  const maxChangedLineRatio = coerceNumber(record.maxChangedLineRatio);
  const minOriginalLineCount = coerceNumber(record.minOriginalLineCount);
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  if (maxRemovedLineRatio === undefined && maxChangedLineRatio === undefined) {
    return undefined;
  }
  return {
    maxRemovedLineRatio,
    maxChangedLineRatio,
    minOriginalLineCount,
    reason
  };
};

const countLines = (value: string): number => value.split(/\r\n|\r|\n/).length;

const formatPercent = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

export function createPythonActionExecutor(deps: PythonActionDeps) {
  async function execute(action: PythonAction, stepId?: string, step?: PlanStep): Promise<StepOutcome> {
    const session = deps.ensureSession();
    const helperMeta = deps.getHelperStepMetadata(step);

    if (action.name === 'scanProject') {
      const payload = {
        root: deps.resolveRootParam(action.params?.rootRef),
        maxDepth: action.params?.maxDepth ?? 5,
        maxFiles: action.params?.maxFiles ?? 400,
        includeExtensions: action.params?.includeExtensions ?? []
      };
      await deps.telemetry.status({
        text: 'Scanning project files…',
        phase: 'progress',
        detail: `Root ${path.basename(payload.root)} (max ${payload.maxFiles} files)`,
        stepId,
        icon: 'search'
      });
      await deps.telemetry.log({
        message: `Scanning project at ${payload.root} (depth ${payload.maxDepth}, max ${payload.maxFiles} files)…`,
        stepId,
        level: 'info'
      });
      const response = await deps.runPython('scanProject', payload);
      if (response.status === 'SUCCESS' && action.storeKey) {
        const storedData = {
          ...(response.data ?? {}),
          root: payload.root
        };
        deps.setContextValue(action.storeKey, storedData);
        deps.setContextValue('project.root', payload.root);
        deps.setContextValue('project.summary', deps.buildProjectSummary(response.data));
      }
      const files = Array.isArray(response.data?.files) ? (response.data?.files as unknown[]) : [];
      if (files.length > 0) {
        const indexedPaths = files.filter((file): file is string => typeof file === 'string');
        if (indexedPaths.length > 0) {
          const stats = await deps.embeddingCache.indexFiles(session.workspaceRoot, indexedPaths);
          deps.setContextValue('project.embeddingStats', { ...stats, total: indexedPaths.length, refreshedAt: Date.now() });
          await deps.telemetry.log({
            message: `Embedding cache hydrated — reused ${stats.reused}, computed ${stats.computed}.`,
            stepId,
            level: 'info'
          });
          await deps.postEmbeddingStatus(stats, indexedPaths.length).catch(() => undefined);
        }
      }
      await deps.telemetry.log({
        message:
          response.status === 'SUCCESS'
            ? `Project scan complete — indexed ${files.length} file${files.length === 1 ? '' : 's'}.`
            : `Project scan failed${response.error ? `: ${response.error}` : ''}`,
        stepId,
        level: response.status === 'SUCCESS' ? 'info' : 'error'
      });
      return {
        ok: response.status === 'SUCCESS',
        output: response.output ?? deps.describeScanResponse(response.data),
        error: response.status === 'FAILED' ? response.error?.toString() : undefined,
        data: response.data ? { storedKey: action.storeKey, ...response.data } : undefined
      };
    }

    if (action.name === 'readFile') {
      const relativePath = deps.getContextValue<string>(action.pathRef);
      if (!relativePath) {
        return { ok: false, error: `Missing path for ${action.pathRef}` };
      }
      const payload = {
        root: session.workspaceRoot,
        path: relativePath,
        encoding: action.encoding ?? 'utf-8'
      };
      const response = await deps.runPython('readFile', payload);
      if (response.status === 'SUCCESS' && action.storeKey) {
        deps.setContextValue(action.storeKey, response.data?.content ?? response.output ?? '');
      }
      const contentText = typeof response.data?.content === 'string' ? response.data.content : undefined;
      const fetchedContent = contentText ?? (typeof response.output === 'string' ? response.output : '');
      if (response.status === 'SUCCESS' && contentText) {
        deps.embeddingManager.scheduleEmbeddingUpsert(relativePath, contentText);
      }
      if (response.status === 'SUCCESS' && action.storeKey === 'focus.primary.content') {
        deps.captureExtractionSection(fetchedContent);
        deps.setContextValue('focus.extract.sourcePath', relativePath);
      }
      return {
        ok: response.status === 'SUCCESS',
        output: response.status === 'SUCCESS' ? `Read ${relativePath}` : undefined,
        error: response.status === 'FAILED' ? response.error?.toString() : undefined,
        data: response.data
          ? {
              storedKey: action.storeKey,
              path: response.data.path,
              bytes: contentText?.length ?? 0,
              sample: contentText ? deps.buildContentSample(contentText) : undefined
            }
          : undefined
      };
    }

    if (action.name === 'writeFile') {
      const contextualPath = action.pathRef ? deps.getContextValue<string>(action.pathRef) : undefined;
      const helperPath = helperMeta?.helperPath;
      const relativePath = helperPath ?? contextualPath;
      const content = deps.getContextValue<string>(action.contentRef);
      const original = action.originalContentRef ? deps.getContextValue<string>(action.originalContentRef) : undefined;
      if (!relativePath || typeof content !== 'string') {
        return { ok: false, error: 'Missing path or content for writeFile action.' };
      }
      const additionalWritesRef = deps.resolveAdditionalWritesRef(action);
      const additionalWritesRaw = additionalWritesRef ? deps.getContextValue<unknown>(additionalWritesRef) : undefined;
      const additionalWrites = deps.filterAdditionalWrites(additionalWritesRaw, (value) => deps.normalizeRelativePath(value));
      if (helperPath && additionalWrites.length > 0) {
        additionalWrites[0] = { ...additionalWrites[0], path: helperPath };
      }
      const requiredFileEntries = Array.isArray(step?.metadata?.requiredFileEntries)
        ? (step?.metadata?.requiredFileEntries as string[])
        : [];
      if (requiredFileEntries.length > 0) {
        const normalizedPrimary = (deps.normalizeRelativePath(relativePath) ?? relativePath).toLowerCase();
        const requiredNormalized = requiredFileEntries
          .map((entry) => deps.normalizeRelativePath(entry) ?? entry)
          .filter((entry): entry is string => Boolean(entry))
          .map((entry) => entry.toLowerCase())
          .filter((entry) => entry !== normalizedPrimary);
        if (requiredNormalized.length > 0) {
          const actualAdditional = new Map<string, string>();
          for (const entry of additionalWrites) {
            const normalizedEntry = deps.normalizeRelativePath(entry.path) ?? entry.path;
            if (!normalizedEntry) {
              continue;
            }
            const contentValue = typeof entry.content === 'string' ? entry.content : '';
            actualAdditional.set(normalizedEntry.toLowerCase(), contentValue);
          }
          const missing = requiredNormalized.filter((entry) => {
            const contentValue = actualAdditional.get(entry);
            if (contentValue === undefined) {
              return true;
            }
            return contentValue.trim().length === 0;
          });
          if (missing.length > 0) {
            return {
              ok: false,
              error: `Missing required additional file writes or content: ${missing.join(', ')}.`
            };
          }
        }
      }
      const dryRun = deps.isPreviewOnly() || deps.isDryRunEnabled();
      const encoding = action.encoding ?? 'utf-8';
      const incremental = typeof original === 'string'
        ? deps.applyIncrementalEdits(original, content, relativePath)
        : { content, replaced: 0, total: 0, confidence: 0.9 };
      let finalContent = incremental.content;
      finalContent = deps.helperManager.applyImportHints(helperMeta, finalContent);
      const baselineOriginal = typeof original === 'string' ? original : '';
      const pendingDiff = await deps.diffManager.registerPendingDiff(
        relativePath,
        baselineOriginal,
        finalContent,
        incremental.confidence
      );
      const shouldWritePrimary = pendingDiff.changed !== false;
      let backupPath: string | undefined;
      let preWriteState: FilePreWriteState | undefined;
      if (shouldWritePrimary && !dryRun && typeof original === 'string') {
        try {
          backupPath = await deps.undoManager.createBackup(session.workspaceRoot, relativePath, original);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await deps.telemetry.log({
            message: `Backup failed for ${relativePath}: ${message}`,
            level: 'warn'
          });
        }
      }

      const diffText: string | undefined = pendingDiff.diff;
      let diffSummary: { added: number; removed: number } | undefined = pendingDiff.summary;
      if (diffText === undefined) {
        return { ok: false, error: `Unable to compute diff for ${relativePath}. Aborting write.` };
      }
      const summaryForLog = diffSummary ?? { added: 0, removed: 0 };
      diffSummary = summaryForLog;
      await deps.telemetry.log({
        message: `Diff summary for ${relativePath}: +${summaryForLog.added} / -${summaryForLog.removed}${pendingDiff.confidence ? ` (confidence ${(100 * pendingDiff.confidence).toFixed(1)}%)` : ''}`,
        level: 'info'
      });
      if (action.diffStoreKey) {
        deps.setContextValue(action.diffStoreKey, diffText);
      }
      const rewriteGuard = coerceRewriteGuard(step?.metadata?.rewriteGuard);
      if (rewriteGuard && shouldWritePrimary && typeof original === 'string') {
        const originalLineCount = countLines(original);
        if (!rewriteGuard.minOriginalLineCount || originalLineCount >= rewriteGuard.minOriginalLineCount) {
          const baselineLines = Math.max(1, originalLineCount);
          const removedRatio = summaryForLog.removed / baselineLines;
          const changedRatio = (summaryForLog.added + summaryForLog.removed) / baselineLines;
          const violations: string[] = [];
          if (
            rewriteGuard.maxRemovedLineRatio !== undefined
            && removedRatio > rewriteGuard.maxRemovedLineRatio
          ) {
            violations.push(
              `removed ${formatPercent(removedRatio)} of lines (max ${formatPercent(rewriteGuard.maxRemovedLineRatio)})`
            );
          }
          if (
            rewriteGuard.maxChangedLineRatio !== undefined
            && changedRatio > rewriteGuard.maxChangedLineRatio
          ) {
            violations.push(
              `changed ${formatPercent(changedRatio)} of lines (max ${formatPercent(rewriteGuard.maxChangedLineRatio)})`
            );
          }
          if (violations.length > 0) {
            const reason = rewriteGuard.reason ? ` (${rewriteGuard.reason})` : '';
            return {
              ok: false,
              error: `Rewrite guard blocked update for ${relativePath}${reason}: ${violations.join('; ')}.`
            };
          }
        }
      }

      if (!shouldWritePrimary) {
        await deps.telemetry.status({
          text: `No changes detected for ${relativePath}`,
          phase: 'progress',
          detail: 'Skipping disk write because the file is unchanged.',
          stepId,
          icon: 'code'
        });
      }

      if (!dryRun && shouldWritePrimary) {
        preWriteState = await deps.undoManager.capturePreWriteState(
          session.workspaceRoot,
          relativePath,
          encoding,
          original
        );
      }

      let response: PythonResponse = { status: 'SUCCESS', data: { path: relativePath } };
      if (dryRun) {
        await deps.telemetry.status({
          text: `Dry run prepared for ${relativePath}`,
          phase: 'progress',
          detail: 'Changes staged for review without writing to disk.',
          stepId,
          icon: 'code'
        });
      } else if (shouldWritePrimary) {
        const payload = {
          root: session.workspaceRoot,
          path: relativePath,
          content: finalContent,
          encoding
        };
        response = await deps.runPython('writeFile', payload);
      }

      const ok = response.status === 'SUCCESS';

      if (!dryRun && ok && preWriteState) {
        deps.undoManager.recordSnapshot({
          path: relativePath,
          absolutePath: preWriteState.absolutePath,
          before: preWriteState.before,
          after: finalContent,
          encoding,
          timestamp: Date.now(),
          existedBefore: preWriteState.existedBefore
        });
      }

      if (ok && !dryRun && shouldWritePrimary) {
        deps.embeddingManager.scheduleEmbeddingUpsert(relativePath, finalContent);
      }

      const bytesWritten = shouldWritePrimary ? Buffer.byteLength(finalContent, encoding) : 0;
      let additionalWriteDetails: Array<Record<string, unknown>> = [];
      if (additionalWrites.length > 0) {
        additionalWriteDetails = await deps.additionalWriteManager.applyAdditionalWrites({
          workspaceRoot: session.workspaceRoot,
          writes: additionalWrites,
          encoding,
          dryRun,
          stepId
        });
        if (additionalWritesRef) {
          deps.setContextValue(additionalWritesRef, []);
        }
      }
      if (!dryRun) {
        if (ok) {
          const extraPaths = additionalWriteDetails
            .map((entry) => (typeof entry.path === 'string' ? entry.path : undefined))
            .filter((value): value is string => Boolean(value));
          deps.recordWriteContext([relativePath, ...extraPaths], Boolean(helperMeta));
        } else {
          deps.clearPendingWriteContext();
        }
      } else {
        deps.clearPendingWriteContext();
      }
      if (!dryRun) {
        await deps.pendingInferenceTracker.flagMissingFiles(relativePath, additionalWrites);
      }
      return {
        ok,
        output: ok ? (dryRun ? `Prepared dry run for ${relativePath}` : `Wrote ${relativePath}`) : undefined,
        error: ok ? undefined : response.error?.toString(),
        data: {
          ...(response.data ?? {}),
          diff: diffText,
          diffSummary,
          backupPath,
          backupContent: typeof original === 'string' ? original : undefined,
          path: relativePath,
          dryRun,
          astEdits: {
            replaced: incremental.replaced,
            total: incremental.total,
            confidence: incremental.confidence
          },
          bytesWritten,
          additionalWrites: additionalWriteDetails
        }
      };
    }

    if (action.name === 'runCommand') {
      const payload = {
        command: action.command,
        cwd: deps.resolveRootParam(action.cwdRef),
        root: session.workspaceRoot
      };
      const response = await deps.runPython('runCommand', payload);
      const ok = response.status === 'SUCCESS' || Boolean(action.allowFailure);
      return {
        ok,
        output: response.output,
        error: response.status === 'FAILED' ? response.error?.toString() : undefined,
        data: {
          code: response.code,
          status: response.status
        }
      };
    }

    return { ok: false, error: 'Unsupported python action.' };
  }

  return { execute };
}

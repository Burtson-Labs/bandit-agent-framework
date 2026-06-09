import * as path from 'path';
import type { Plan, ExecutionResult, PlanStep } from '../internalTypes';
import type { InternalReviewDiffAction, LlmRewriteAction, PythonWriteFileAction } from '../internalTypes';
import type {
  ITelemetry,
  StepOutcome,
  HelperStepMetadata,
  IDiffManager,
  ValidationOutcome
} from '../internalTypes';
import type { IHelperManager } from '../internalTypes';
import type { ProviderSettings, ProviderKind, ChatProvider } from '../internalTypes';
import type { AIChatRequest } from '../internalTypes';
import type { TaskQueue, TaskQueueOptions } from '../internalTypes';
import type { PersistenceManager } from './persistence';
import { parseCompilerOutput, type Diagnostic, type DiagnosticEventPayload } from './diagnostics';
import type { EventBus } from '../internalTypes';
import type { TypeCheckRunResult, TypeCheckRunner } from './typeCheckRunner';

export interface AutoRevisionConfig {
  maxIterations: number;
  confidenceTarget: number;
}

export interface HealingEngineDeps {
  telemetry: ITelemetry;
  diffManager: IDiffManager;
  helperManager: IHelperManager;
  rewriteEngine: {
    createMissingHelperFiles(goal: string, files: string[]): Promise<string[]>;
  };
  pendingInferenceTracker: {
    resolvePendingFiles(): Promise<string[]>;
  };
  runProjectTypeCheck: TypeCheckRunner['runProjectTypeCheck'];
  isDryRun(): boolean;
  getRunOptions(): { previewOnly?: boolean };
  ensureSession(): { workspaceRoot: string; goal: string };
  getContextValue<T>(key: string): T | undefined;
  setContextValue(key: string, value: unknown): void;
  readWorkspaceFile(path: string): Promise<string>;
  generateRewrite(
    goal: string,
    relativePath: string,
    currentContent: string,
    projectSummary: string,
    instructions?: string
  ): Promise<StepOutcome>;
  executePythonStep(
    action: PythonWriteFileAction,
    stepId?: string,
    step?: PlanStep
  ): Promise<StepOutcome>;
  emitHelperTelemetry(meta: HelperStepMetadata, outcome: StepOutcome): Promise<void>;
  getHelperStepMetadata(step?: PlanStep): HelperStepMetadata | undefined;
  clampDiffPreview(diff: string, maxLines?: number): string;
  buildContentSample(content: string, maxLines?: number, maxLength?: number): string;
  truncateText(value: string, max?: number): string;
  summarizeDiff(diff: string): { added: number; removed: number };
  stripCodeFences(content: string): string;
  getRewriteHint(relativePath: string): string | undefined;
  normalizeRelativePath(value: string): string | undefined;
  getProviderKind(): ProviderKind;
  getModel(providerKind: ProviderKind): string;
  buildProviderSettings(apiKey: string): ProviderSettings;
  getTopP(): number | undefined;
  fetchSecret(key: string): PromiseLike<string | undefined>;
  createProvider(settings: ProviderSettings): Promise<ChatProvider>;
  createTaskQueue(options?: TaskQueueOptions): TaskQueue;
  persistence: PersistenceManager;
  buildExecutionResult(stepId: string, outcome: StepOutcome, startedAt: number): ExecutionResult;
  getProjectSummary(): string;
  isCancelled(): boolean;
  eventBus: EventBus;
}

export interface HealingEngine {
  reviewDiff(action: InternalReviewDiffAction, step?: PlanStep): Promise<StepOutcome>;
  autoReviseFromReview(
    goal: string,
    plan: Plan,
    results: ExecutionResult[],
    config: AutoRevisionConfig
  ): Promise<{ results: ExecutionResult[]; iterations: number; retryStepId?: string }>;
}

const API_KEY_SECRET_KEY = 'banditStealth.apiKey';
const MAX_DIAGNOSTIC_FILES = 5;

export function createHealingEngine(deps: HealingEngineDeps): HealingEngine {
  const queue = deps.createTaskQueue({ maxRetries: 2, baseDelayMs: 1000 });
  const pendingDiagnostics: DiagnosticEventPayload[] = [];
  let diagnosticsInFlight = false;

  deps.eventBus.on('diagnostics:errors', (payload: DiagnosticEventPayload) => {
    if (!payload || !Array.isArray(payload.diagnostics) || payload.diagnostics.length === 0) {
      return;
    }
    pendingDiagnostics.push(payload);
    if (!diagnosticsInFlight) {
      diagnosticsInFlight = true;
      void (async () => {
        try {
          while (pendingDiagnostics.length > 0) {
            const next = pendingDiagnostics.shift();
            if (!next) {
              continue;
            }
            await processDiagnosticsEvent(next);
          }
        } catch (error) {
          await deps.telemetry.log({
            level: 'error',
            message: `Diagnostic healing failed: ${error instanceof Error ? error.message : String(error)}`
          });
        } finally {
          diagnosticsInFlight = false;
        }
      })();
    }
  });

  async function autoReviseFromReview(
    goal: string,
    plan: Plan,
    results: ExecutionResult[],
    config: AutoRevisionConfig
  ): Promise<{ results: ExecutionResult[]; iterations: number; retryStepId?: string }> {
    if (deps.getRunOptions().previewOnly) {
      return { results: [], iterations: 0 };
    }
    if (deps.isDryRun()) {
      await deps.telemetry.log({
        message: 'Auto revision skipped — dry run mode active.',
        level: 'warn'
      });
      return { results: [], iterations: 0 };
    }
    const latestReview = getLatestReviewResult(results);
    if (!latestReview || !latestReview.needsRevision) {
      return { results: [], iterations: 0 };
    }

    const rewriteStep = plan.steps.find((step) => step.action.type === 'llmRewrite');
    const writeStep = plan.steps.find((step) => step.action.type === 'python' && step.action.name === 'writeFile');
    const reviewStep = plan.steps.find((step) => step.action.type === 'internal' && step.action.name === 'reviewDiff');

    if (
      !rewriteStep
      || rewriteStep.action.type !== 'llmRewrite'
      || !writeStep
      || writeStep.action.type !== 'python'
      || writeStep.action.name !== 'writeFile'
      || !reviewStep
      || reviewStep.action.type !== 'internal'
      || reviewStep.action.name !== 'reviewDiff'
    ) {
      await deps.telemetry.log({
        message: 'Auto revision skipped — required plan steps unavailable.',
        level: 'warn'
      });
      return { results: [], iterations: 0 };
    }

    const rewriteAction = rewriteStep.action as LlmRewriteAction;
    const writeAction = writeStep.action as PythonWriteFileAction;
    const reviewAction = reviewStep.action as InternalReviewDiffAction;

    const session = deps.ensureSession();
    const relativePath =
      (typeof latestReview.path === 'string' && latestReview.path)
      || deps.getContextValue<string>(rewriteAction.pathRef)
      || deps.getContextValue<string>(writeAction.pathRef)
      || deps.getContextValue<string>('focus.primary.path');

    if (!relativePath) {
      await deps.telemetry.log({
        message: 'Auto revision skipped — target path unresolved.',
        level: 'warn'
      });
      return { results: [], iterations: 0 };
    }

    const extras: ExecutionResult[] = [];
    let iteration = 0;
    let pendingReviewText = latestReview.review ?? '';
    const projectSummary = deps.getProjectSummary();
    const maxIterations = Math.max(0, Math.floor(config.maxIterations));

    if (maxIterations <= 0) {
      await deps.telemetry.log({
        message: 'Auto revision skipped — max iterations set to 0.',
        level: 'warn'
      });
      return { results: [], iterations: 0 };
    }

    while (!deps.isCancelled() && iteration < maxIterations) {
      iteration += 1;
      await deps.telemetry.status({ text: `Auto revision ${iteration}`, phase: 'start', icon: 'code' });
      await deps.persistence.save(session.workspaceRoot, {
        planId: plan.goal ?? goal,
        goal,
        currentStep: iteration,
        pendingDiffs: [relativePath],
        metadata: {
          pendingReview: pendingReviewText
        }
      });

      const rewriteTask = await queue.enqueue({
        id: `healing-rewrite-${iteration}`,
        run: async () => {
          let currentContent = '';
          try {
            const absolutePath = path.join(session.workspaceRoot, relativePath);
            currentContent = await deps.readWorkspaceFile(absolutePath);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              outcome: { ok: false, error: `Unable to read ${relativePath}: ${message}` },
              startedAt: Date.now()
            };
          }

          const rewriteInstructions = composeRevisionInstructions(
            rewriteAction.instructions,
            pendingReviewText,
            relativePath,
            deps.getRewriteHint
          );
          const rewriteOutcome = await deps.generateRewrite(
            goal,
            relativePath,
            currentContent,
            projectSummary,
            rewriteInstructions
          );
          return { outcome: rewriteOutcome, startedAt: Date.now() };
        }
      });

      const rewriteResult = deps.buildExecutionResult(
        `auto-rewrite-${iteration}`,
        rewriteTask.outcome,
        rewriteTask.startedAt
      );
      extras.push(rewriteResult);

      if (!rewriteTask.outcome.ok) {
        await deps.telemetry.status({
          text: `Auto revision ${iteration} failed to draft changes`,
          phase: 'error',
          detail: rewriteTask.outcome.error ?? rewriteTask.outcome.output,
          icon: 'warn'
        });
        break;
      }

      const newContent = (rewriteTask.outcome.data as { content?: string } | undefined)?.content;
      if (!newContent || !newContent.trim()) {
        await deps.telemetry.status({
          text: `Auto revision ${iteration} failed to draft changes`,
          phase: 'error',
          detail: 'Rewrite result was empty.',
          icon: 'warn'
        });
        break;
      }

      deps.setContextValue(rewriteAction.outputKey, newContent);
      if (writeAction.contentRef) {
        deps.setContextValue(writeAction.contentRef, newContent);
      }

      const writeTask = await queue.enqueue({
        id: `healing-apply-${iteration}`,
        run: async () => {
          const startedAt = Date.now();
          const outcome = await deps.executePythonStep({ ...writeAction }, `auto-apply-${iteration}`);
          return { outcome, startedAt };
        }
      });
      const writeResult = deps.buildExecutionResult(
        `auto-apply-${iteration}`,
        writeTask.outcome,
        writeTask.startedAt
      );
      extras.push(writeResult);

      if (!writeTask.outcome.ok) {
        await deps.telemetry.status({
          text: `Auto revision ${iteration} failed to apply changes`,
          phase: 'error',
          detail: writeTask.outcome.error ?? writeTask.outcome.output,
          icon: 'warn'
        });
        break;
      }

      const reviewTask = await queue.enqueue({
        id: `healing-review-${iteration}`,
        run: async () => {
          const startedAt = Date.now();
          const outcome = await reviewDiff(reviewAction, undefined);
          return { outcome, startedAt };
        }
      });
      const reviewResult = deps.buildExecutionResult(
        `auto-review-${iteration}`,
        reviewTask.outcome,
        reviewTask.startedAt
      );
      extras.push(reviewResult);

      const reviewData = (reviewTask.outcome.data ?? {}) as { review?: unknown; needsRevision?: unknown };
      const reviewText = typeof reviewData.review === 'string' ? reviewData.review : '';
      const needsAnotherPass = typeof reviewData.needsRevision === 'boolean'
        ? reviewData.needsRevision
        : reviewIndicatesIssues(reviewText);

      if (!needsAnotherPass) {
        await deps.telemetry.status({
          text: `Auto revision ${iteration} complete`,
          phase: 'complete',
          detail: 'Review approved.',
          icon: 'success'
        });
        await deps.persistence.clear(session.workspaceRoot);
        return { results: extras, iterations: iteration, retryStepId: reviewStep.id };
      }

      pendingReviewText = reviewText;
      if (!pendingReviewText.trim()) {
        await deps.telemetry.status({
          text: `Auto revision ${iteration} halted`,
          phase: 'error',
          detail: 'Review feedback unavailable; stopping auto-fixes.',
          icon: 'warn'
        });
        break;
      }

      await deps.telemetry.status({
        text: `Auto revision ${iteration} requires follow-up`,
        phase: 'progress',
        detail: deps.truncateText(pendingReviewText, 200),
        icon: 'review'
      });
    }

    await deps.persistence.clear(session.workspaceRoot);
    return { results: extras, iterations: iteration };
  }

  async function processDiagnosticsEvent(payload: DiagnosticEventPayload): Promise<void> {
    if (deps.isDryRun() || deps.getRunOptions().previewOnly) {
      return;
    }
    const session = deps.ensureSession();
    const workspaceRoot = session.workspaceRoot;
    const goal = payload.goal ?? session.goal;
    const grouped = groupDiagnosticsByFile(payload.diagnostics, workspaceRoot, deps.normalizeRelativePath);
    if (!grouped.length) {
      return;
    }
    const touchedSet = buildTouchedFileSet(payload.touchedFiles, deps.normalizeRelativePath);
    const { actionable, ambient } = partitionDiagnosticsByScope(grouped, touchedSet);
    if (ambient.length > 0) {
      const ambientFiles = ambient.map(([file]) => file);
      await deps.telemetry.log({
        level: 'info',
        message: `Ambient diagnostics ignored (${payload.source ?? 'diagnostics'}): ${ambientFiles.join(', ')}`
      });
    }
    if (actionable.length === 0) {
      return;
    }
    const limited = actionable.slice(0, MAX_DIAGNOSTIC_FILES);
    const tasks = limited
      .slice()
      .reverse()
      .map(([file, diagnostics]) =>
        queue.prepend({
          id: `diagnostic-repair-${file}-${Date.now()}`,
          run: async () => {
            const startedAt = Date.now();
            const outcome = await applyDiagnosticRepairs(goal, file, diagnostics, workspaceRoot);
            return { outcome, startedAt };
          }
        })
      );
    await Promise.all(tasks);
    await deps.eventBus.emit('compile:retry', {
      source: payload.source ?? 'diagnostics',
      files: limited.map(([file]) => file)
    });
  }

  async function applyDiagnosticRepairs(
    goal: string,
    relativePath: string,
    diagnostics: Diagnostic[],
    workspaceRoot: string
  ): Promise<StepOutcome> {
    const absolutePath = path.join(workspaceRoot, relativePath);
    let currentContent = '';
    try {
      currentContent = await deps.readWorkspaceFile(absolutePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.telemetry.log({
        level: 'warn',
        message: `Diagnostic repair skipped for ${relativePath}: ${message}`
      });
      return { ok: false, error: message };
    }
    const instructions = buildDiagnosticInstructions(goal, relativePath, diagnostics);
    const rewriteOutcome = await deps.generateRewrite(
      goal,
      relativePath,
      currentContent,
      deps.getProjectSummary(),
      instructions
    );
    if (!rewriteOutcome.ok || typeof rewriteOutcome.data?.content !== 'string') {
      return rewriteOutcome;
    }
    const updatedContent = rewriteOutcome.data.content;
    if (!updatedContent.trim() || updatedContent.trim() === currentContent.trim()) {
      return {
        ok: false,
        error: `Diagnostic rewrite returned no changes for ${relativePath}.`,
        data: { diagnostics }
      };
    }
    const pathRef = createContextKey('diagnostics.path');
    const contentRef = createContextKey('diagnostics.content');
    const originalRef = createContextKey('diagnostics.original');
    deps.setContextValue(pathRef, relativePath);
    deps.setContextValue(contentRef, updatedContent);
    deps.setContextValue(originalRef, currentContent);
    const writeOutcome = await deps.executePythonStep(
      {
        type: 'python',
        name: 'writeFile',
        pathRef,
        contentRef,
        encoding: 'utf-8',
        originalContentRef: originalRef
      },
      `diagnostic-write-${relativePath}`
    );
    if (!writeOutcome.ok) {
      return writeOutcome;
    }
    await deps.telemetry.log({
      level: 'info',
      message: `Diagnostic repair applied to ${relativePath}.`
    });
    return {
      ...writeOutcome,
      data: {
        ...(writeOutcome.data ?? {}),
        diagnostics
      }
    };
  }

  async function reviewDiff(action: InternalReviewDiffAction, step?: PlanStep): Promise<StepOutcome> {
    const session = deps.ensureSession();
    const helperMeta = deps.getHelperStepMetadata(step);
    const isHelperReview = helperMeta?.role === 'review';
    const relativePath =
      (action.pathRef ? deps.getContextValue<string>(action.pathRef) : undefined)
      ?? deps.getContextValue<string>('focus.primary.path');
    const touchedContextValue = action.touchedFilesRef ? deps.getContextValue(action.touchedFilesRef) : undefined;
    const touchedFiles = resolveTouchedFiles(relativePath, touchedContextValue, deps.normalizeRelativePath);

    let diff =
      (action.diffRef ? deps.getContextValue<string>(action.diffRef) : undefined)
      ?? deps.getContextValue<string>('focus.primary.diff');

    let original =
      (action.originalContentRef ? deps.getContextValue<string>(action.originalContentRef) : undefined)
      ?? (isHelperReview ? undefined : deps.getContextValue<string>('focus.primary.content'));

    let updated =
      (action.updatedContentRef ? deps.getContextValue<string>(action.updatedContentRef) : undefined)
      ?? deps.getContextValue<string>('focus.primary.rewrite');

    if (isHelperReview && (!original || original.trim().length === 0)) {
      if (relativePath) {
        try {
          const target = path.join(session.workspaceRoot, relativePath);
          original = await deps.readWorkspaceFile(target);
        } catch {
          original = '';
        }
      } else {
        original = '';
      }
    }

    let pending = relativePath ? deps.diffManager.getPendingDiff(relativePath) : undefined;
    if (
      !diff
      && relativePath
      && pending
      && typeof pending.original === 'string'
      && typeof pending.updated === 'string'
    ) {
      pending = await deps.diffManager.registerPendingDiff(
        relativePath,
        pending.original,
        pending.updated,
        pending.confidence
      );
      diff = pending?.diff ?? diff;
    }
    if (!diff && pending?.diff) {
      diff = pending.diff;
    }
    if (!updated && pending?.updated) {
      updated = pending.updated;
    }

    if (
      !diff
      && relativePath
      && typeof original === 'string'
      && typeof updated === 'string'
    ) {
      pending = await deps.diffManager.registerPendingDiff(
        relativePath,
        original,
        updated,
        pending?.confidence
      );
      diff = pending?.diff ?? diff;
    }

    if (!diff) {
      return { ok: false, error: 'Diff unavailable for review.' };
    }

    if ((!updated || updated.trim().length === 0) && relativePath) {
      try {
        const target = path.join(session.workspaceRoot, relativePath);
        updated = await deps.readWorkspaceFile(target);
      } catch {
        // ignore read failures — we can still review using the diff
      }
    }

    if (action.touchedFilesRef) {
      if (touchedFiles.length > 0) {
        deps.setContextValue(action.touchedFilesRef, touchedFiles);
      } else {
        deps.setContextValue(action.touchedFilesRef, undefined);
      }
    }

    const goalText = session.goal ?? 'No goal supplied.';
    const shouldAttemptHelperCreation = !deps.getRunOptions().previewOnly && !deps.isDryRun();
    const outstandingBeforeReview = await deps.pendingInferenceTracker.resolvePendingFiles();
    if (outstandingBeforeReview.length > 0) {
      if (shouldAttemptHelperCreation) {
        const createdHelpers = await deps.rewriteEngine.createMissingHelperFiles(goalText, outstandingBeforeReview);
        if (createdHelpers.length > 0) {
          const remaining = await deps.pendingInferenceTracker.resolvePendingFiles();
          if (remaining.length > 0) {
            const missingMessage = `Required helper files were not created: ${remaining.join(', ')}`;
            return {
              ok: false,
              error: missingMessage,
              data: {
                missingFiles: remaining,
                needsRevision: true,
                review: missingMessage,
                path: relativePath
              }
            };
          }
        } else {
          const missingMessage = `Required helper files were not created: ${outstandingBeforeReview.join(', ')}`;
          return {
            ok: false,
            error: missingMessage,
            data: {
              missingFiles: outstandingBeforeReview,
              needsRevision: true,
              review: missingMessage,
              path: relativePath
            }
          };
        }
      } else {
        const missingMessage = `Required helper files were not created: ${outstandingBeforeReview.join(', ')}`;
        return {
          ok: false,
          error: missingMessage,
          data: {
            missingFiles: outstandingBeforeReview,
            needsRevision: true,
            review: missingMessage,
            path: relativePath
          }
        };
      }
    }

    const providerKind = deps.getProviderKind();
    const apiKey = providerKind === 'bandit' ? await deps.fetchSecret(API_KEY_SECRET_KEY) : '';

    if (providerKind === 'bandit' && !apiKey) {
      return { ok: false, error: 'Bandit API key required to review changes.' };
    }

    const provider = await deps.createProvider(deps.buildProviderSettings(apiKey ?? ''));
    const diffPreview = deps.clampDiffPreview(diff, 320);
    const originalSample = typeof original === 'string' ? deps.buildContentSample(original, 24, 2400) : 'Unavailable';
    const updatedSample = typeof updated === 'string' ? deps.buildContentSample(updated, 24, 2400) : 'Unavailable';

    const messages: AIChatRequest['messages'] = [
      {
        role: 'system',
        content: [
          'You are a meticulous senior engineer performing code review for a teammate.',
          'Inspect the provided diff and call out any risks, regressions, missing edge cases, accessibility issues, or style inconsistencies.',
          'If everything looks correct, reply with “LGTM — no issues found.”',
          'Respond using Markdown bullets when noting findings.'
        ].join(' ')
      },
      {
        role: 'user',
        content: [
          `Goal: ${goalText}`,
          `File: ${relativePath ?? 'unknown'}`,
          '',
          'Diff:',
          '```diff',
          diffPreview,
          '```',
          '',
          'Original sample:',
          '```',
          originalSample,
          '```',
          '',
          'Updated sample:',
          '```',
          updatedSample,
          '```'
        ].join('\n')
      }
    ];

    const request: AIChatRequest = {
      model: deps.getModel(providerKind),
      messages,
      temperature: 0.1,
      stream: true
    };

    const topP = deps.getTopP();
    if (typeof topP === 'number' && !Number.isNaN(topP)) {
      request.options = { top_p: topP };
    }

    let reviewText = '';
    try {
      let buffer = '';
      for await (const chunk of provider.chat(request)) {
        if (deps.isCancelled()) {
          throw new Error('Cancelled');
        }
        const content = chunk?.message?.content ?? '';
        if (content) {
          buffer += content;
        }
        if (chunk?.done) {
          break;
        }
      }
      reviewText = buffer.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reviewText = `Review unavailable: ${message}`;
    }

    const normalizedReview = deps.stripCodeFences(reviewText).trim() || 'Review unavailable.';
    let needsRevision = reviewIndicatesIssues(normalizedReview);
    const validationNotes: string[] = [];
    let diagnosticsTriggeredFailure = false;
    let validationResult: TypeCheckRunResult | undefined;
    let helperValidation: StepOutcome | undefined;
    const contextDiagnostics = action.diagnosticsRef
      ? coerceDiagnostics(deps.getContextValue(action.diagnosticsRef))
      : [];
    let relatedDiagnostics: Diagnostic[] = [];
    let unrelatedDiagnostics: Diagnostic[] = [];
    if (contextDiagnostics.length > 0) {
      const partitioned = partitionDiagnosticsForTouched(contextDiagnostics, touchedFiles, deps.normalizeRelativePath);
      relatedDiagnostics = mergeDiagnosticLists(relatedDiagnostics, partitioned.related);
      unrelatedDiagnostics = mergeDiagnosticLists(unrelatedDiagnostics, partitioned.unrelated);
    }
    if (!deps.getRunOptions().previewOnly && !deps.isDryRun()) {
      const preferredTargets = touchedFiles.length > 0 ? touchedFiles : relativePath ? [relativePath] : undefined;
      validationResult = await deps.runProjectTypeCheck({
        files: preferredTargets,
        validateOnlyThesePaths: preferredTargets
      });
      if (validationResult) {
        const validationTouched = preferredTargets ?? validationResult.touchedFiles ?? touchedFiles;
        const partitioned = partitionDiagnosticsForTouched(
          validationResult.diagnostics ?? [],
          validationTouched,
          deps.normalizeRelativePath
        );
        const existingIgnored = Array.isArray(validationResult.ignoredDiagnostics)
          ? [...validationResult.ignoredDiagnostics]
          : [];
        validationResult.diagnostics = partitioned.related;
        validationResult.ignoredDiagnostics = mergeDiagnosticLists(existingIgnored, partitioned.unrelated);
        relatedDiagnostics = mergeDiagnosticLists(relatedDiagnostics, partitioned.related);
        unrelatedDiagnostics = mergeDiagnosticLists(unrelatedDiagnostics, validationResult.ignoredDiagnostics ?? []);
        if (!validationResult.ok) {
          if (partitioned.related.length === 0) {
            const ignoredNote = validationResult.note
              ?? 'Unrelated TypeScript errors exist elsewhere in the project; ignoring them for this review.';
            validationNotes.push(ignoredNote);
            appendValidationFinalNote(validationResult, 'complete', ignoredNote);
            validationResult.ok = true;
          } else {
            needsRevision = true;
            const blockingNote = 'Blocking TypeScript errors remain in this file. See buildValidation.output for diagnostics.';
            validationNotes.push(blockingNote);
            appendValidationFinalNote(validationResult, 'best-effort', blockingNote);
            diagnosticsTriggeredFailure = true;
            await deps.eventBus.emit('diagnostics:errors', {
              goal: session.goal,
              source: 'typecheck',
              diagnostics: partitioned.related,
              rawOutput: validationResult.rawOutput ?? validationResult.output,
              touchedFiles: validationTouched
            });
          }
        } else if (
          (validationResult.note && validationResult.note.trim().length > 0)
          || (validationResult.ignoredDiagnostics?.length ?? 0) > 0
        ) {
          const ignoredNote = validationResult.note
            ?? 'Unrelated TypeScript errors exist elsewhere in the project; ignoring them for this review.';
          validationNotes.push(ignoredNote);
          appendValidationFinalNote(validationResult, 'complete', ignoredNote);
        }
      }
    }
    if (helperMeta?.role === 'review') {
      if (!deps.getRunOptions().previewOnly && !deps.isDryRun()) {
        helperValidation = await deps.helperManager.validate(helperMeta);
        await deps.emitHelperTelemetry(helperMeta, helperValidation);
        if (!helperValidation.ok) {
          const failureSummary = deps.truncateText(helperValidation.error ?? 'Helper validation failed.', 1600);
          needsRevision = true;
          const helperData = helperValidation.data as { typeCheck?: unknown } | undefined;
          const typeCheckOutput = typeof helperData?.typeCheck === 'string' ? helperData.typeCheck : undefined;
          validationResult = { ok: false, output: typeCheckOutput ?? failureSummary };
          const helperDiagnostics = typeCheckOutput ? parseCompilerOutput(typeCheckOutput) : [];
          if (helperDiagnostics.length > 0) {
            const helperPartition = partitionDiagnosticsForTouched(helperDiagnostics, touchedFiles, deps.normalizeRelativePath);
            relatedDiagnostics = mergeDiagnosticLists(relatedDiagnostics, helperPartition.related);
            unrelatedDiagnostics = mergeDiagnosticLists(unrelatedDiagnostics, helperPartition.unrelated);
            if (helperPartition.related.length > 0) {
              await deps.eventBus.emit('diagnostics:errors', {
                goal: session.goal,
                source: 'helper-typecheck',
                diagnostics: helperPartition.related,
                rawOutput: typeCheckOutput,
                touchedFiles
              });
              appendValidationFinalNote(validationResult, 'best-effort', 'Helper validation reported blocking errors.');
              diagnosticsTriggeredFailure = true;
            }
          }
          const helperFailureNote = `Helper validation failed: ${failureSummary}`;
          validationNotes.push(helperFailureNote);
          appendValidationFinalNote(validationResult, 'best-effort', helperFailureNote);
        }
      } else {
        helperValidation = { ok: true, data: { skipped: true } };
        await deps.emitHelperTelemetry(helperMeta, helperValidation);
      }
    }
    if (relatedDiagnostics.length === 0 && unrelatedDiagnostics.length > 0) {
      const unrelatedNote = 'Unrelated diagnostics detected outside the edited file — ignoring them for this review.';
      if (!validationNotes.includes(unrelatedNote)) {
        validationNotes.push(unrelatedNote);
      }
      if (validationResult) {
        appendValidationFinalNote(validationResult, 'complete', unrelatedNote);
      }
    }
    if (action.diagnosticsRef) {
      const combinedDiagnostics = [...relatedDiagnostics, ...unrelatedDiagnostics];
      if (combinedDiagnostics.length > 0) {
        deps.setContextValue(action.diagnosticsRef, combinedDiagnostics);
      } else {
        deps.setContextValue(action.diagnosticsRef, undefined);
      }
    }
    if (validationResult?.finalNotes?.length) {
      validationResult.finalNotes.forEach((note) => {
        if (note && note.trim().length > 0 && !validationNotes.includes(note)) {
          validationNotes.push(note);
        }
      });
    }
    if (action.storeKey) {
      deps.setContextValue(action.storeKey, normalizedReview);
    }

    const headlineSource = normalizedReview.split('\n').find((line) => line.trim().length > 0) ?? normalizedReview;
    const trimmedHeadline = headlineSource.trim();
    const headline = needsRevision
      ? `Review findings — ${trimmedHeadline.length > 0 ? deps.truncateText(trimmedHeadline, 96) : 'Follow-up required.'}`
      : 'Review complete — no issues flagged.';

    const summary = pending?.summary ?? (diff ? deps.summarizeDiff(diff) : { added: 0, removed: 0 });
    const confidence = pending?.confidence ?? 0.85;
    await deps.telemetry.log({
      message: `Review diff for ${relativePath ?? 'updated file'} — +${summary.added} / -${summary.removed} (confidence ${(confidence * 100).toFixed(1)}%)`,
      level: needsRevision ? 'warn' : 'info'
    });
    if (relativePath && !pending && (typeof original === 'string' || typeof updated === 'string')) {
      pending = await deps.diffManager.registerPendingDiff(
        relativePath,
        original ?? '',
        updated ?? '',
        confidence
      );
    }

    const errorMessage = needsRevision
      ? diagnosticsTriggeredFailure
        ? validationNotes[0] ?? 'Blocking errors present in this file.'
        : normalizedReview
      : undefined;

    return {
      ok: !needsRevision,
      output: headline,
      error: errorMessage,
      data: {
        path: relativePath,
        review: normalizedReview,
        reviewSummary: normalizedReview,
        needsRevision,
        buildValidation: validationResult,
        helper: helperMeta
          ? {
              id: helperMeta.helperId,
              path: helperMeta.helperPath,
              role: helperMeta.role
            }
          : undefined,
        helperValidation: helperValidation?.data,
        validationNotes,
        diff,
        diffSummary: summary,
        confidence
      }
    };
  }

  return { autoReviseFromReview, reviewDiff };
}

function composeRevisionInstructions(
  baseInstructions: string | undefined,
  reviewFeedback: string,
  relativePath: string,
  getRewriteHint: (path: string) => string | undefined
): string {
  const trimmedBase = (baseInstructions ?? 'Rewrite the file to satisfy the goal.').trim();
  const trimmedReview = reviewFeedback.trim();
  if (!trimmedReview) {
    const hint = getRewriteHint(relativePath);
    const hintSection = hint ? `\n\nCompiler feedback for ${relativePath}:\n${hint}` : '';
    return `${trimmedBase}\n\nEnsure the updated file fully satisfies the user goal and resolves any gaps noted during review.${hintSection}`;
  }
  const boundedReview = trimmedReview.length > 2000 ? `${trimmedReview.slice(0, 2000)}…` : trimmedReview;
  const hint = getRewriteHint(relativePath);
  const hintSection = hint ? `\n\nCompiler feedback for ${relativePath}:\n${hint}` : '';
  return `${trimmedBase}\n\nAddress the following review feedback before returning the full updated file:\n${boundedReview}${hintSection}`;
}

function groupDiagnosticsByFile(
  diagnostics: Diagnostic[],
  workspaceRoot: string,
  normalizeRelativePath: (value: string) => string | undefined
): Array<[string, Diagnostic[]]> {
  const bucket = new Map<string, Diagnostic[]>();
  diagnostics.forEach((diagnostic) => {
    const relativePath = normalizeDiagnosticRelativePath(diagnostic.file, workspaceRoot, normalizeRelativePath);
    if (!relativePath) {
      return;
    }
    const existing = bucket.get(relativePath) ?? [];
    existing.push(diagnostic);
    bucket.set(relativePath, existing);
  });
  return Array.from(bucket.entries());
}

function buildTouchedFileSet(
  touchedFiles: string[] | undefined,
  normalizeRelativePath: (value: string) => string | undefined
): Set<string> {
  const normalized = (Array.isArray(touchedFiles) ? touchedFiles : [])
    .map((file) => normalizeRelativePath(file) ?? file)
    .map((file) => file.replace(/\\/g, '/').toLowerCase())
    .filter((value) => value.length > 0);
  return new Set(normalized);
}

function partitionDiagnosticsByScope(
  entries: Array<[string, Diagnostic[]]>,
  touchedSet: Set<string>
): { actionable: Array<[string, Diagnostic[]]>; ambient: Array<[string, Diagnostic[]]> } {
  const actionable: Array<[string, Diagnostic[]]> = [];
  const ambient: Array<[string, Diagnostic[]]> = [];
  const enforceTouchedScope = touchedSet.size > 0;
  entries.forEach(([file, diagnostics]) => {
    const normalizedFile = typeof file === 'string' ? file.replace(/\\/g, '/').toLowerCase() : '';
    const fileIsAmbient = isAmbientFile(normalizedFile);
    const isTouched = !enforceTouchedScope || touchedSet.has(normalizedFile);
    if (fileIsAmbient || !isTouched) {
      diagnostics.forEach((diagnostic) => {
        diagnostic.isAmbientError = true;
        diagnostic.isTouchedFileError = false;
        diagnostic.isExternalError = true;
      });
      ambient.push([file, diagnostics]);
      return;
    }
    diagnostics.forEach((diagnostic) => {
      diagnostic.isTouchedFileError = true;
      diagnostic.isExternalError = false;
      diagnostic.isAmbientError = false;
    });
    actionable.push([file, diagnostics]);
  });
  return { actionable, ambient };
}

function normalizeDiagnosticRelativePath(
  file: string,
  workspaceRoot: string,
  normalizeRelativePath: (value: string) => string | undefined
): string | undefined {
  if (!file) {
    return undefined;
  }
  const normalizedFile = file.replace(/\\/g, '/').trim();
  const absolute = path.isAbsolute(normalizedFile)
    ? normalizedFile
    : path.join(workspaceRoot, normalizedFile);
  const relative = path.relative(workspaceRoot, absolute).replace(/\\/g, '/');
  return normalizeRelativePath(relative) ?? relative;
}

function isAmbientFile(file: string): boolean {
  if (!file) {
    return true;
  }
  return file.endsWith('.d.ts') || file.includes('/node_modules/') || file.includes('node_modules\\');
}

function buildDiagnosticInstructions(goal: string, relativePath: string, diagnostics: Diagnostic[]): string {
  const header = [
    `Goal: ${goal}`,
    `Target file: ${relativePath}`,
    'Compiler diagnostics that must be resolved:'
  ];
  const bulletList = diagnostics.slice(0, 8).map((diagnostic) => {
    const location = diagnostic.line > 0 ? `line ${diagnostic.line}` : 'unknown line';
    return `- ${location}: ${diagnostic.message}`;
  });
  return [
    ...header,
    ...bulletList,
    '',
    'Update the file to eliminate every diagnostic, ensuring the implementation stays aligned with the overall goal.'
  ].join('\n');
}

function createContextKey(prefix: string): string {
  return `${prefix}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
}

function reviewIndicatesApproval(review: string): boolean {
  const normalized = review.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith('review unavailable')) {
    return false;
  }
  const positiveMarkers = [
    'lgtm',
    'no issues found',
    'no issues flagged',
    'looks good',
    'looks solid',
    'approved',
    'all good',
    'ready to merge'
  ];
  return positiveMarkers.some((marker) => normalized.includes(marker));
}

function reviewIndicatesIssues(review: string): boolean {
  if (!review || review.trim().length === 0) {
    return true;
  }
  return !reviewIndicatesApproval(review);
}

function getLatestReviewResult(results: ExecutionResult[]): { review?: string; path?: string; needsRevision: boolean } | undefined {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const entry = results[index];
    const data = entry.data as { review?: unknown; path?: unknown; needsRevision?: unknown } | undefined;
    if (!data) {
      continue;
    }
    const reviewText = typeof data.review === 'string' ? data.review : undefined;
    if (!reviewText) {
      continue;
    }
    const needsRevision = typeof data.needsRevision === 'boolean'
      ? data.needsRevision
      : reviewIndicatesIssues(reviewText);
    const reviewPath = typeof data.path === 'string' ? data.path : undefined;
    return { review: reviewText, path: reviewPath, needsRevision };
  }
  return undefined;
}

function resolveTouchedFiles(
  relativePath: string | undefined,
  contextValue: unknown,
  normalizeRelativePath: (value: string) => string | undefined
): string[] {
  const contextPaths = coercePathList(contextValue);
  if (relativePath && relativePath.trim().length > 0) {
    contextPaths.push(relativePath.trim());
  }
  const normalized = contextPaths
    .map((file) => normalizeRelativePath(file) ?? file)
    .map((file) => file.replace(/\\/g, '/'))
    .filter((file) => file.length > 0);
  return Array.from(new Set(normalized));
}

function coercePathList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

function coerceDiagnostics(value: unknown): Diagnostic[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry): Diagnostic | undefined => {
      if (!entry || typeof entry !== 'object') {
        return undefined;
      }
      const candidate = entry as Partial<Diagnostic> & { file?: unknown; message?: unknown };
      if (typeof candidate.file !== 'string' || typeof candidate.message !== 'string') {
        return undefined;
      }
      return {
        file: candidate.file,
        message: candidate.message,
        line: typeof candidate.line === 'number' ? candidate.line : 0,
        type: candidate.type ?? 'unknown',
        isTouchedFileError: candidate.isTouchedFileError,
        isExternalError: candidate.isExternalError,
        isAmbientError: candidate.isAmbientError
      };
    })
    .filter((entry): entry is Diagnostic => Boolean(entry));
}

function partitionDiagnosticsForTouched(
  diagnostics: Diagnostic[] | undefined,
  touchedFiles: string[] | undefined,
  normalizeRelativePath: (value: string) => string | undefined
): { related: Diagnostic[]; unrelated: Diagnostic[] } {
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  if (!list.length) {
    return { related: [], unrelated: [] };
  }
  const normalizedTouched = new Set(
    (Array.isArray(touchedFiles) ? touchedFiles : [])
      .map((file) => normalizeRelativePath(file) ?? file)
      .map((file) => file.replace(/\\/g, '/').toLowerCase())
      .filter((file) => file.length > 0)
  );
  const enforceTouchedScope = normalizedTouched.size > 0;
  const related: Diagnostic[] = [];
  const unrelated: Diagnostic[] = [];
  list.forEach((diagnostic) => {
    const normalizedFile = normalizeRelativePath(diagnostic.file) ?? diagnostic.file;
    const normalizedKey = normalizedFile?.replace(/\\/g, '/').toLowerCase() ?? '';
    const flaggedTouched = typeof diagnostic.isTouchedFileError === 'boolean' ? diagnostic.isTouchedFileError : undefined;
    const isAmbient = diagnostic.isAmbientError === true || (!normalizedKey && enforceTouchedScope);
    const isTouched =
      flaggedTouched === true
      || (!isAmbient && (flaggedTouched !== false && (!enforceTouchedScope || normalizedTouched.has(normalizedKey))));
    if (isTouched) {
      diagnostic.isTouchedFileError = true;
      diagnostic.isExternalError = false;
      diagnostic.isAmbientError = false;
      related.push(diagnostic);
      return;
    }
    diagnostic.isTouchedFileError = false;
    diagnostic.isExternalError = true;
    diagnostic.isAmbientError = isAmbient;
    unrelated.push(diagnostic);
  });
  return { related, unrelated };
}

function mergeDiagnosticLists(target: Diagnostic[], additions: Diagnostic[]): Diagnostic[] {
  if (!Array.isArray(additions) || additions.length === 0) {
    return target;
  }
  const result = Array.isArray(target) ? target : [];
  const seen = new Set(result.map((diagnostic) => buildDiagnosticKey(diagnostic)));
  additions.forEach((diagnostic) => {
    const key = buildDiagnosticKey(diagnostic);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(diagnostic);
  });
  return result;
}

function buildDiagnosticKey(diagnostic: Diagnostic): string {
  const file = diagnostic.file ?? 'unknown';
  return `${file}:${diagnostic.line}:${diagnostic.message}`;
}

function appendValidationFinalNote(
  outcome: ValidationOutcome | TypeCheckRunResult | undefined,
  status: 'complete' | 'best-effort',
  note: string
): void {
  if (!outcome || !note) {
    return;
  }
  const notes = Array.isArray(outcome.finalNotes) ? [...outcome.finalNotes] : [];
  if (!notes.includes(note)) {
    notes.push(note);
  }
  outcome.finalNotes = notes;
  outcome.finalStatus = status;
}

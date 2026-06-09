import type { PlanStep, LlmRewriteAction } from '../internalTypes';
import type {
  AdditionalWrite,
  HelperStepMetadata,
  CallerStepMetadata,
  RewriteHydrationContext,
  StepOutcome,
  ITelemetry,
  TypeScriptValidator
} from '../internalTypes';
import type { InferredGoal } from '../internalTypes';

export interface RewriteEngineDeps {
  ensureSession(): { workspaceRoot: string };
  getHelperStepMetadata(step: PlanStep): HelperStepMetadata | undefined;
  getCallerStepMetadata(step: PlanStep): CallerStepMetadata | undefined;
  helperManager: {
    buildHelperGuidance(relativePath: string): Promise<string | undefined>;
    buildCallerGuidance(meta: CallerStepMetadata, relativePath: string): Promise<string | undefined>;
  };
  rewriteHydrationManager: {
    buildContext(step: PlanStep, relativePath: string): Promise<RewriteHydrationContext | undefined>;
  };
  getHydrationCache(stepId: string): RewriteHydrationContext | undefined;
  setHydrationCache(stepId: string, context: RewriteHydrationContext | undefined): void;
  generateRewrite(
    goal: string,
    relativePath: string,
    currentContent: string,
    projectSummary: string,
    instructions?: string,
    hydration?: RewriteHydrationContext
  ): Promise<StepOutcome>;
  setContextValue(key: string, value: unknown): void;
  getContextValue<T>(key: string): T | undefined;
  storeAdditionalWrites(outputKey: string, writes: AdditionalWrite[]): void;
  normalizeRelativePath(value: string): string | undefined;
  filterAdditionalWrites(raw: unknown, normalize: (value: string) => string | undefined): AdditionalWrite[];
  isDryRunEnabled(): boolean;
  isPreviewOnly(): boolean;
  telemetry: ITelemetry;
  additionalWriteManager: {
    applyAdditionalWrites(config: {
      workspaceRoot: string;
      writes: AdditionalWrite[];
      encoding: BufferEncoding;
      dryRun: boolean;
      stepId: string;
    }): Promise<Array<Record<string, unknown>>>;
  };
  getCurrentGoalInsight(): InferredGoal | undefined;
  typescriptValidator: TypeScriptValidator;
  resolveTargetPath(
    step: PlanStep,
    action: LlmRewriteAction,
    helperMeta?: HelperStepMetadata
  ): string | undefined;
}

export function createRewriteEngine(deps: RewriteEngineDeps) {
  async function execute(step: PlanStep, action: LlmRewriteAction, goal: string): Promise<StepOutcome> {
    deps.ensureSession();
    const helperMeta = deps.getHelperStepMetadata(step);
    const relativePath = deps.resolveTargetPath(step, action, helperMeta);
    let currentContent = helperMeta && helperMeta.snippetRef
      ? (deps.getContextValue<string>(helperMeta.snippetRef) ?? deps.getContextValue<string>(action.contentRef))
      : deps.getContextValue<string>(action.contentRef);
    const projectSummary = deps.getContextValue<string>('project.summary') ?? 'No project summary available.';

    if (!relativePath || typeof currentContent !== 'string') {
      return { ok: false, error: 'Homepage path or content unavailable for rewrite.' };
    }
    if (currentContent.trim().length === 0) {
      currentContent = deps.getContextValue<string>(action.contentRef) ?? currentContent;
    }

    const callerMeta = deps.getCallerStepMetadata(step);
    let instructions = action.instructions;
    if (helperMeta?.chainKind === 'helper' && helperMeta.role === 'rewrite') {
      const helperPathGuidance = await deps.helperManager.buildHelperGuidance(relativePath);
      if (helperPathGuidance) {
        instructions = instructions ? `${instructions}\n\n${helperPathGuidance}` : helperPathGuidance;
      }
    }
    if (callerMeta?.role === 'rewrite') {
      const callerGuidance = await deps.helperManager.buildCallerGuidance(callerMeta, relativePath);
      if (callerGuidance) {
        instructions = instructions ? `${instructions}\n\n${callerGuidance}` : callerGuidance;
      }
    }

    let hydration = deps.getHydrationCache(step.id);
    if (hydration) {
      deps.setHydrationCache(step.id, undefined);
    } else {
      hydration = await deps.rewriteHydrationManager.buildContext(step, relativePath);
    }
    if (hydration?.editable?.length) {
      const primary = hydration.editable.find((file) => arePathsEqual(file.path, relativePath, deps.normalizeRelativePath));
      if (primary && primary.content.trim().length > 0) {
        currentContent = primary.content;
      }
    }

    const suppressRelatedFiles = Boolean(helperMeta?.chainKind === 'helper' || callerMeta?.chainKind === 'caller');
    const promptInstructions = composeRewriteInstructionsInternal(instructions, relativePath, deps, {
      includeRelatedFilesHint: !suppressRelatedFiles
    });
    const rewrite = await deps.generateRewrite(
      goal,
      relativePath,
      currentContent,
      projectSummary,
      promptInstructions,
      hydration
    );
    if (!rewrite.ok) {
      return rewrite;
    }

    const content = typeof rewrite.data?.content === 'string' ? rewrite.data.content : '';
    let additionalWrites = Array.isArray((rewrite.data as { additionalWrites?: unknown })?.additionalWrites)
      ? deps.filterAdditionalWrites(
          (rewrite.data as { additionalWrites?: unknown }).additionalWrites,
          (value) => deps.normalizeRelativePath(value)
        )
      : [];
    additionalWrites = filterAdditionalWritesForStep(
      additionalWrites,
      relativePath,
      helperMeta,
      callerMeta,
      (value) => deps.normalizeRelativePath(value)
    );
    deps.setContextValue(action.outputKey, content);
    deps.storeAdditionalWrites(action.outputKey, additionalWrites);
    return rewrite;
  }

  async function createMissingHelperFiles(goal: string, files: string[]): Promise<string[]> {
    if (!files.length || deps.isPreviewOnly() || deps.isDryRunEnabled()) {
      return [];
    }
    const session = deps.ensureSession();
    const projectSummary = deps.getContextValue<string>('project.summary') ?? 'No project summary available.';
    const created: string[] = [];

    for (const file of files) {
      const normalizedTarget = deps.normalizeRelativePath(file) ?? file;
      const helperInstructions = [
        `The helper file "${file}" is required to accomplish the goal but does not exist. Create it from scratch and include all necessary imports, exports, and props so it can be consumed immediately.`,
        composeRewriteInstructions(undefined, file)
      ].join('\n\n');
      const rewriteOutcome = await deps.generateRewrite(goal, file, '', projectSummary, helperInstructions);
      if (!rewriteOutcome.ok) {
        await deps.telemetry.log({
          message: `Helper file generation failed for ${file}: ${rewriteOutcome.error ?? rewriteOutcome.output ?? 'unknown error.'}`,
          level: 'warn'
        });
        continue;
      }
      const content = typeof rewriteOutcome.data?.content === 'string' ? rewriteOutcome.data.content : '';
      const extraWrites = Array.isArray((rewriteOutcome.data as { additionalWrites?: unknown })?.additionalWrites)
        ? deps.filterAdditionalWrites(
            (rewriteOutcome.data as { additionalWrites?: unknown }).additionalWrites,
            (value) => deps.normalizeRelativePath(value)
          )
        : [];
      const writes: AdditionalWrite[] = [];
      if (content.trim().length > 0) {
        writes.push({ path: normalizedTarget, content, intent: 'create' });
      }
      if (extraWrites.length) {
        extraWrites.forEach((entry) => {
          const normalizedPath = deps.normalizeRelativePath(entry.path) ?? entry.path;
          writes.push({ ...entry, path: normalizedPath });
        });
      }
      const hasTargetWrite = writes.some((write) => (deps.normalizeRelativePath(write.path) ?? write.path) === normalizedTarget);
      if (!hasTargetWrite) {
        if (writes.length > 0) {
          const first = writes[0];
          writes[0] = { ...first, path: normalizedTarget };
        } else {
          writes.push({ path: normalizedTarget, content: buildComponentPlaceholder(file), intent: 'create' });
        }
      }
      if (!writes.length) {
        writes.push({ path: normalizedTarget, content: buildComponentPlaceholder(file), intent: 'create' });
      }
      await deps.additionalWriteManager.applyAdditionalWrites({
        workspaceRoot: session.workspaceRoot,
        writes,
        encoding: 'utf-8',
        dryRun: false,
        stepId: 'helper-create'
      });
      created.push(normalizedTarget);
    }
    if (created.length > 0) {
      await deps.telemetry.log({ message: `Generated helper files: ${created.join(', ')}`, level: 'info' });
    }
    return created;
  }

  function composeRewriteInstructions(baseInstructions: string | undefined, relativePath: string): string {
    return composeRewriteInstructionsInternal(baseInstructions, relativePath, deps);
  }

  return {
    execute,
    createMissingHelperFiles,
    composeRewriteInstructions
  };
}

function arePathsEqual(a: string | undefined, b: string | undefined, normalize: (value: string) => string | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  const normalizedA = normalize(a) ?? a;
  const normalizedB = normalize(b) ?? b;
  return normalizedA.toLowerCase() === normalizedB.toLowerCase();
}

function composeRewriteInstructionsInternal(
  baseInstructions: string | undefined,
  relativePath: string,
  deps: RewriteEngineDeps,
  options?: { includeRelatedFilesHint?: boolean }
): string {
  const sections: string[] = [];
  const trimmed = baseInstructions?.trim();
  const isTypeScriptLike = /\.(ts|tsx|js|jsx)$/i.test(relativePath);
  let resolvedInstructions = trimmed;
  if (resolvedInstructions) {
    resolvedInstructions = resolvedInstructions.replace(/<path to update>/gi, relativePath);
    if (!isTypeScriptLike) {
      resolvedInstructions = resolvedInstructions
        .split('\n')
        .filter((line) => {
          const lower = line.toLowerCase();
          if (lower.includes('typescript')) {
            return false;
          }
          if (lower.includes('ts5097')) {
            return false;
          }
          if (lower.includes('.ts/.tsx')) {
            return false;
          }
          return true;
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
    }
  }
  if (resolvedInstructions && resolvedInstructions.trim().length > 0) {
    sections.push(resolvedInstructions.trim());
  } else {
    sections.push(
      'Update the currently loaded file according to the goal. Respond only with a ```files block that contains every updated file and no additional commentary.'
    );
  }
  const insight = deps.getCurrentGoalInsight();
  if (!insight) {
    return sections.join('\n\n');
  }
  const tasks = insight.tasks ?? [];
  if (tasks.length > 0) {
    const lines = tasks.map((task, index) => {
      const title = task.title?.trim() || `Task ${index + 1}`;
      const description = task.description?.trim();
      const files = Array.isArray(task.files) && task.files.length > 0 ? ` (files: ${task.files.join(', ')})` : '';
      return `${index + 1}. ${title}${files}${description ? ` — ${description}` : ''}`;
    });
    sections.push(['Honor these inferred subtasks:', ...lines].join('\n'));
  }
  const relatedFiles = new Set<string>();
  (insight.files ?? []).forEach((file) => {
    const normalized = deps.normalizeRelativePath(file);
    if (normalized && normalized !== relativePath) {
      relatedFiles.add(normalized);
    }
  });
  tasks.forEach((task) => {
    (task.files ?? []).forEach((file) => {
      const normalized = deps.normalizeRelativePath(file);
      if (normalized && normalized !== relativePath) {
        relatedFiles.add(normalized);
      }
    });
  });
  if (options?.includeRelatedFilesHint !== false && relatedFiles.size > 0) {
    sections.push(
      [
        'If the goal references the following files/components, include them as additional FILE entries in the ```files block with their complete contents:',
        ...Array.from(relatedFiles).map((file) => `- ${file}`),
        'Do not leave references to helpers/components that are undefined. Update imports/exports accordingly.'
      ].join('\n')
    );
  }
  if (resolvedInstructions && /```files|FILE:\s*|files block/i.test(resolvedInstructions)) {
    sections.push(`Always include a FILE entry for ${relativePath} in the \`\`\`files block.`);
  }
  const rewriteHint = deps.typescriptValidator.getRewriteHint(relativePath);
  if (rewriteHint) {
    sections.push(`Compiler feedback for ${relativePath}:\n${rewriteHint}`);
  }
  return sections.join('\n\n');
}

function buildComponentPlaceholder(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() ?? 'HelperComponent.tsx';
  const base = fileName.replace(/\.[^.]+$/, '');
  const parts = base
    .split(/[-_\s]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1));
  const componentName = parts.length ? parts.join('') : 'HelperComponent';
  return [
    "import React from 'react';",
    '',
    `export interface ${componentName}Props {\n  onAction?: () => void;\n}`,
    '',
    `export const ${componentName} = ({ onAction }: ${componentName}Props): JSX.Element => {`,
    '  return (',
    `    <div className="${componentName}">`,
    `      {/* TODO: Implement ${componentName} */}`,
    '    </div>',
    '  );',
    '};',
    ''
  ].join('\n');
}

function filterAdditionalWritesForStep(
  writes: AdditionalWrite[],
  primaryPath: string,
  helperMeta: HelperStepMetadata | undefined,
  callerMeta: CallerStepMetadata | undefined,
  normalizeRelativePath: (value: string) => string | undefined
): AdditionalWrite[] {
  if (!writes.length) {
    return writes;
  }
  if (helperMeta?.chainKind === 'helper') {
    const primaryKey = normalizeRelativePath(primaryPath)?.toLowerCase() ?? primaryPath.toLowerCase();
    return writes.filter((entry) => {
      const entryKey = normalizeRelativePath(entry.path)?.toLowerCase() ?? entry.path.toLowerCase();
      return entryKey === primaryKey;
    });
  }
  if (callerMeta?.chainKind === 'caller') {
    return [];
  }
  return writes;
}

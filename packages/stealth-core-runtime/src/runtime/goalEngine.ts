import type { Goal, Plan, PlanStep, Task } from '../internalTypes';
import type { InferredGoal, TaskSuggestion } from '../internalTypes';
import type { IGoalEngine } from '../internalTypes';
import type { WorkspaceIndexer } from './workspaceIndexer';

const safeRandomId = (): string => {
  const globalCrypto = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto : undefined;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  return `uuid-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
};

const getBaseName = (target: string): string => {
  const parts = target.split(/[/\\]/);
  return parts.pop() || target;
};

const getExtName = (target: string): string => {
  const match = target.match(/\.[^.]+$/);
  return match ? match[0] : '';
};

type StepCategory = 'scan' | 'locate' | 'read' | 'confirm' | 'edit' | 'apply' | 'review' | 'validate' | 'generic';

export interface GoalEngineDeps {
  generateGoalId?: () => string;
  now?: () => number;
  onError?: (error: unknown) => void;
  getWorkspaceIndexer?: () => WorkspaceIndexer | undefined;
}

const defaultGoalId = () => `goal-${safeRandomId()}`;
const defaultNow = () => Date.now();

export function createGoalEngine(deps: GoalEngineDeps = {}): IGoalEngine {
  const generateGoalId = deps.generateGoalId ?? defaultGoalId;
  const now = deps.now ?? defaultNow;
  const reportError = deps.onError ?? ((error: unknown) => {
    console.warn('Goal engine enrichment failed', error);
  });

  return {
    async enrich(plan: Plan, prompt: string, options = {}): Promise<Plan> {
      if (plan.tasks?.length && plan.goals?.length) {
        return plan;
      }

      try {
        const descriptor = prompt?.trim() || plan.goal || 'Bandit agent goal';
        const inferredGoals = buildGoalsFromInsight(options.insight, descriptor, generateGoalId, now);
        const normalizedGoals = inferredGoals.length > 0
          ? inferredGoals
          : [createFallbackGoal(descriptor, generateGoalId, now)];
        const expandedPlan = await enhancePlanWithSymbolReferences(plan, deps.getWorkspaceIndexer);
        const tasks = buildTasksFromSteps(expandedPlan.steps ?? [], normalizedGoals, options.insight, generateGoalId);
        const goalsWithTasks = assignTasksToGoals(normalizedGoals, tasks);
        return {
          ...expandedPlan,
          tasks,
          goals: goalsWithTasks
        };
      } catch (error) {
        reportError(error);
        return plan;
      }
    }
  };
}

async function enhancePlanWithSymbolReferences(
  plan: Plan,
  getIndexer?: () => WorkspaceIndexer | undefined
): Promise<Plan> {
  if (typeof getIndexer !== 'function' || !plan.steps?.length) {
    return plan;
  }
  const indexer = getIndexer();
  if (!indexer) {
    return plan;
  }
  let mutated = false;
  const enhancedSteps: PlanStep[] = [];
  for (const step of plan.steps) {
    const enriched = await appendSymbolReferences(step, indexer);
    mutated = mutated || enriched !== step;
    enhancedSteps.push(enriched);
  }
  if (!mutated) {
    return plan;
  }
  return {
    ...plan,
    steps: enhancedSteps
  };
}

async function appendSymbolReferences(step: PlanStep, indexer: WorkspaceIndexer): Promise<PlanStep> {
  if (!isEditableStep(step)) {
    return step;
  }
  const chainKind = (step.metadata as { chainKind?: unknown })?.chainKind;
  if (chainKind === 'helper' || chainKind === 'caller' || chainKind === 'related') {
    return step;
  }
  const symbols = extractSymbolTargets(step);
  if (!symbols.length) {
    return step;
  }
  const normalizedEdits = new Set(
    [...(step.filesToEdit ?? []), step.targetFile]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.toLowerCase())
  );
  const relatedFiles = new Set<string>();
  for (const symbol of symbols) {
    const references = await indexer.findReferences(symbol);
    references.forEach((reference) => {
      const key = reference.file.toLowerCase();
      if (normalizedEdits.has(key)) {
        return;
      }
      relatedFiles.add(reference.file);
    });
    if (relatedFiles.size >= 5) {
      break;
    }
  }
  if (!relatedFiles.size) {
    return step;
  }
  const filesToEdit = [...(step.filesToEdit ?? []), ...Array.from(relatedFiles).slice(0, 5)];
  const metadata = {
    ...(step.metadata ?? {}),
    symbolReferences: mergeSymbolReferenceMetadata(step.metadata?.symbolReferences, Array.from(relatedFiles))
  };
  return {
    ...step,
    filesToEdit,
    metadata
  };
}

function isEditableStep(step: PlanStep): boolean {
  if (!step?.action) {
    return false;
  }
  if (step.action.type === 'llmRewrite') {
    return true;
  }
  if (step.action.type === 'python' && step.action.name === 'writeFile') {
    return true;
  }
  return false;
}

function extractSymbolTargets(step: PlanStep): string[] {
  const metadata = step.metadata ?? {};
  const symbols = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      symbols.add(value.trim());
    } else if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (typeof entry === 'string' && entry.trim()) {
          symbols.add(entry.trim());
        }
      });
    }
  };
  collect(metadata['symbol']);
  collect(metadata['symbols']);
  collect(metadata['targetSymbol']);
  collect(metadata['targetSymbols']);
  collect(metadata['focusSymbol']);
  const derived = deriveSymbolFromTargetFile(step.targetFile);
  if (derived) {
    symbols.add(derived);
  }
  return Array.from(symbols).slice(0, 3);
}

function deriveSymbolFromTargetFile(targetFile?: string): string | undefined {
  if (!targetFile || !/\.(ts|tsx|js|jsx|mts|cts)$/i.test(targetFile)) {
    return undefined;
  }
  const basename = getBaseName(targetFile).replace(getExtName(targetFile), '');
  if (!basename || basename.length < 3) {
    return undefined;
  }
  return basename;
}

function mergeSymbolReferenceMetadata(
  existing: unknown,
  files: string[]
): string[] {
  const normalized = new Set<string>();
  if (Array.isArray(existing)) {
    existing.forEach((entry) => {
      if (typeof entry === 'string') {
        normalized.add(entry);
      }
    });
  }
  files.forEach((file) => normalized.add(file));
  return Array.from(normalized);
}

function buildGoalsFromInsight(
  insight: InferredGoal | undefined,
  fallbackTitle: string,
  generateGoalId: () => string,
  now: () => number
): Goal[] {
  if (!insight) {
    return [];
  }
  const timestamp = now();
  const title = insight.title?.trim() || fallbackTitle || 'Bandit agent goal';
  return [
    {
      id: generateGoalId(),
      title,
      summary: insight.rationale ?? `Intent detected: ${insight.intent}`,
      tasks: [] as Task[],
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        source: 'inference',
        intent: insight.intent,
        candidateFiles: insight.files
      }
    }
  ];
}

function createFallbackGoal(
  fallbackTitle: string,
  generateGoalId: () => string,
  now: () => number
): Goal {
  const timestamp = now();
  const title = fallbackTitle?.trim() || 'Bandit agent goal';
  return {
    id: generateGoalId(),
    title,
    summary: `Agent plan for "${title}".`,
    tasks: [] as Task[],
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {
      source: 'fallback'
    }
  };
}

function buildTasksFromSteps(
  steps: PlanStep[],
  goals: Goal[],
  insight: InferredGoal | undefined,
  generateGoalId: () => string
): Task[] {
  if (!steps.length) {
    return [];
  }

  const fallbackGoalId = goals[0]?.id ?? generateGoalId();
  if (insight?.tasks?.length) {
    return buildReasonedTasksFromSuggestions(steps, insight.tasks, fallbackGoalId);
  }

  return steps.map((step) => {
    const likelyFiles = deriveTaskFiles(step, insight);
    return {
      id: `task-${step.id}`,
      title: step.title,
      description: step.details,
      status: 'pending',
      goalId: fallbackGoalId,
      metadata: {
        stepId: step.id,
        command: step.command,
        targetFile: step.targetFile,
        action: step.action,
        stepMetadata: step.metadata,
        likelyFiles
      }
    };
  });
}

function buildReasonedTasksFromSuggestions(
  steps: PlanStep[],
  suggestions: TaskSuggestion[],
  fallbackGoalId: string
): Task[] {
  if (!suggestions.length) {
    return steps.map((step) => {
      const likelyFiles = deriveTaskFiles(step);
      return {
        id: `task-${step.id}`,
        title: step.title,
        description: step.details,
        status: 'pending',
        goalId: fallbackGoalId,
        metadata: {
          stepId: step.id,
          command: step.command,
          targetFile: step.targetFile,
          action: step.action,
          stepMetadata: step.metadata,
          likelyFiles
        }
      };
    });
  }

  const catalog = steps.map((step) => ({ step, category: categorizePlanStep(step) }));
  const usage = new Map<string, number>();
  const tasks: Task[] = [];

  suggestions.forEach((suggestion, index) => {
    const assignedStep = selectStepForSuggestion(suggestion, catalog, usage)
      ?? steps[Math.min(index, steps.length - 1)];
    const files = suggestion.files?.length ? suggestion.files : undefined;
    tasks.push({
      id: `reasoned-task-${index + 1}`,
      title: suggestion.title,
      description: suggestion.description,
      status: 'pending',
      goalId: fallbackGoalId,
      metadata: {
        source: 'inference',
        suggestionIndex: index,
        stepId: assignedStep?.id,
        stepIds: assignedStep ? [assignedStep.id] : undefined,
        likelyFiles: files
      }
    });
  });

  return tasks;
}

function selectStepForSuggestion(
  suggestion: TaskSuggestion,
  catalog: Array<{ step: PlanStep; category: StepCategory }>,
  usage: Map<string, number>
): PlanStep | undefined {
  const preferredCategory = deriveSuggestionCategory(suggestion);
  const orderedCategories: StepCategory[] = preferredCategory === 'edit'
    ? [preferredCategory, 'apply', 'review', 'locate', 'read', 'generic']
    : [preferredCategory, 'edit', 'apply', 'review', 'generic'];

  for (const category of orderedCategories) {
    const step = pickStepByCategory(category, catalog, usage);
    if (step) {
      return step;
    }
  }
  return undefined;
}

function pickStepByCategory(
  category: StepCategory,
  catalog: Array<{ step: PlanStep; category: StepCategory }>,
  usage: Map<string, number>
): PlanStep | undefined {
  const matches = catalog.filter((entry) => entry.category === category);
  if (!matches.length) {
    return undefined;
  }
  let selected = matches[0];
  let bestUsage = usage.get(selected.step.id) ?? 0;
  for (const entry of matches) {
    const count = usage.get(entry.step.id) ?? 0;
    if (count < bestUsage) {
      selected = entry;
      bestUsage = count;
    }
  }
  usage.set(selected.step.id, bestUsage + 1);
  return selected.step;
}

function categorizePlanStep(step: PlanStep): StepCategory {
  const title = step.title.toLowerCase();
  if (step.action.type === 'python' && step.action.name === 'scanProject') {
    return 'scan';
  }
  if (step.action.type === 'internal' && step.action.name === 'locateFiles') {
    return 'locate';
  }
  if (step.action.type === 'python' && step.action.name === 'readFile') {
    return 'read';
  }
  if (step.action.type === 'internal' && step.action.name === 'emitMessage' && title.includes('confirm')) {
    return 'confirm';
  }
  if (step.action.type === 'llmRewrite') {
    return 'edit';
  }
  if (step.action.type === 'python' && step.action.name === 'writeFile') {
    return 'apply';
  }
  if (step.action.type === 'internal' && step.action.name === 'reviewDiff') {
    return 'review';
  }
  if (step.action.type === 'internal' && step.action.name === 'runProjectScripts') {
    return 'validate';
  }
  if (title.includes('review')) {
    return 'review';
  }
  return 'generic';
}

function deriveSuggestionCategory(suggestion: TaskSuggestion): StepCategory {
  const text = `${suggestion.title ?? ''} ${suggestion.description ?? ''}`.toLowerCase();
  if (/\bscan\b|\baudit\b|\binventory\b|\bindex\b/.test(text)) {
    return 'scan';
  }
  if (/\blocate\b|\bfind\b|\bsearch\b/.test(text)) {
    return 'locate';
  }
  if (/\bread\b|\binspect\b|\breview\b/.test(text)) {
    return 'read';
  }
  if (/\bconfirm\b|\bverify\b|\bensure\b/.test(text)) {
    return 'confirm';
  }
  if (/\breview\b|\bvalidate\b|\bqa\b|\btest\b|\bdouble[- ]check\b/.test(text)) {
    return 'review';
  }
  if (/\bapply\b|\bwrite\b|\bsave\b/.test(text)) {
    return 'apply';
  }
  if (/\brun\b|\bscripts?\b|\blint\b|\bbuild\b/.test(text)) {
    return 'validate';
  }
  return 'edit';
}

function deriveTaskFiles(step: PlanStep, insight?: InferredGoal): string[] | undefined {
  const files = new Set<string>();
  if (step.targetFile) {
    files.add(step.targetFile);
  }
  const candidates = insight?.files ?? [];
  if (candidates.length > 0) {
    for (const candidate of candidates) {
      if (files.size >= 4) {
        break;
      }
      if (step.targetFile && candidate === step.targetFile) {
        files.add(candidate);
        continue;
      }
      if (!step.targetFile && matchInsightCandidate(candidate, step.title, step.details)) {
        files.add(candidate);
      }
    }
  }
  return files.size > 0 ? Array.from(files) : undefined;
}

function matchInsightCandidate(candidate: string, title: string, details?: string): boolean {
  const haystack = `${title ?? ''} ${details ?? ''}`.toLowerCase().trim();
  if (!haystack) {
    return false;
  }
  const tokens = haystack.match(/[a-z0-9][a-z0-9_-]{3,}/g);
  if (!tokens) {
    return false;
  }
  const normalized = candidate.toLowerCase();
  return tokens.some((token) => normalized.includes(token));
}

function assignTasksToGoals(goals: Goal[], tasks: Task[]): Goal[] {
  if (!goals.length) {
    return goals;
  }
  type GoalWithTasks = Goal & { tasks: Task[] };
  const normalizedGoals = goals.map<GoalWithTasks>((goal) => {
    const clonedTasks: Task[] = Array.isArray(goal.tasks) ? [...goal.tasks] : [];
    return {
      ...goal,
      tasks: clonedTasks
    };
  });
  const fallbackGoal = normalizedGoals[0];
  const lookup = new Map<string, GoalWithTasks>(normalizedGoals.map((goal) => [goal.id, goal]));
  for (const task of tasks) {
    const target = lookup.get(task.goalId ?? fallbackGoal.id) ?? fallbackGoal;
    task.goalId = target.id;
    target.tasks.push(task);
  }
  return normalizedGoals;
}

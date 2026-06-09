import type {
  InternalIdentifyHomepageAction,
  InternalLocateFilesAction,
  InternalExtractRelevantSectionAction,
  InternalRunProjectScriptsAction,
  InternalEmitMessageAction,
  InternalReviewDiffAction,
  PlanStep,
  PythonRunCommandAction
} from '../internalTypes';
import type { StepOutcome } from '../internalTypes';

export interface InternalActionDeps {
  getContextValue<T>(key: string): T | undefined;
  setContextValue(key: string, value: unknown): void;
  normalizeRelativePath(value: string): string | undefined;
  runPythonStep(action: PythonRunCommandAction, stepId?: string, step?: PlanStep): Promise<StepOutcome>;
  isCancelled(): boolean;
  reviewDiff(action: InternalReviewDiffAction, step?: PlanStep): Promise<StepOutcome>;
  extractRelevantSection(content: string, patterns?: string[]): string;
  clampSnippet(content: string, limit?: number): string;
}

export function createInternalActionExecutor(deps: InternalActionDeps) {
  async function identifyHomepage(action: InternalIdentifyHomepageAction): Promise<StepOutcome> {
    const project = deps.getContextValue<Record<string, unknown>>('project');
    const files = Array.isArray(project?.files) ? (project?.files as string[]) : [];
    if (files.length === 0) {
      return { ok: false, error: 'Project scan did not return any files.' };
    }

    const candidates = rankHomepageCandidates(files);
    const best = candidates[0];
    if (!best) {
      return { ok: false, error: 'Unable to identify a homepage file from project scan.' };
    }

    const storePath = action.storePath ?? 'homepage';
    deps.setContextValue(`${storePath}.path`, best.path);
    deps.setContextValue(`${storePath}.reason`, best.reason);
    deps.setContextValue(`${storePath}.score`, best.score);

    return {
      ok: true,
      output: `Homepage candidate: ${best.path} (${best.reason})`,
      data: { path: best.path, reason: best.reason, score: best.score }
    };
  }

  async function locateFiles(action: InternalLocateFilesAction): Promise<StepOutcome> {
    const project = deps.getContextValue<Record<string, unknown>>('project');
    const files = Array.isArray(project?.files) ? (project?.files as string[]) : [];
    if (files.length === 0) {
      return { ok: false, error: 'Project scan did not return any files.' };
    }

    const patterns = Array.isArray(action.patterns)
      ? action.patterns.map((pattern) => pattern.toLowerCase().trim()).filter((pattern) => pattern.length > 0)
      : [];
    if (patterns.length === 0) {
      return { ok: false, error: 'No search patterns provided.' };
    }

    const patternEntries = patterns.map((pattern) => {
      const compact = pattern.replace(/[^a-z0-9]+/g, '');
      const useCompact = compact.length >= 3 && compact !== pattern;
      return { raw: pattern, compact, useCompact };
    });

    const priorityKeywords = new Set(
      Array.isArray(action.priorityKeywords)
        ? action.priorityKeywords.map((keyword) => keyword.toLowerCase().trim()).filter((keyword) => keyword.length > 0)
        : []
    );

    const normalizeHint = (value: string): string | undefined => {
      const normalized =
        deps.normalizeRelativePath(value) ?? value.replace(/\\/g, '/').replace(/^\.\/+/, '');
      return normalized && normalized !== '.' ? normalized : undefined;
    };
    const normalizedPrimaryHint = typeof action.primaryPathHint === 'string'
      ? normalizeHint(action.primaryPathHint)
      : undefined;
    const primaryHintKey = normalizedPrimaryHint?.toLowerCase();
    const excludePrefixes = Array.isArray(action.excludePrefixes)
      ? action.excludePrefixes
        .map((prefix) => normalizeHint(prefix))
        .filter((prefix): prefix is string => Boolean(prefix))
      : [];
    const matches: Array<{ path: string; score: number; matches: string[]; excluded?: boolean; hintMatch?: boolean }> = [];

    for (const file of files) {
      const normalizedPath = normalizeHint(file) ?? file;
      if (!normalizedPath) {
        continue;
      }
      const searchTarget = normalizedPath.toLowerCase();
      const compactTarget = searchTarget.replace(/[^a-z0-9]+/g, '');
      const pathTokens = searchTarget.split(/[^a-z0-9]+/).filter((segment) => segment.length > 0);
      const matchedPatterns = patternEntries
        .filter(({ raw, compact, useCompact }) =>
          searchTarget.includes(raw) || (useCompact && compactTarget.includes(compact))
        )
        .map(({ raw }) => raw);
      const hasHintPriority = Boolean(primaryHintKey && searchTarget === primaryHintKey);
      if (matchedPatterns.length === 0 && !hasHintPriority) {
        continue;
      }
      let score = matchedPatterns.reduce((total, pattern) => total + pattern.length, 0);
      const fileName = pathTokens[pathTokens.length - 1] ?? searchTarget;

      for (const pattern of matchedPatterns) {
        if (searchTarget.includes(pattern)) {
          score += pattern.length;
        }
        if (fileName.includes(pattern)) {
          score += pattern.length * 1.5;
        }
        if (priorityKeywords.has(pattern) || priorityKeywords.has(pattern.replace(/\s+/g, ''))) {
          const isFilenamePriority = /\.[a-z0-9]{1,6}$/i.test(pattern);
          score += pattern.length * (isFilenamePriority ? 6 : 3);
        }
      }

      const directMatch = patterns.some((pattern) => pattern.includes('/') && searchTarget.endsWith(pattern));
      if (directMatch) {
        score += 25;
      }
      if (hasHintPriority) {
        score += 8;
      }

      const recordedMatches = matchedPatterns.length > 0
        ? matchedPatterns
        : hasHintPriority
          ? [normalizedPath.split('/').pop() ?? normalizedPath]
          : matchedPatterns;

      const excluded = excludePrefixes.length > 0 && isExcludedPath(searchTarget, excludePrefixes);
      matches.push({ path: normalizedPath, score, matches: recordedMatches, excluded, hintMatch: hasHintPriority });
    }

    if (matches.length === 0) {
      return { ok: false, error: 'No files matched the requested patterns.' };
    }

    const filteredMatches = excludePrefixes.length > 0
      ? matches.filter((entry) => !entry.excluded)
      : matches;
    const rankedMatches = filteredMatches.length > 0 ? filteredMatches : matches;
    rankedMatches.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (Boolean(a.hintMatch) !== Boolean(b.hintMatch)) {
        return Number(Boolean(b.hintMatch)) - Number(Boolean(a.hintMatch));
      }
      return a.path.length - b.path.length;
    });

    const maxMatches = Math.max(1, Math.min(action.maxMatches ?? 3, rankedMatches.length));
    const selected = rankedMatches.slice(0, maxMatches);

    const storePath = action.storePath ?? 'search';
    deps.setContextValue(`${storePath}.matches`, selected);
    deps.setContextValue(`${storePath}.primary`, selected[0]);

    return {
      ok: true,
      output: `Located ${selected.length} candidate file${selected.length === 1 ? '' : 's'}: ${selected.map((item) => item.path).join(', ')}`,
      data: { matches: selected }
    };
  }

  function isExcludedPath(pathValue: string, prefixes: string[]): boolean {
    if (!pathValue || prefixes.length === 0) {
      return false;
    }
    for (const prefix of prefixes) {
      if (!prefix) {
        continue;
      }
      const normalizedPrefix = prefix.toLowerCase();
      if (pathValue === normalizedPrefix) {
        return true;
      }
      const withSlash = normalizedPrefix.endsWith('/') ? normalizedPrefix : `${normalizedPrefix}/`;
      if (pathValue.startsWith(withSlash)) {
        return true;
      }
    }
    return false;
  }

  function extractRelevantSection(action: InternalExtractRelevantSectionAction): StepOutcome {
    const storeKey = action.storeKey?.trim() || 'focus.extract.section';
    const contentRef = action.contentRef?.trim() || 'focus.primary.content';
    const rawContent = deps.getContextValue<string>(contentRef) ?? '';
    const fallbackContent = deps.getContextValue<string>('focus.primary.content') ?? rawContent;
    const source = rawContent.trim().length > 0 ? rawContent : fallbackContent;
    const patterns = Array.isArray(action.patterns)
      ? action.patterns
        .map((pattern) => (typeof pattern === 'string' ? pattern.trim() : ''))
        .filter((pattern) => pattern.length > 0)
      : [];
    const snippet = deps.extractRelevantSection(source, patterns);
    const normalized = deps.clampSnippet(typeof snippet === 'string' ? snippet : '', 1800) ?? '';
    deps.setContextValue(storeKey, normalized);
    const length = normalized.length;
    const pathLabel = action.pathRef
      ? deps.normalizeRelativePath(deps.getContextValue<string>(action.pathRef) ?? action.pathRef)
        ?? action.pathRef
      : undefined;
    return {
      ok: true,
      output: length > 0
        ? `Captured relevant snippet (${length} chars)${pathLabel ? ` from ${pathLabel}` : ''}.`
        : `Stored empty snippet${pathLabel ? ` for ${pathLabel}` : ''}.`,
      data: { storeKey, length, patterns }
    };
  }

  async function runProjectScripts(action: InternalRunProjectScriptsAction): Promise<StepOutcome> {
    const project = deps.getContextValue<Record<string, unknown>>('project');
    const scripts = (project?.scripts as Record<string, string> | undefined) ?? {};
    const desired = action.scripts ?? ['lint', 'test'];
    const available = desired.filter((script) => typeof scripts[script] === 'string');

    if (available.length === 0) {
      return { ok: true, output: 'No project scripts to run.', data: { scripts: [] } };
    }

    const runs: Array<Record<string, unknown>> = [];
    let allPassed = true;
    for (const script of available) {
      if (deps.isCancelled()) {
        break;
      }
      const commandAction: PythonRunCommandAction = {
        type: 'python',
        name: 'runCommand',
        command: `npm run ${script}`,
        cwdRef: 'project.root',
        allowFailure: true
      };
      const outcome = await deps.runPythonStep(commandAction, undefined, undefined);
      runs.push({ script, ok: outcome.ok, output: outcome.output, error: outcome.error });
      if (!outcome.ok) {
        allPassed = false;
      }
    }

    deps.setContextValue('project.scriptResults', runs);

    return {
      ok: allPassed,
      output: allPassed ? `Scripts succeeded: ${available.join(', ')}` : `Some scripts failed: ${available.join(', ')}`,
      error: allPassed ? undefined : 'One or more scripts failed. Check logs.',
      data: { runs }
    };
  }

  function emitMessage(action: InternalEmitMessageAction): StepOutcome {
    const message = action.message?.trim();
    if (!message) {
      return { ok: false, error: 'No message provided.' };
    }
    const level = action.level === 'warn' || action.level === 'error' ? action.level : 'info';
    return {
      ok: true,
      output: message,
      data: { level }
    };
  }

  async function execute(
    step: PlanStep,
    action:
      | InternalIdentifyHomepageAction
      | InternalLocateFilesAction
      | InternalExtractRelevantSectionAction
      | InternalRunProjectScriptsAction
      | InternalEmitMessageAction
      | InternalReviewDiffAction
  ): Promise<StepOutcome> {
    switch (action.name) {
      case 'identifyHomepage':
        return identifyHomepage(action);
      case 'locateFiles':
        return locateFiles(action);
      case 'extractRelevantSection':
        return extractRelevantSection(action);
      case 'runProjectScripts':
        return runProjectScripts(action);
      case 'emitMessage':
        return emitMessage(action);
      case 'reviewDiff':
        return deps.reviewDiff(action, step);
      default:
        return { ok: false, error: 'Unsupported internal action.' };
    }
  }

  return { execute };

  function rankHomepageCandidates(files: string[]): Array<{ path: string; score: number; reason: string }> {
    const interestingExtensions = ['.tsx', '.jsx', '.js', '.ts', '.html'];
    const extensionScores: Record<string, number> = {
      '.tsx': 8,
      '.jsx': 7,
      '.ts': 4,
      '.js': 4,
      '.html': 2
    };
    const candidates: Array<{ path: string; score: number; reason: string }> = [];

    for (const file of files) {
      const lowered = file.toLowerCase();
      if (lowered.includes('node_modules/') || lowered.includes('/node_modules/')) {
        continue;
      }
      if (!interestingExtensions.some((ext) => lowered.endsWith(ext))) {
        continue;
      }

      let score = 0;
      const reasons: string[] = [];

      const ext = interestingExtensions.find((extension) => lowered.endsWith(extension)) ?? '.txt';
      score += extensionScores[ext] ?? 0;
      if (extensionScores[ext] ?? 0) {
        reasons.push(`${ext} priority`);
      }

      if (/home|landing|welcome/.test(lowered)) {
        score += 6;
        reasons.push('contains “home” keyword');
      }
      if (/pages\/.+/.test(lowered)) {
        score += 4;
        reasons.push('in pages directory');
      }
      if (/src\//.test(lowered)) {
        score += 2;
        reasons.push('inside src');
      }
      if (lowered.endsWith('index.tsx') || lowered.endsWith('index.jsx') || lowered.endsWith('index.js') || lowered.endsWith('index.html')) {
        score += 3;
        reasons.push('index entry point');
      }
      if (lowered.includes('/app/')) {
        score += 2;
        reasons.push('inside /app');
      }
      if (lowered.includes('public/') && lowered.endsWith('.html')) {
        score += 5;
        reasons.push('public HTML');
      }
      if (lowered.includes('/pages/index')) {
        score += 6;
        reasons.push('Next.js pages index');
      }

      candidates.push({ path: file, score, reason: reasons.join(', ') || 'generic web entry point' });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }
}

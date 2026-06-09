import { randomUUID } from 'crypto';
import type { Plan, PlanStep } from '@burtson-labs/stealth-core-runtime';
import {
  STOP_WORDS as CORE_STOP_WORDS,
  PATH_PATTERN,
  FILE_NAME_PATTERN as CORE_FILE_NAME_PATTERN
} from '@burtson-labs/stealth-core-runtime';

const DEFAULT_SCAN_EXTENSIONS = [
  '.tsx',
  '.ts',
  '.jsx',
  '.js',
  '.html',
  '.md',
  '.css',
  '.scss',
  '.cs',
  '.csproj',
  '.sln'
];
const ADMIN_PANEL_PATTERNS = ['admin', 'dashboard', 'panel', 'backoffice', 'manage'];
// Extend core STOP_WORDS with planner-specific extras
const STOP_WORDS = new Set([
  ...CORE_STOP_WORDS,
  'help', 'create', 'update', 'change', 'tell', 'show', 'give', 'able', 'want', 'looking',
  'some', 'more', 'info', 'information', 'details', 'analysis', 'also', 'current', 'existing',
  'ensure', 'provide', 'their'
]);
const PATH_WITH_DIR_PATTERN = PATH_PATTERN;
const FILE_NAME_PATTERN = CORE_FILE_NAME_PATTERN;
const SCRIPT_PATTERNS: Record<'lint' | 'test' | 'build', RegExp[]> = {
  lint: [/\blint\b/i, /\beslint\b/i, /\bcode\s?style\b/i, /\bformat\b/i],
  test: [/\btest(s|ing)?\b/i, /\bunit\b/i, /\bintegration\b/i, /\bjest\b/i, /\bvitest\b/i],
  build: [/\bbuild\b/i, /\bcompile\b/i, /\bbundle\b/i, /\bproduction\b/i]
};
const RUN_ALL_SCRIPTS_PATTERN = /\b(run|execute)\s+all\b|\bci\b|\bchecks\b|\bfull\s+(suite|run)\b/i;
const HELPER_FILE_PATTERN = /\.(tsx|ts|jsx|js)$/i;
const DEFAULT_SNIPPET_REF = 'focus.extract.section';
const HELPER_STORE_BASE = 'focus.helpers';
const RELATED_STORE_BASE = 'focus.related';
const MAX_HELPER_CHAINS = 2;
const MAX_RELATED_FILES = 3;
const DEFAULT_HELPER_DIRECTORY = 'src/components/shared';
const HELPER_DIRECTORY_FALLBACKS = [
  'components/shared',
  'src/components',
  'components'
];
const COMPONENT_LIKE_PATTERN = /co[mn]*p.*nent/i;
const HELPER_SLUG_LEADING_FILLERS = new Set([
  'have',
  'has',
  'having',
  'get',
  'getting',
  'got',
  'need',
  'needs',
  'needing',
  'make',
  'makes',
  'making',
  'want',
  'wants',
  'wanting',
  'require',
  'requires',
  'requiring'
]);
const PRIMARY_COMPONENT_MATCH_TOKENS = new Set(['refactor', 'update', 'fix', 'cleanup', 'convert', 'rewrite', 'change', 'existing', 'current', 'primary', 'main']);
const COMPONENT_TOKEN_PATTERN = /(component|components|comnponent|comnponents|helper|helpers)/g;
const REPEATED_BLOCK_KEYWORDS = [
  'buttons',
  'button group',
  'cards',
  'rows',
  'columns',
  'sections',
  'panels',
  'blocks',
  'list',
  'lists',
  'items',
  'inputs',
  'fields',
  'tabs',
  'modals',
  'drawers',
  'steps',
  'hooks',
  'handlers'
];
const MULTI_BLOCK_KEYWORDS = ['multiple', 'many', 'several', 'group of', 'set of', 'collection of', 'bunch of'];
const PRIMARY_COMPONENT_CONTEXT_PATTERNS = [
  /refactor\s+the\s+$/i,
  /update\s+the\s+$/i,
  /fix\s+the\s+$/i,
  /existing\s+$/i,
  /current\s+$/i,
  /primary\s+$/i
];
const UI_GOAL_KEYWORDS = ['component', 'button', 'layout', 'ui', 'page', 'screen', 'modal', 'card'];
const LOGIC_GOAL_KEYWORDS = ['service', 'api', 'auth', 'store', 'state', 'logic', 'backend'];
const UI_PATH_BLOCKLIST = [/\/services\//i, /\/store\//i, /\/hooks\//i];
const LOGIC_PATH_BLOCKLIST = [/\/components\//i, /\/pages\//i];
const PROTECTED_FILE_PATTERNS = [/authenticationservice/i];
const MIN_EMBEDDING_STRONG_SCORE = 0.8;
const CANDIDATE_PATH_IGNORE = [
  /^\.|\/\./,
  /^node_modules\//i,
  /^dist\//i,
  /^build\//i,
  /^coverage\//i,
  /^charts\//i,
  /^scripts\//i,
  /\.lock$/,
  /\.log$/i,
  /^package-lock\.json$/i,
  /^yarn\.lock$/i
];
const HELPER_INTENT_KEYWORDS = ['new', 'separate', 'dedicated', 'standalone', 'extract', 'pull', 'factor', 'split', 'break', 'modularize'];
const HELPER_PATH_HINT_PATTERN = /(?:^|\/)(?:components?|helpers?|hooks?|shared)(?:\/|$)/i;
const HELPER_FILE_NAME_HINT_PATTERN = /(helper|hook|widget|component)/i;

interface PlannerGenerateOptions {
  metadata?: Record<string, unknown>;
}

interface GoalInferenceMetadata {
  intent?: string;
  files: string[];
}

interface WorkspaceIndexFileSummary {
  path: string;
  size?: number;
  hash?: string;
  preview?: string;
}

interface WorkspaceIndexMetadataSummary {
  totalFiles?: number;
  totalBytes?: number;
  files: WorkspaceIndexFileSummary[];
}

interface CandidateFileEntry {
  path: string;
  score: number;
  reason: string;
  source: 'workspace' | 'embedding' | 'helper' | 'related' | 'context';
}

interface HelperPlanTarget {
  id: string;
  path: string;
  label: string;
  pathRef: string;
  rewriteOutputRef: string;
  diffStoreKey: string;
  reviewStoreKey: string;
  snippetRef: string;
}

interface RelatedPlanTarget {
  id: string;
  path: string;
  label: string;
  pathRef: string;
  contentRef: string;
  rewriteOutputRef: string;
  diffStoreKey: string;
  reviewStoreKey: string;
}

interface EmbeddingPlanCandidate {
  path: string;
  score?: number;
}

type HelperCandidateSource = 'slug' | 'inference' | 'embedding' | 'pathHint';

interface HelperCandidate {
  path: string;
  source: HelperCandidateSource;
  score?: number;
}

interface RewriteStepOverrides {
  title?: string;
  details?: string;
  pathRef?: string;
  contentRef?: string;
  outputKey?: string;
  instructions?: string;
  targetFile?: string;
  filesToEdit?: string[];
  filesToReadOnly?: string[];
  metadata?: Record<string, unknown>;
}

interface ApplyStepOverrides {
  title?: string;
  details?: string;
  pathRef?: string;
  contentRef?: string;
  originalContentRef?: string | null;
  diffStoreKey?: string | null;
  additionalWritesRef?: string | null;
  metadata?: Record<string, unknown>;
  requiredFileEntries?: string[];
  targetFile?: string;
}

interface ReviewStepOverrides {
  title?: string;
  details?: string;
  pathRef?: string | null;
  diffRef?: string | null;
  originalContentRef?: string | null;
  updatedContentRef?: string | null;
  storeKey?: string | null;
  touchedFilesRef?: string | null;
  diagnosticsRef?: string | null;
  metadata?: Record<string, unknown>;
  targetFile?: string;
}

const createId = (): string => randomUUID();

const createScanStep = (): PlanStep => ({
  id: createId(),
  title: 'Scan repository',
  details: 'Collect project structure, package metadata, and candidate files.',
  command: 'python:scanProject',
  action: {
    type: 'python',
    name: 'scanProject',
    params: {
      maxDepth: 5,
      maxFiles: 400,
      includeExtensions: DEFAULT_SCAN_EXTENSIONS
    },
    storeKey: 'project'
  }
});

const createRunScriptsStep = (scripts: string[]): PlanStep => ({
  id: createId(),
  title: 'Run project scripts',
  details: scripts.length
    ? `Execute the requested scripts: ${scripts.join(', ')}.`
    : 'Execute available lint/test scripts to validate the changes.',
  command: 'internal:runProjectScripts',
  action: {
    type: 'internal',
    name: 'runProjectScripts',
    ...(scripts.length ? { scripts } : {})
  }
});

const createMessageStep = (title: string, details: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): PlanStep => ({
  id: createId(),
  title,
  details,
  action: {
    type: 'internal',
    name: 'emitMessage',
    message,
    level
  }
});

const summarizePatterns = (patterns: string[]): string => {
  if (patterns.length === 0) {
    return 'goal keywords';
  }
  return patterns
    .slice(0, 5)
    .map((pattern) => (pattern.length > 40 ? `${pattern.slice(0, 37)}…` : pattern))
    .join(', ');
};

const createLocateFilesStep = (
  patterns: string[],
  priorityKeywords: string[],
  storePath: string,
  focusLabel: string,
  primaryPathHint?: string,
  excludePrefixes?: string[]
): PlanStep => {
  const normalizedHint = typeof primaryPathHint === 'string' ? sanitizeRelativePath(primaryPathHint) : undefined;
  const normalizedExcludes = Array.isArray(excludePrefixes)
    ? excludePrefixes
      .map((prefix) => sanitizeRelativePath(prefix))
      .filter((prefix) => prefix.length > 0)
    : undefined;
  return {
    id: createId(),
    title: 'Locate relevant files',
    details: `Search the repository for goal keywords (${summarizePatterns(patterns)}) to find ${focusLabel}.`,
    action: {
      type: 'internal',
      name: 'locateFiles',
      patterns,
      priorityKeywords,
      storePath,
      primaryPathHint: normalizedHint && normalizedHint.length > 0 ? normalizedHint : undefined,
      excludePrefixes: normalizedExcludes && normalizedExcludes.length > 0 ? normalizedExcludes : undefined,
      maxMatches: Math.min(Math.max(patterns.length * 2, 5), 10)
    }
  };
};

const createReadPrimaryMatchStep = (storePath: string): PlanStep => ({
  id: createId(),
  title: 'Read primary match',
  details: 'Load the top matched file from locateFiles to gather project context.',
  command: 'python:readFile',
  action: {
    type: 'python',
    name: 'readFile',
    pathRef: `${storePath}.primary.path`,
    storeKey: `${storePath}.primary.content`
  }
});

const createConfirmTargetStep = (): PlanStep =>
  createMessageStep(
    'Confirm target file',
    'Verify that the identified file aligns with the requested goal before proceeding.',
    'I loaded the top matched file from locateFiles. If this is not the correct file, please provide the workspace-relative path or attach the right file so I can continue.'
  );

const createExtractSnippetStep = (): PlanStep => ({
  id: createId(),
  title: 'Extract relevant snippet',
  details: 'Isolate the UI block from the caller before generating helpers.',
  action: {
    type: 'internal',
    name: 'extractRelevantSection',
    pathRef: 'focus.primary.path',
    contentRef: 'focus.primary.content',
    patterns: ['Button', 'Google', 'login', 'Stack'],
    storeKey: DEFAULT_SNIPPET_REF
  }
});

const createRewriteFocusStep = (goal: string, overrides?: RewriteStepOverrides): PlanStep => {
  const instructions = overrides?.instructions ?? composePrimaryRewriteInstructions(goal, overrides?.filesToEdit);
  const filesToEdit = normalizePathList(overrides?.filesToEdit);
  const filesToReadOnly = normalizePathList(overrides?.filesToReadOnly);
  return {
    id: createId(),
    title: overrides?.title ?? 'Draft updated changes',
    details: overrides?.details ?? 'Use the model to update the identified file according to the goal.',
    action: {
      type: 'llmRewrite',
      pathRef: overrides?.pathRef ?? 'focus.primary.path',
      contentRef: overrides?.contentRef ?? 'focus.primary.content',
      outputKey: overrides?.outputKey ?? 'focus.primary.rewrite',
      instructions
    },
    targetFile: overrides?.targetFile,
    filesToEdit,
    filesToReadOnly,
    metadata: overrides?.metadata
  };
};

const buildFilesBlockSample = (paths: string[]): string => {
  const normalized = paths.filter((path) => typeof path === 'string' && path.trim().length > 0);
  const entries = normalized.length > 0 ? normalized : ['<path to update>'];
  const lines: string[] = ['```files'];
  entries.forEach((path, index) => {
    lines.push(`FILE: ${path}`);
    lines.push('<entire updated file>');
    if (index !== entries.length - 1) {
      lines.push('');
    }
  });
  lines.push('```');
  return lines.join('\n');
};

const shouldPreservePrimaryImplementation = (goal: string, expectedFiles?: string[]): boolean => {
  if (!goal || !expectedFiles || expectedFiles.length < 2) {
    return false;
  }
  if (!DOMAIN_FOLDER_PATTERN.test(goal)) {
    return false;
  }
  return expectedFiles.some(
    (file) => DOMAIN_FILE_PATH_PATTERN.test(file) && file.toLowerCase().endsWith('.cs')
  );
};

const composePrimaryRewriteInstructions = (goal: string, expectedFiles?: string[]): string => {
  const needsAdditionalFiles = goalSuggestsAdditionalFiles(goal);
  const fileEntries = expectedFiles && expectedFiles.length > 0
    ? [...expectedFiles]
    : ['<path to update>'];
  if (needsAdditionalFiles && fileEntries.length < 2) {
    fileEntries.push('<path to new file>');
  }
  const instructions = [
    'You are updating the currently loaded file. Apply the following user goal while respecting existing logic, imports, and types.',
    'Return ONLY a ```files code block that lists every file you modify. No other text may appear before or after the block.',
    buildFilesBlockSample(fileEntries),
    'Always list the current file first. For each FILE entry, provide the complete file contents with correct imports/exports.',
    'Use bare relative import paths (no .ts/.tsx extensions) so TypeScript does not raise TS5097 errors.'
  ];
  if (needsAdditionalFiles) {
    instructions.push(
      'The user specifically mentioned new helpers/components/files. Add each required file as another FILE entry in the ```files block with its full contents and updated imports/exports.'
    );
  }
  instructions.push(
    'Even if the primary file is unchanged, still include its full contents in the first FILE entry.'
  );
  if (shouldPreservePrimaryImplementation(goal, expectedFiles)) {
    instructions.push(
      'Preserve the existing primary file implementation. Only move the requested domain class into the new domain file and update references/usings. Do not stub or replace existing logic.'
    );
  }
  instructions.push(`User goal: ${goal}`);
  return instructions.join('\n\n');
};

const createApplyFocusStep = (overrides?: ApplyStepOverrides): PlanStep => {
  const metadata = {
    ...(overrides?.metadata ?? {}),
    ...(overrides?.requiredFileEntries && overrides.requiredFileEntries.length > 0
      ? { requiredFileEntries: overrides.requiredFileEntries }
      : {})
  };
  const resolvedMetadata = Object.keys(metadata).length > 0 ? metadata : undefined;
  const action: {
    type: 'python';
    name: 'writeFile';
    pathRef: string;
    contentRef: string;
    originalContentRef?: string;
    diffStoreKey?: string;
    additionalWritesRef?: string;
  } = {
    type: 'python',
    name: 'writeFile',
    pathRef: overrides?.pathRef ?? 'focus.primary.path',
    contentRef: overrides?.contentRef ?? 'focus.primary.rewrite'
  };

  if (overrides?.originalContentRef === null) {
    // explicit opt-out
  } else if (typeof overrides?.originalContentRef === 'string') {
    action.originalContentRef = overrides.originalContentRef;
  } else {
    action.originalContentRef = 'focus.primary.content';
  }

  if (overrides?.diffStoreKey === null) {
    // leave undefined
  } else if (typeof overrides?.diffStoreKey === 'string') {
    action.diffStoreKey = overrides.diffStoreKey;
  } else {
    action.diffStoreKey = 'focus.primary.diff';
  }

  if (!overrides || overrides.additionalWritesRef === undefined) {
    action.additionalWritesRef = 'focus.primary.additionalWrites';
  } else if (typeof overrides.additionalWritesRef === 'string' && overrides.additionalWritesRef.trim().length > 0) {
    action.additionalWritesRef = overrides.additionalWritesRef;
  } else {
    action.additionalWritesRef = '';
  }

  return {
    id: createId(),
    title: overrides?.title ?? 'Apply file update',
    details: overrides?.details ?? 'Write the updated content back to disk.',
    command: 'python:writeFile',
    action,
    targetFile: overrides?.targetFile,
    metadata: resolvedMetadata
  };
};

const createReviewFocusStep = (overrides?: ReviewStepOverrides): PlanStep => {
  const action: {
    type: 'internal';
    name: 'reviewDiff';
    pathRef?: string;
    diffRef?: string;
    originalContentRef?: string;
    updatedContentRef?: string;
    storeKey?: string;
    touchedFilesRef?: string;
    diagnosticsRef?: string;
  } = {
    type: 'internal',
    name: 'reviewDiff'
  };

  if (overrides?.pathRef === null) {
    // skip
  } else {
    action.pathRef = overrides?.pathRef ?? 'focus.primary.path';
  }

  if (overrides?.diffRef === null) {
    // skip
  } else {
    action.diffRef = overrides?.diffRef ?? 'focus.primary.diff';
  }

  if (overrides?.originalContentRef === null) {
    // skip
  } else {
    action.originalContentRef = overrides?.originalContentRef ?? 'focus.primary.content';
  }

  if (overrides?.updatedContentRef === null) {
    // skip
  } else {
    action.updatedContentRef = overrides?.updatedContentRef ?? 'focus.primary.rewrite';
  }

  if (overrides?.storeKey === null) {
    // skip
  } else {
    action.storeKey = overrides?.storeKey ?? 'focus.primary.review';
  }

  if (overrides?.touchedFilesRef === null) {
    // skip
  } else {
    action.touchedFilesRef = overrides?.touchedFilesRef ?? 'focus.primary.touchedFiles';
  }

  if (overrides?.diagnosticsRef === null) {
    // skip
  } else {
    action.diagnosticsRef = overrides?.diagnosticsRef ?? 'focus.primary.diagnostics';
  }

  return {
    id: createId(),
    title: overrides?.title ?? 'Review updated file',
    details: overrides?.details ?? 'Compare the revised file against the original to surface possible regressions before finishing.',
    action,
    targetFile: overrides?.targetFile,
    metadata: overrides?.metadata
  };
};

const sanitizeRelativePath = (value: string): string => value
  .replace(/\\+/g, '/')
  .replace(/^\.\/+/, '')
  .replace(/^\/+/, '')
  .replace(/\/+/g, '/');

const normalizePathList = (paths?: unknown): string[] | undefined => {
  if (!Array.isArray(paths)) {
    return undefined;
  }
  const normalized = paths
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => sanitizeRelativePath(value).trim())
    .filter((value) => value.length > 0);
  const unique = normalized.filter((value, index) => normalized.indexOf(value) === index);
  return unique.length > 0 ? unique : undefined;
};

const normalizePrimaryFocusCandidate = (
  value: string | undefined,
  helperDirPrefix: string
): string | undefined => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  const normalized = sanitizeRelativePath(value);
  if (!normalized || normalized.length === 0 || normalized.indexOf('/') === -1) {
    return undefined;
  }
  if (normalized.toLowerCase().startsWith(helperDirPrefix)) {
    return undefined;
  }
  return normalized;
};

const selectPrimaryFocusPath = (
  signals: GoalSignals,
  embeddingAlignedFiles: string[],
  helperDirPrefix: string,
  options?: { allowPatternFallback?: boolean }
): string | undefined => {
  const allowPatternFallback = options?.allowPatternFallback !== false;
  // When the goal explicitly names a bare filename (e.g. "app.tsx"), prefer
  // embedding candidates whose path ends with that filename before falling
  // back to the raw top embedding result. This prevents a semantically
  // similar-but-wrong file (e.g. additionalWrites.ts from "core runtime")
  // from displacing the explicitly intended target.
  const focusFile = signals.focusFileName?.toLowerCase();
  const orderedEmbeddings = focusFile
    ? [
        ...embeddingAlignedFiles.filter((f) => f.toLowerCase().endsWith(`/${focusFile}`)),
        ...embeddingAlignedFiles.filter((f) => !f.toLowerCase().endsWith(`/${focusFile}`))
      ]
    : embeddingAlignedFiles;
  const candidates: Array<string | undefined> = [
    signals.primaryPathHint,
    ...orderedEmbeddings
  ];
  if (allowPatternFallback) {
    candidates.push(...signals.patterns);
  }
  for (const candidate of candidates) {
    const normalized = normalizePrimaryFocusCandidate(candidate, helperDirPrefix);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
};

const goalSuggestsAdditionalFiles = (goal: string): boolean => {
  const normalized = goal.toLowerCase();
  const triggers = [
    'new file',
    'create file',
    'helper file',
    'utility file',
    'extract helper',
    'shared file',
    'component file',
    'another file',
    'separate file',
    'modularize',
    'split into files',
    'new helper',
    'new component',
    'new hook',
    'new folder',
    'create folder',
    'domain folder',
    'domains folder',
    'domain model',
    'move class',
    'extract class',
    'split class'
  ];
  if (triggers.some((phrase) => normalized.includes(phrase))) {
    return true;
  }
  if (HELPER_USAGE_PATTERN.test(goal)) {
    return true;
  }
  for (const match of goal.matchAll(PATH_WITH_DIR_PATTERN)) {
    const sanitized = sanitizeRelativePath(match[0]);
    if (sanitized.toLowerCase().includes('/components/')) {
      return true;
    }
  }
  const componentRefactorPattern = /(refactor|extract|split|separate|break|convert|componentize|modularize)[^.!?]{0,60}(component|components)/;
  const helperPattern = /(extract|create|add|build)[^.!?]{0,60}(helper|hook|utility)/;
  const smallerComponentPattern = /(smaller|separate)\s+components/;
  return componentRefactorPattern.test(normalized) || helperPattern.test(normalized) || smallerComponentPattern.test(normalized);
};

const DOMAIN_FOLDER_PATTERN = /\bdomains?\b/i;
const DOMAIN_FILE_PATH_PATTERN = /\/domains?\//i;
const CLASS_NAME_PATTERN = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
const PASCAL_TOKEN_PATTERN = /\b[A-Z][A-Za-z0-9_]{2,}\b/g;

const extractClassNameFromGoal = (goal: string): string | undefined => {
  if (!goal) {
    return undefined;
  }
  const directMatch = goal.match(CLASS_NAME_PATTERN);
  if (directMatch?.[1]) {
    return directMatch[1];
  }
  const candidates = goal.match(PASCAL_TOKEN_PATTERN) ?? [];
  const filtered = candidates.filter((token) => !token.endsWith('Service'));
  const preferred = filtered.find((token) => /(Info|Model|Dto|Entity)$/.test(token));
  return preferred ?? filtered[0];
};

const resolveDomainDirectory = (primaryPath: string, workspaceFiles?: Set<string>): string | undefined => {
  const normalized = sanitizeRelativePath(primaryPath);
  const segments = normalized.split('/');
  if (segments.length < 2) {
    return undefined;
  }
  const baseDir = segments.slice(0, -1).join('/');
  const baseLower = baseDir.toLowerCase();
  const hasDomains = workspaceFiles
    ? Array.from(workspaceFiles).some((file) => file.startsWith(`${baseLower}/domains/`))
    : false;
  if (hasDomains) {
    return `${baseDir}/Domains`;
  }
  const hasDomain = workspaceFiles
    ? Array.from(workspaceFiles).some((file) => file.startsWith(`${baseLower}/domain/`))
    : false;
  if (hasDomain) {
    return `${baseDir}/Domain`;
  }
  return `${baseDir}/Domains`;
};

const inferDomainFileTargets = (
  goal: string,
  primaryPath?: string,
  workspaceFiles?: Set<string>
): string[] => {
  if (!goal || !primaryPath || !DOMAIN_FOLDER_PATTERN.test(goal)) {
    return [];
  }
  const className = extractClassNameFromGoal(goal);
  if (!className) {
    return [];
  }
  const domainDir = resolveDomainDirectory(primaryPath, workspaceFiles);
  if (!domainDir) {
    return [];
  }
  const candidate = sanitizeRelativePath(`${domainDir}/${className}.cs`);
  if (!candidate) {
    return [];
  }
  if (candidate.toLowerCase() === sanitizeRelativePath(primaryPath).toLowerCase()) {
    return [];
  }
  return [candidate];
};

const goalIndicatesRepeatedBlocks = (goal: string, inference?: GoalInferenceMetadata): boolean => {
  const normalized = goal.toLowerCase();
  if (MULTI_BLOCK_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return true;
  }
  if (REPEATED_BLOCK_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return true;
  }
  const extractionHints = [
    /\bextract\b/,
    /\bfactor\s+out\b/,
    /\bpull\s+out\b/,
    /\bshare(d)?\b/,
    /\breuse\b/,
    /\bduplicate\b/,
    /\brepeat(ed)?\b/
  ];
  if (extractionHints.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (inference?.files?.length) {
    const dirCounts = new Map<string, number>();
    inference.files.forEach((file) => {
      const dir = sanitizeRelativePath(file).toLowerCase().split('/').slice(0, -1).join('/');
      if (!dir) {
        return;
      }
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    });
    if (Array.from(dirCounts.values()).some((count) => count >= 2)) {
      return true;
    }
  }
  return false;
};

const HELPER_USAGE_PATTERN = /\b(use|reuse|leverage|integrat(?:e|ion)|switch|swap|replace)\b[^.!?]{0,80}\b(component|components|helper|helpers|hook|hooks|button|buttons)\b/i;
const MAX_HELPER_SLUG_SEGMENTS = 4;
const MAX_HELPER_SLUG_LENGTH = 48;

const collectTokenFrequency = (goal: string): Map<string, number> => {
  const frequency = new Map<string, number>();
  const tokens = goal.toLowerCase().match(/[a-z0-9][a-z0-9_.-]+/g) ?? [];
  for (const token of tokens) {
    const normalized = token.replace(/^[._-]+|[._-]+$/g, '');
    if (!normalized || normalized.length < 4) {
      continue;
    }
    if (STOP_WORDS.has(normalized) || /^https?:/.test(normalized)) {
      continue;
    }
    frequency.set(normalized, (frequency.get(normalized) ?? 0) + 1);
  }
  return frequency;
};

const selectTopTokens = (frequency: Map<string, number>, limit: number): string[] =>
  Array.from(frequency.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return b[0].length - a[0].length;
    })
    .slice(0, limit)
    .map(([token]) => token);

const slugifyHelperName = (raw: string, fallback: string, priorityTokens?: Set<string>): string => {
  const trimmed = raw.trim().toLowerCase().replace(COMPONENT_TOKEN_PATTERN, '').trim();
  const tokens = trimmed
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .filter((token) => !STOP_WORDS.has(token))
    .filter((token) => !COMPONENT_LIKE_PATTERN.test(token));

  if (tokens.length === 0) {
    return fallback;
  }

  const uniqueTokens: string[] = [];
  for (const token of tokens) {
    if (!uniqueTokens.includes(token)) {
      uniqueTokens.push(token);
    }
  }

  const trimmedLeadingFillers = uniqueTokens.filter((token, index) => {
    if (index === 0 && HELPER_SLUG_LEADING_FILLERS.has(token)) {
      return false;
    }
    return true;
  });

  const prioritized = priorityTokens && priorityTokens.size > 0
    ? trimmedLeadingFillers.filter((token) => priorityTokens.has(token))
    : trimmedLeadingFillers;
  const pool = prioritized.length > 0 ? prioritized : trimmedLeadingFillers;
  const selected = pool.slice(-MAX_HELPER_SLUG_SEGMENTS);

  let slug = selected.join('-').replace(/--+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) {
    slug = fallback;
  }
  if (slug.length > MAX_HELPER_SLUG_LENGTH) {
    slug = slug.slice(-MAX_HELPER_SLUG_LENGTH).replace(/^-+/, '');
  }
  return slug || fallback;
};

const buildHelperPathFromSlug = (slug: string, helperDirectory: string): string => `${helperDirectory}/${slug}.tsx`;

const canonicalizeHelperCandidatePath = (
  desiredPath: string,
  helperDirectory: string,
  workspaceFiles?: Set<string>
): string | undefined => {
  const normalized = sanitizeRelativePath(desiredPath);
  if (!normalized) {
    return undefined;
  }
  if (!workspaceFiles || workspaceFiles.has(normalized.toLowerCase())) {
    return normalized;
  }
  const base = normalized.split('/').pop() ?? '';
  const baseName = base.replace(/\.[^.]+$/, '');
  const slug = slugifyHelperName(baseName, baseName || 'helper');
  return buildHelperPathFromSlug(slug, helperDirectory);
};

const extractHelperSlugsFromGoal = (goal: string): string[] => {
  const matches = new Set<string>();
  const componentPattern = /\b([\w][\w\s/-]{2,40}?)\s+(?:component|components|comnponent|comnponents|helper|helpers)\b/gi;
  const buttonPattern = /\b([\w][\w\s/-]{2,40}?)\s+(?:button|buttons)\b/gi;
  const priorityTokens = new Set(selectTopTokens(collectTokenFrequency(goal), 8));
  let result: RegExpExecArray | null;
  let slugIndex = 0;
  while ((result = componentPattern.exec(goal)) !== null) {
    const matchStart = result.index ?? componentPattern.lastIndex - (result[0]?.length ?? 0);
    if (isPrimaryComponentReference(goal, matchStart, result[1])) {
      continue;
    }
    const slug = slugifyHelperName(result[1], `helper-${slugIndex + 1}`, priorityTokens);
    matches.add(slug);
    slugIndex += 1;
  }
  while ((result = buttonPattern.exec(goal)) !== null) {
    const matchIndex = result.index ?? buttonPattern.lastIndex - (result[0]?.length ?? 0);
    if (!hasHelperIntentNearIndex(goal, matchIndex)) {
      continue;
    }
    const slug = slugifyHelperName(`${result[1]}-buttons`, `helper-${slugIndex + 1}`, priorityTokens);
    if (isGenericButtonSlug(slug)) {
      continue;
    }
    matches.add(slug);
    slugIndex += 1;
  }
  return Array.from(matches);
};

const isGenericButtonSlug = (slug: string): boolean => {
  const normalized = slug.trim().toLowerCase();
  return normalized === 'button' || normalized === 'buttons';
};

const hasHelperIntentNearIndex = (goal: string, index: number): boolean => {
  const windowStart = Math.max(0, index - 80);
  const window = goal.slice(windowStart, index).toLowerCase();
  return HELPER_INTENT_KEYWORDS.some((keyword) => window.includes(keyword));
};

const isPrimaryComponentReference = (goal: string, index: number, matchText?: string): boolean => {
  if (matchText) {
    const normalized = matchText.trim().toLowerCase();
    if (normalized.length > 0) {
      const tokens = normalized.split(/[^a-z0-9]+/g).filter((token) => token.length > 0);
      const firstToken = tokens[0];
      if (firstToken && PRIMARY_COMPONENT_MATCH_TOKENS.has(firstToken)) {
        return true;
      }
      if (tokens.length > 1 && firstToken === 'the' && PRIMARY_COMPONENT_MATCH_TOKENS.has(tokens[1])) {
        return true;
      }
    }
  }
  if (index <= 0) {
    return false;
  }
  const windowStart = Math.max(0, index - 48);
  const preceding = goal.slice(windowStart, index).toLowerCase();
  return PRIMARY_COMPONENT_CONTEXT_PATTERNS.some((pattern) => pattern.test(preceding));
};

const extractGoalInference = (metadata?: Record<string, unknown>): GoalInferenceMetadata | undefined => {
  if (!metadata || typeof metadata.goalInference !== 'object' || metadata.goalInference === null) {
    return undefined;
  }
  const inference = metadata.goalInference as Record<string, unknown>;
  const intent = typeof inference.intent === 'string' ? inference.intent.toLowerCase() : undefined;
  const rawFiles = Array.isArray(inference.files) ? inference.files : [];
  const files = rawFiles
    .filter((file): file is string => typeof file === 'string' && file.trim().length > 0)
    .map((file) => sanitizeRelativePath(file))
    .filter((value) => HELPER_FILE_PATTERN.test(value));
  return {
    intent,
    files
  };
};

const extractWorkspaceIndexSummary = (metadata?: Record<string, unknown>): WorkspaceIndexMetadataSummary | undefined => {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const rawSummary = (metadata as { workspaceIndex?: unknown }).workspaceIndex;
  if (!rawSummary || typeof rawSummary !== 'object') {
    return undefined;
  }
  const filesRaw = (rawSummary as { files?: unknown }).files;
  if (!Array.isArray(filesRaw)) {
    return undefined;
  }
  const files: WorkspaceIndexFileSummary[] = filesRaw
    .map((entry): WorkspaceIndexFileSummary | undefined => {
      if (!entry || typeof entry !== 'object') {
        return undefined;
      }
      const rawPath = (entry as { path?: unknown }).path;
      if (typeof rawPath !== 'string') {
        return undefined;
      }
      const normalized = sanitizeRelativePath(rawPath);
      if (!normalized) {
        return undefined;
      }
      const sizeValue = (entry as { size?: unknown }).size;
      const hashValue = (entry as { hash?: unknown }).hash;
      const previewValue = (entry as { preview?: unknown }).preview;
      return {
        path: normalized,
        size: typeof sizeValue === 'number' ? sizeValue : undefined,
        hash: typeof hashValue === 'string' ? hashValue : undefined,
        preview: typeof previewValue === 'string' ? previewValue : undefined
      };
    })
    .filter((entry): entry is WorkspaceIndexFileSummary => Boolean(entry));
  if (!files.length) {
    return undefined;
  }
  return {
    totalFiles: typeof (rawSummary as { totalFiles?: unknown }).totalFiles === 'number'
      ? (rawSummary as { totalFiles?: number }).totalFiles
      : files.length,
    totalBytes: typeof (rawSummary as { totalBytes?: unknown }).totalBytes === 'number'
      ? (rawSummary as { totalBytes?: number }).totalBytes
      : undefined,
    files
  };
};

const buildWorkspaceFileSet = (summary?: WorkspaceIndexMetadataSummary): Set<string> | undefined => {
  if (!summary?.files?.length) {
    return undefined;
  }
  const set = new Set<string>();
  summary.files.forEach((file) => {
    set.add(file.path.toLowerCase());
  });
  return set;
};

const buildWorkspaceDirectorySet = (
  summary?: WorkspaceIndexMetadataSummary
): Set<string> | undefined => {
  if (!summary?.files?.length) {
    return undefined;
  }
  const directories = new Set<string>();
  summary.files.forEach((file) => {
    const normalized = sanitizeRelativePath(file.path);
    if (!normalized) {
      return;
    }
    const parts = normalized.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join('/').toLowerCase();
      if (directory) {
        directories.add(directory);
      }
    }
  });
  return directories;
};

const directoryExistsInWorkspace = (
  directory: string,
  directories: Set<string>
): boolean => {
  if (!directory) {
    return false;
  }
  const normalized = sanitizeRelativePath(directory).replace(/\/+$/, '');
  if (!normalized) {
    return false;
  }
  const lowered = normalized.toLowerCase();
  if (directories.has(lowered)) {
    return true;
  }
  for (const entry of directories) {
    if (entry.endsWith(`/${lowered}`)) {
      return true;
    }
  }
  return false;
};

const shouldDisplayCandidatePath = (pathValue: string): boolean => {
  const normalized = pathValue.toLowerCase();
  if (!normalized) {
    return false;
  }
  if (CANDIDATE_PATH_IGNORE.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return true;
};

const buildCandidateScore = ({
  path,
  source,
  baseWeight,
  helperLookup,
  relatedLookup,
  embeddingScores,
  goalTokens
}: {
  path: string;
  source: CandidateFileEntry['source'];
  baseWeight: number;
  helperLookup: Set<string>;
  relatedLookup: Set<string>;
  embeddingScores: Map<string, number>;
  goalTokens: Set<string>;
}): { score: number; reasonParts: string[] } => {
  let score = baseWeight;
  const reasonParts: string[] = [];
  const lowered = path.toLowerCase();
  const embeddingScore = embeddingScores.get(lowered);
  if (typeof embeddingScore === 'number' && embeddingScore > 0) {
    score += embeddingScore * 100;
    reasonParts.push(`embedding ${embeddingScore.toFixed(2)}`);
  }
  const keywordMatches = Array.from(goalTokens).filter(
    (token) => token.length > 2 && lowered.includes(token)
  );
  if (keywordMatches.length > 0) {
    score += keywordMatches.length * 6;
    reasonParts.push(`matches ${keywordMatches.slice(0, 3).join(', ')}`);
  }
  if (lowered.startsWith('src/')) {
    score += 8;
    reasonParts.push('inside src');
  }
  if (helperLookup.has(lowered)) {
    score += 25;
    reasonParts.push('helper target');
  }
  if (relatedLookup.has(lowered)) {
    score += 20;
    reasonParts.push('related target');
  }
  if (source === 'context') {
    score += 15;
    reasonParts.push('attached context');
  }
  if (source === 'workspace') {
    score += 5;
  } else if (source === 'embedding') {
    score += 3;
  }
  return { score, reasonParts };
};

const buildFeaturedFileList = (input: {
  workspaceSummary?: WorkspaceIndexMetadataSummary;
  embeddingCandidates: EmbeddingPlanCandidate[];
  helperTargets: HelperPlanTarget[];
  relatedTargets: RelatedPlanTarget[];
  contextFiles: string[];
  goalTokens: Set<string>;
}): CandidateFileEntry[] => {
  const entries = new Map<string, CandidateFileEntry>();
  const helperLookup = new Set(input.helperTargets.map((target) => target.path.toLowerCase()));
  const relatedLookup = new Set(input.relatedTargets.map((target) => target.path.toLowerCase()));
  const embeddingScores = buildEmbeddingScoreMap(input.embeddingCandidates);

  const addEntry = (
    pathValue: string | undefined,
    source: CandidateFileEntry['source'],
    baseWeight: number
  ) => {
    if (!pathValue) {
      return;
    }
    const normalized = sanitizeRelativePath(pathValue);
    if (!normalized || !shouldDisplayCandidatePath(normalized)) {
      return;
    }
    const lowered = normalized.toLowerCase();
    const current = entries.get(lowered);
    const { score, reasonParts } = buildCandidateScore({
      path: normalized,
      source,
      baseWeight,
      helperLookup,
      relatedLookup,
      embeddingScores,
      goalTokens: input.goalTokens
    });
    const reason = reasonParts.join('; ');
    const nextEntry: CandidateFileEntry = {
      path: normalized,
      score,
      reason,
      source
    };
    if (!current || score > current.score) {
      entries.set(lowered, nextEntry);
    }
  };

  input.workspaceSummary?.files.forEach((file, index) => {
    addEntry(file.path, 'workspace', Math.max(0, 40 - index));
  });
  input.embeddingCandidates.forEach((candidate, index) => {
    addEntry(candidate.path, 'embedding', Math.max(0, 20 - index));
  });
  input.contextFiles.forEach((path, index) => {
    addEntry(path, 'context', Math.max(0, 50 - index));
  });
  input.helperTargets.forEach((target) => addEntry(target.path, 'helper', 30));
  input.relatedTargets.forEach((target) => addEntry(target.path, 'related', 25));

  return Array.from(entries.values()).sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.path.localeCompare(b.path);
  });
};

const createCandidateFilesStep = (entries: CandidateFileEntry[]): PlanStep | undefined => {
  if (!entries.length) {
    return undefined;
  }
  const selection = entries.slice(0, 10);
  const formatted = selection.map((entry) => {
    const detail = entry.reason ? ` — ${entry.reason}` : '';
    return `${entry.path} (score ${entry.score.toFixed(1)})${detail}`;
  });
  const body = ['Candidate files:', '```', ...formatted, '```'].join('\n');
  return createMessageStep(
    'Candidate files identified',
    'Review these repository paths (derived from workspace index + embeddings) before editing.',
    body,
    'info'
  );
};

const validatePlanTargets = (
  steps: PlanStep[],
  workspaceFiles?: Set<string>,
  summary?: WorkspaceIndexMetadataSummary
): { missing: string[] } => {
  if (!workspaceFiles || workspaceFiles.size === 0) {
    return { missing: [] };
  }
  const missing: string[] = [];
  steps.forEach((step) => {
    if (!shouldValidateTarget(step)) {
      return;
    }
    const normalized = sanitizeRelativePath(step.targetFile ?? '') ?? step.targetFile ?? '';
    const lowered = normalized.toLowerCase();
    if (workspaceFiles.has(lowered)) {
      step.targetFile = normalized;
      return;
    }
    const resolved = resolveWorkspaceMatch(normalized, summary);
    if (resolved) {
      step.targetFile = resolved.path;
      step.details = `${step.details}\n\nAuto-selected closest file: ${resolved.path}`;
      const metadata = step.metadata ?? {};
      metadata.resolvedFrom = normalized;
      step.metadata = metadata;
      return;
    }
    missing.push(normalized);
  });
  return { missing };
};

const shouldValidateTarget = (step: PlanStep): boolean => {
  if (!step.targetFile) {
    return false;
  }
  const metadata = step.metadata as { chainKind?: string } | undefined;
  if (metadata?.chainKind === 'helper') {
    return false;
  }
  return true;
};

const resolveWorkspaceMatch = (pathValue: string, summary?: WorkspaceIndexMetadataSummary): WorkspaceIndexFileSummary | undefined => {
  if (!summary?.files?.length || !pathValue) {
    return undefined;
  }
  const normalized = sanitizeRelativePath(pathValue) ?? pathValue;
  const lowered = normalized.toLowerCase();
  const direct = summary.files.find((file) => file.path.toLowerCase() === lowered);
  if (direct) {
    return direct;
  }
  const basename = normalized.split('/').pop();
  if (!basename) {
    return undefined;
  }
  const basenameLower = basename.toLowerCase();
  const byBasename = summary.files.find((file) => file.path.toLowerCase().endsWith(`/${basenameLower}`) || file.path.toLowerCase() === basenameLower);
  return byBasename;
};

const createMissingPathStep = (missing: string[]): PlanStep => {
  const formatted = missing.slice(0, 8).map((path) => `- ${path}`).join('\n');
  const overflow = missing.length > 8 ? `\n…${missing.length - 8} more` : '';
  return createMessageStep(
    'Confirm file paths',
    'Some planned edits reference files that do not exist in the workspace. Please confirm the correct paths or add the missing files.',
    `The following files are unknown:\n${formatted}${overflow}`,
    'warn'
  );
};

const shouldExtractHelpers = (goal: string, inference?: GoalInferenceMetadata): boolean => {
  const referencedHelpers = Boolean(
    inference?.files?.some((file) => file.toLowerCase().includes('/components/'))
  );
  if (referencedHelpers) {
    return true;
  }
  if (!goalSuggestsAdditionalFiles(goal)) {
    return false;
  }
  return goalIndicatesRepeatedBlocks(goal, inference);
};

const resolveHelperDirectory = (
  inference: GoalInferenceMetadata | undefined,
  embeddings: EmbeddingPlanCandidate[],
  workspaceDirectories?: Set<string>,
  contextFiles: string[] = []
): string => {
  const candidates = new Set<string>();
  const addDirectory = (input?: string) => {
    if (typeof input !== 'string' || !input.trim()) {
      return;
    }
    const normalized = sanitizeRelativePath(input);
    if (!normalized) {
      return;
    }
    const slashIndex = normalized.lastIndexOf('/');
    if (slashIndex === -1) {
      return;
    }
    const directory = normalized.slice(0, slashIndex);
    if (directory) {
      candidates.add(directory);
    }
  };

  (inference?.files ?? []).forEach((file) => addDirectory(file));
  embeddings.forEach((candidate) => addDirectory(candidate.path));
  contextFiles.forEach((file) => addDirectory(file));

  const directoryLookup =
    workspaceDirectories && workspaceDirectories.size > 0 ? workspaceDirectories : undefined;
  const ordered = Array.from(candidates);
  const candidatePool =
    directoryLookup && ordered.length > 0
      ? ordered.filter((dir) => directoryExistsInWorkspace(dir, directoryLookup))
      : ordered;
  const preferenceList = [...HELPER_DIRECTORY_FALLBACKS, DEFAULT_HELPER_DIRECTORY];
  for (const preference of preferenceList) {
    const normalizedPref = preference.toLowerCase();
    const match = candidatePool.find((dir) => {
      const normalizedDir = dir.toLowerCase();
      return normalizedDir === normalizedPref || normalizedDir.endsWith(`/${normalizedPref}`);
    });
    if (match) {
      return match;
    }
  }
  const componentMatch = candidatePool.find((dir) => dir.toLowerCase().includes('components'));
  if (componentMatch) {
    return componentMatch;
  }
  if (candidatePool.length > 0) {
    return candidatePool[0];
  }
  if (directoryLookup) {
    const fallbackExisting = preferenceList.find((preference) =>
      directoryExistsInWorkspace(preference, directoryLookup)
    );
    if (fallbackExisting) {
      return fallbackExisting;
    }
  }
  return DEFAULT_HELPER_DIRECTORY;
};

const deriveHelperTargets = (
  goal: string,
  inference: GoalInferenceMetadata | undefined,
  primaryHints: string | string[] | undefined,
  helperLimit = 1,
  helperDirectory = DEFAULT_HELPER_DIRECTORY,
  embeddingCandidates: EmbeddingPlanCandidate[] = [],
  workspaceFiles?: Set<string>
): HelperPlanTarget[] => {
  const expectsHelpers = shouldExtractHelpers(goal, inference);
  if (!expectsHelpers || helperLimit <= 0) {
    return [];
  }
  const helperSlugs = extractHelperSlugsFromGoal(goal);
  const helperSlugSet = new Set(helperSlugs);
  const helperPathHints: string[] = [];
  const helperDirPrefix = `${helperDirectory}/`.toLowerCase();
  for (const match of goal.matchAll(PATH_WITH_DIR_PATTERN)) {
    const sanitizedMatch = sanitizeRelativePath(match[0]);
    if (!sanitizedMatch.toLowerCase().startsWith(helperDirPrefix)) {
      continue;
    }
    helperPathHints.push(sanitizedMatch);
  }
  if (helperSlugs.length === 0 && helperPathHints.length === 0) {
    return [];
  }

  const candidates: HelperCandidate[] = [];
  const seen = new Set<string>();
  const primaryCandidates = Array.isArray(primaryHints) ? primaryHints : primaryHints ? [primaryHints] : [];
  const primaryKeys = new Set(
    primaryCandidates
      .map((value) => sanitizeRelativePath(value))
      .filter((value) => value.length > 0)
      .map((value) => value.toLowerCase())
  );
  const addCandidate = (input: string | undefined, source: HelperCandidateSource) => {
    if (typeof input !== 'string' || !input.trim()) {
      return;
    }
    const normalized = sanitizeRelativePath(input);
    if (!normalized) {
      return;
    }
    const canonical = canonicalizeHelperCandidatePath(normalized, helperDirectory, workspaceFiles);
    if (!canonical) {
      return;
    }
    const lowered = canonical.toLowerCase();
    if (primaryKeys.has(lowered)) {
      return;
    }
    if (workspaceFiles && workspaceFiles.has(lowered)) {
      return;
    }
    if (!HELPER_FILE_PATTERN.test(normalized)) {
      return;
    }
    const key = lowered;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ path: canonical, source });
  };

  helperSlugs.forEach((slug) => addCandidate(buildHelperPathFromSlug(slug, helperDirectory), 'slug'));

  const filteredInferenceFiles = helperSlugSet.size === 0
    ? []
    : (inference?.files ?? []).filter((file) => {
        const base = file.split(/[\\/]/).pop() ?? '';
        const baseSlug = slugifyHelperName(base.replace(/\.[^.]+$/, ''), 'helper');
        return helperSlugSet.has(baseSlug);
      });

  filteredInferenceFiles.forEach((file) => addCandidate(file, 'inference'));
  if (helperSlugSet.size > 0) {
    embeddingCandidates.forEach((candidate) => {
      const sanitizedPath = sanitizeRelativePath(candidate.path);
      if (!sanitizedPath) {
        return;
      }
      const base = sanitizedPath.split(/[\\/]/).pop() ?? '';
      const baseSlug = slugifyHelperName(base.replace(/\.[^.]+$/, ''), 'helper');
      if (helperSlugSet.has(baseSlug)) {
        addCandidate(sanitizedPath, 'embedding');
      }
    });
  }

  helperPathHints.forEach((hint) => addCandidate(hint, 'pathHint'));

  const prioritized = prioritizeHelperCandidates(candidates, helperLimit);
  return prioritized.map((candidate, index) => buildHelperPlanTarget(candidate.path, index));
};

const prioritizeHelperCandidates = (candidates: HelperCandidate[], helperLimit: number): HelperCandidate[] => {
  if (candidates.length === 0 || helperLimit <= 0) {
    return [];
  }
  const order: Record<HelperCandidateSource, number> = {
    inference: 0,
    embedding: 1,
    slug: 2,
    pathHint: 3
  };
  const sorted = [...candidates].sort((a, b) => {
    const diff = order[a.source] - order[b.source];
    if (diff !== 0) {
      return diff;
    }
    return a.path.localeCompare(b.path);
  });
  const unique: HelperCandidate[] = [];
  for (const candidate of sorted) {
    if (unique.some((entry) => entry.path === candidate.path)) {
      continue;
    }
    unique.push(candidate);
    if (unique.length >= Math.min(helperLimit, MAX_HELPER_CHAINS)) {
      break;
    }
  }
  return unique;
};

const deriveRelatedPlanTargets = (
  goal: string,
  inference: GoalInferenceMetadata | undefined,
  exclusions: string[],
  embeddings: EmbeddingPlanCandidate[]
): RelatedPlanTarget[] => {
  const exclusionSet = new Set(
    exclusions
      .map((value) => (typeof value === 'string' ? sanitizeRelativePath(value) : ''))
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase())
  );

  const embeddingScoreMap = buildEmbeddingScoreMap(embeddings);
  const lexicalFiles = (inference?.files ?? [])
    .map((file) => sanitizeRelativePath(file))
    .filter((file): file is string => Boolean(file));
  const embeddingFiles = embeddings
    .map((candidate) => sanitizeRelativePath(candidate.path))
    .filter((file): file is string => Boolean(file));

  if (lexicalFiles.length === 0 || embeddingFiles.length === 0) {
    return [];
  }

  const embeddingSet = new Set(embeddingFiles.map((file) => file.toLowerCase()));
  const weightedCandidates = lexicalFiles
    .filter((file) => embeddingSet.has(file.toLowerCase()))
    .map((file) => ({ path: file, score: embeddingScoreMap.get(file.toLowerCase()) }));

  if (weightedCandidates.length === 0) {
    return [];
  }

  const goalProfile = classifyGoalIntent(goal);
  const ranked = weightedCandidates
    .filter((candidate) => !shouldSkipRelatedTarget(goalProfile, candidate.path, candidate.score))
    .sort((a, b) => {
      const scoreA = typeof a.score === 'number' ? a.score : -1;
      const scoreB = typeof b.score === 'number' ? b.score : -1;
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      return a.path.localeCompare(b.path);
    });

  const selected: string[] = [];
  for (const entry of ranked) {
    const key = entry.path.toLowerCase();
    if (exclusionSet.has(key)) {
      continue;
    }
    exclusionSet.add(key);
    selected.push(entry.path);
    if (selected.length >= MAX_RELATED_FILES) {
      break;
    }
  }

  return selected.map((path, index) => buildRelatedPlanTarget(path, index));
};

const extractEmbeddingCandidates = (metadata?: Record<string, unknown>): EmbeddingPlanCandidate[] => {
  if (!metadata || typeof metadata !== 'object') {
    return [];
  }
  const embeddingRaw = (metadata as { embeddingCandidates?: unknown }).embeddingCandidates;
  if (!Array.isArray(embeddingRaw)) {
    return [];
  }
  const seen = new Set<string>();
  const candidates: EmbeddingPlanCandidate[] = [];
  embeddingRaw.forEach((entry) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const rawPath = (entry as { path?: unknown }).path;
    if (typeof rawPath !== 'string') {
      return;
    }
    const pathValue = sanitizeRelativePath(rawPath);
    if (!pathValue) {
      return;
    }
    const key = pathValue.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const scoreValue = (entry as { score?: unknown }).score;
    const score = typeof scoreValue === 'number' ? scoreValue : undefined;
    candidates.push({ path: pathValue, score });
  });
  candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return candidates;
};

const extractContextFiles = (metadata?: Record<string, unknown>): string[] => {
  if (!metadata || typeof metadata !== 'object') {
    return [];
  }
  const raw = (metadata as { contextFiles?: unknown }).contextFiles;
  return normalizePathList(raw) ?? [];
};

const extractGoalFileHints = (goal: string): string[] => {
  if (!goal) {
    return [];
  }
  const matches = Array.from(goal.matchAll(FILE_NAME_PATTERN)).map((entry) => entry[0]);
  return normalizePathList(matches) ?? [];
};

const resolvePathHints = (
  hints: string[],
  summary?: WorkspaceIndexMetadataSummary
): string[] => {
  if (hints.length === 0) {
    return [];
  }
  const resolved = hints
    .map((hint) => resolveWorkspaceMatch(hint, summary)?.path ?? sanitizeRelativePath(hint) ?? hint)
    .filter((value) => typeof value === 'string' && value.length > 0);
  const unique = resolved.filter((value, index) => resolved.indexOf(value) === index);
  return unique;
};

const filterEmbeddingCandidatesByWorkspace = (
  candidates: EmbeddingPlanCandidate[],
  workspaceFiles?: Set<string>
): EmbeddingPlanCandidate[] => {
  if (!workspaceFiles || workspaceFiles.size === 0) {
    return candidates;
  }
  return candidates.filter((candidate) => workspaceFiles.has(candidate.path.toLowerCase()));
};

const refineGoalSignalsWithEmbeddings = (signals: GoalSignals, embeddings: EmbeddingPlanCandidate[]): GoalSignals => {
  if (!embeddings.length || signals.patterns.length === 0) {
    return signals;
  }
  const embeddingSet = new Set(
    embeddings
      .map((candidate) => sanitizeRelativePath(candidate.path))
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase())
  );
  const prioritized: string[] = [];
  signals.patterns.forEach((pattern) => {
    const normalized = sanitizeRelativePath(pattern);
    if (normalized && embeddingSet.has(normalized.toLowerCase())) {
      prioritized.push(pattern);
    }
  });
  if (prioritized.length === 0) {
    return signals;
  }
  const merged = Array.from(new Set([...prioritized, ...signals.patterns]));
  return {
    ...signals,
    patterns: merged,
    focusLabel: prioritized[0] ?? signals.focusLabel
  };
};

const intersectFilesWithEmbeddings = (
  inference: GoalInferenceMetadata | undefined,
  embeddings: EmbeddingPlanCandidate[],
  workspaceFiles?: Set<string>
): string[] => {
  if (!inference?.files?.length || embeddings.length === 0) {
    return [];
  }
  const scoreMap = buildEmbeddingScoreMap(embeddings);
  const embeddingSet = new Set(scoreMap.keys());
  const sanitizedFiles = inference.files
    .map((file) => sanitizeRelativePath(file))
    .filter((file) => file.length > 0);
  return sanitizedFiles
    .filter((file) => {
      const lowered = file.toLowerCase();
      if (workspaceFiles && !workspaceFiles.has(lowered)) {
        return false;
      }
      return embeddingSet.has(lowered);
    })
    .sort((a, b) => {
      const scoreA = scoreMap.get(a.toLowerCase()) ?? 0;
      const scoreB = scoreMap.get(b.toLowerCase()) ?? 0;
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      return a.localeCompare(b);
    });
};

const prioritizeSignalsWithEmbeddingMatches = (
  signals: GoalSignals,
  matchedPaths: string[],
  helperDirPrefix: string
): GoalSignals => {
  if (!matchedPaths.length) {
    return signals;
  }
  const normalized = matchedPaths.map((path) => sanitizeRelativePath(path)).filter((path) => path.length > 0);
  const preferredPrimary = normalized.find((path) => !path.toLowerCase().startsWith(helperDirPrefix));
  const mergedPatterns = Array.from(new Set([...normalized, ...signals.patterns]));
  const nextPrimary = preferredPrimary ?? normalized[0];
  return {
    ...signals,
    patterns: mergedPatterns.slice(0, 10),
    focusLabel: signals.deferPrimaryHint ? signals.focusLabel : (nextPrimary ?? signals.focusLabel),
    primaryPathHint: signals.deferPrimaryHint ? signals.primaryPathHint : (nextPrimary ?? signals.primaryPathHint)
  };
};

const pruneHelperDirectoryPatterns = (signals: GoalSignals, helperDirPrefix: string): GoalSignals => {
  const filtered = signals.patterns.filter((pattern) => {
    const normalized = sanitizeRelativePath(pattern);
    if (!normalized || !normalized.includes('/')) {
      return true;
    }
    return !normalized.toLowerCase().startsWith(helperDirPrefix);
  });
  if (filtered.length === signals.patterns.length || filtered.length === 0) {
    return signals;
  }
  return {
    ...signals,
    patterns: filtered,
    focusLabel: filtered[0] ?? signals.focusLabel
  };
};

const applyContextFilesToSignals = (
  signals: GoalSignals,
  contextFiles: string[],
  helperDirPrefix: string
): GoalSignals => {
  if (contextFiles.length === 0) {
    return signals;
  }
  const normalized = contextFiles
    .map((path) => sanitizeRelativePath(path))
    .filter((path) => path.length > 0)
    .filter((path) => !path.toLowerCase().startsWith(helperDirPrefix));
  if (normalized.length === 0) {
    return signals;
  }
  const merged = Array.from(new Set([...normalized, ...signals.patterns]));
  const hasPathSeparator = typeof signals.primaryPathHint === 'string' && signals.primaryPathHint.includes('/');
  const nextPrimary = normalized[0] ?? signals.primaryPathHint;
  return {
    ...signals,
    patterns: merged,
    focusLabel: normalized[0] ?? signals.focusLabel,
    primaryPathHint: hasPathSeparator ? signals.primaryPathHint : nextPrimary
  };
};

const determineHelperChainLimit = (
  expectsHelpers: boolean,
  embeddings: EmbeddingPlanCandidate[],
  helperDirPrefix: string
): number => {
  if (!expectsHelpers) {
    return 0;
  }
  if (!embeddings.length) {
    return 1;
  }
  const strongMatches = embeddings.filter(
    (candidate) =>
      candidate.path.toLowerCase().startsWith(helperDirPrefix)
      && (candidate.score ?? 0) >= MIN_EMBEDDING_STRONG_SCORE
  );
  if (strongMatches.length === 0) {
    return 1;
  }
  return Math.min(MAX_HELPER_CHAINS, strongMatches.length);
};

const buildHelperPlanTarget = (path: string, index: number): HelperPlanTarget => {
  const id = `helper-${index + 1}`;
  const storeBase = `${HELPER_STORE_BASE}.${id}`;
  return {
    id,
    path,
    label: formatHelperLabel(path),
    pathRef: `${storeBase}.path`,
    rewriteOutputRef: `${storeBase}.rewrite`,
    diffStoreKey: `${storeBase}.diff`,
    reviewStoreKey: `${storeBase}.review`,
    snippetRef: DEFAULT_SNIPPET_REF
  };
};

const formatHelperLabel = (path: string): string => {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

const formatPathLabel = (path: string): string => {
  const normalized = sanitizeRelativePath(path);
  if (normalized.length <= 48) {
    return normalized;
  }
  return `…${normalized.slice(-48)}`;
};

const buildRelatedPlanTarget = (path: string, index: number): RelatedPlanTarget => {
  const id = `related-${index + 1}`;
  const storeBase = `${RELATED_STORE_BASE}.${id}`;
  return {
    id,
    path,
    label: formatPathLabel(path),
    pathRef: `${storeBase}.path`,
    contentRef: `${storeBase}.content`,
    rewriteOutputRef: `${storeBase}.rewrite`,
    diffStoreKey: `${storeBase}.diff`,
    reviewStoreKey: `${storeBase}.review`
  };
};

const buildEmbeddingScoreMap = (embeddings: EmbeddingPlanCandidate[]): Map<string, number> => {
  const map = new Map<string, number>();
  embeddings.forEach((candidate) => {
    const normalized = sanitizeRelativePath(candidate.path);
    if (!normalized) {
      return;
    }
    const key = normalized.toLowerCase();
    if (!map.has(key)) {
      map.set(key, typeof candidate.score === 'number' ? candidate.score : 0);
    }
  });
  return map;
};

interface GoalIntentProfile {
  uiFocused: boolean;
  logicFocused: boolean;
}

const classifyGoalIntent = (goal: string): GoalIntentProfile => {
  const normalized = goal.toLowerCase();
  const uiFocused = UI_GOAL_KEYWORDS.some((keyword) => normalized.includes(keyword));
  const logicFocused = LOGIC_GOAL_KEYWORDS.some((keyword) => normalized.includes(keyword));
  return { uiFocused, logicFocused };
};

const shouldSkipRelatedTarget = (profile: GoalIntentProfile, path: string, score?: number): boolean => {
  const lowered = path.toLowerCase();
  const candidateScore = score ?? 0;
  if (PROTECTED_FILE_PATTERNS.some((pattern) => pattern.test(lowered)) && candidateScore < 0.85) {
    return true;
  }
  if (profile.uiFocused && UI_PATH_BLOCKLIST.some((pattern) => pattern.test(lowered)) && candidateScore < 0.9) {
    return true;
  }
  if (profile.logicFocused && LOGIC_PATH_BLOCKLIST.some((pattern) => pattern.test(lowered)) && candidateScore < 0.9) {
    return true;
  }
  return false;
};

type HelperStepRole = 'rewrite' | 'write' | 'review';
type RelatedStepRole = 'read' | 'rewrite' | 'write' | 'review';

const createHelperMetadata = (target: HelperPlanTarget, role: HelperStepRole): Record<string, unknown> => ({
  chainKind: 'helper',
  role,
  helperId: target.id,
  helperPath: target.path,
  snippetRef: target.snippetRef,
  pathRef: target.pathRef,
  outputRef: target.rewriteOutputRef,
  diffRef: target.diffStoreKey,
  reviewRef: target.reviewStoreKey
});

const createCallerMetadata = (helpers: HelperPlanTarget[], role: HelperStepRole): Record<string, unknown> => ({
  chainKind: 'caller',
  role,
  helperIds: helpers.map((helper) => helper.id),
  helperPaths: helpers.map((helper) => helper.path),
  snippetRef: DEFAULT_SNIPPET_REF
});

const createRelatedMetadata = (target: RelatedPlanTarget, role: RelatedStepRole): Record<string, unknown> => ({
  chainKind: 'related',
  role,
  targetPath: target.path,
  pathRef: target.pathRef,
  diffRef: target.diffStoreKey,
  reviewRef: target.reviewStoreKey
});

const buildHelperRewriteInstructions = (goal: string, helperPath: string): string => [
  `Extract only the code from focus.extract.section that belongs inside the helper file "${helperPath}". Ignore unrelated caller components or other files referenced in the snippet.`,
  'Represent every UI block, handler, and branch from the snippet inside this helper so the caller can shrink to simple orchestration, but NEVER rewrite the caller file itself.',
  'Export exactly one component/hook/utility for this helper (match the existing helper/component name if present, otherwise derive it from the filename). Do NOT emit extra components, page files, or multiple module headers.',
  'Use a default export for the helper component/hook. If you introduce a named export, also export the same symbol as default so callers can import it consistently.',
  'Define an explicit Props interface or type for any component props and annotate the component or props parameter to avoid implicit any.',
  'Do not include file banners like "// src/foo.tsx", diff fences, conversation markers such as "<start_of_turn>" / "<end_of_turn>", or any other commentary — emit only the exact TypeScript/TSX source for the helper file as a single FILE entry.',
  'Do not import the helper from itself and do not create or modify any other files.',
  'Use bare relative import paths (no .ts/.tsx extensions) so TypeScript does not raise TS5097 errors.',
  'Always include `import React from \'react\';` as the first import (or ensure React is available if the project uses the new JSX runtime).',
  'Import shared libraries once at the top, keep logic self-contained, and expose callbacks/data through typed props or parameters.',
  `Return only a \`\`\`files block with this helper file (no additional files or prose).\n\nUser goal: ${goal}`
].join('\n\n');

const createHelperRewriteStep = (goal: string, target: HelperPlanTarget): PlanStep =>
  createRewriteFocusStep(goal, {
    title: `Create helper ${target.label}`,
    details: `Generate ${target.label} in ${target.path} using the extracted snippet.`,
    pathRef: target.pathRef,
    contentRef: target.snippetRef,
    outputKey: target.rewriteOutputRef,
    instructions: buildHelperRewriteInstructions(goal, target.path),
    targetFile: target.path,
    metadata: createHelperMetadata(target, 'rewrite')
  });

const createHelperApplyStep = (target: HelperPlanTarget): PlanStep =>
  createApplyFocusStep({
    title: `Write helper ${target.label}`,
    details: `Persist ${target.path} with the generated helper.`,
    pathRef: target.pathRef,
    contentRef: target.rewriteOutputRef,
    originalContentRef: null,
    diffStoreKey: target.diffStoreKey,
    additionalWritesRef: null,
    targetFile: target.path,
    metadata: createHelperMetadata(target, 'write')
  });

const createHelperReviewStep = (target: HelperPlanTarget): PlanStep =>
  createReviewFocusStep({
    title: `Review helper ${target.label}`,
    details: `Confirm ${target.path} compiles cleanly and matches the extracted behavior.`,
    pathRef: target.pathRef,
    diffRef: target.diffStoreKey,
    originalContentRef: null,
    updatedContentRef: target.rewriteOutputRef,
    storeKey: target.reviewStoreKey,
    targetFile: target.path,
    metadata: createHelperMetadata(target, 'review')
  });

const composeCallerRewriteInstructions = (
  goal: string,
  helpers: HelperPlanTarget[],
  primaryPath?: string,
  extraFiles?: string[]
): string => {
  const expected = new Set<string>();
  const normalizedPrimary = primaryPath ? sanitizeRelativePath(primaryPath) : undefined;
  expected.add(normalizedPrimary || 'focus.primary.path');
  (extraFiles ?? []).forEach((file) => {
    const normalized = sanitizeRelativePath(file);
    if (normalized) {
      expected.add(normalized);
    }
  });
  helpers.forEach((helper) => expected.add(helper.path));
  const fileBlock = buildFilesBlockSample(Array.from(expected));
  const helperPaths = helpers.map((helper) => helper.path);
  const helperNotes = helperPaths.length
    ? `Helper files already exist (${helperPaths.join(', ')}). Do NOT re-inline their JSX — import and use them.`
    : 'If new helpers are required, add them as additional FILE entries.';
  return [
    'You are updating the caller to use extracted helpers without changing their behavior.',
    'Return ONLY a ```files code block containing every file you update. No prose before or after.',
    fileBlock,
    'Always list the caller file first. Include each file listed above with its full contents when modified.',
    helperNotes,
    'Follow the helper import hints exactly, including whether the helper uses default or named exports.',
    'Use bare relative import paths (no .ts/.tsx extensions) so TypeScript does not raise TS5097 errors.',
    `User goal: ${goal}`
  ].join('\n\n');
};

const createCallerRewriteStep = (goal: string, helpers: HelperPlanTarget[], primaryPath?: string): PlanStep =>
  createRewriteFocusStep(goal, {
    title: 'Update caller file',
    details: 'Replace the inlined logic with the new helper(s) and add the required imports.',
    instructions: composeCallerRewriteInstructions(
      goal,
      helpers,
      primaryPath,
      primaryPath ? [primaryPath] : undefined
    ),
    metadata: createCallerMetadata(helpers, 'rewrite'),
    targetFile: primaryPath,
    filesToEdit: primaryPath ? [primaryPath] : undefined,
    filesToReadOnly: helpers.map((helper) => helper.path)
  });

const createCallerApplyStep = (helpers: HelperPlanTarget[], primaryPath?: string): PlanStep =>
  createApplyFocusStep({
    title: 'Write caller file',
    details: 'Persist the caller with helper imports and usage.',
    metadata: createCallerMetadata(helpers, 'write'),
    targetFile: primaryPath
  });

const createCallerReviewStep = (helpers: HelperPlanTarget[], primaryPath?: string): PlanStep =>
  createReviewFocusStep({
    title: 'Review caller file',
    details: 'Verify the caller diff after helper extraction.',
    metadata: createCallerMetadata(helpers, 'review'),
    targetFile: primaryPath
  });

const composeRelatedRewriteInstructions = (goal: string, targetPath: string): string => {
  const base = composePrimaryRewriteInstructions(goal, [targetPath]);
  const emphasis = [
    `Target file: ${targetPath}`,
    'Only update this file during this step. If an extra file absolutely must change, include it as another FILE entry in the same ```files block and describe why.'
  ].join('\n');
  return `${base}\n\n${emphasis}`;
};

const createRelatedReadStep = (target: RelatedPlanTarget): PlanStep => ({
  id: createId(),
  title: `Read ${target.label}`,
  details: `Load ${target.path} so the model edits the real file rather than hallucinating its contents.`,
  command: 'python:readFile',
  action: {
    type: 'python',
    name: 'readFile',
    pathRef: target.pathRef,
    storeKey: target.contentRef
  },
  targetFile: target.path,
  metadata: createRelatedMetadata(target, 'read')
});

const createRelatedRewriteStep = (goal: string, target: RelatedPlanTarget): PlanStep =>
  createRewriteFocusStep(goal, {
    title: `Update ${target.label}`,
    details: `Apply the goal to ${target.path} using its real contents as context.`,
    pathRef: target.pathRef,
    contentRef: target.contentRef,
    outputKey: target.rewriteOutputRef,
    instructions: composeRelatedRewriteInstructions(goal, target.path),
    targetFile: target.path,
    filesToEdit: [target.path],
    metadata: createRelatedMetadata(target, 'rewrite')
  });

const createRelatedApplyStep = (target: RelatedPlanTarget): PlanStep =>
  createApplyFocusStep({
    title: `Write ${target.label}`,
    details: `Persist the updated version of ${target.path}.`,
    pathRef: target.pathRef,
    contentRef: target.rewriteOutputRef,
    originalContentRef: target.contentRef,
    diffStoreKey: target.diffStoreKey,
    targetFile: target.path,
    metadata: createRelatedMetadata(target, 'write')
  });

const createRelatedReviewStep = (target: RelatedPlanTarget): PlanStep =>
  createReviewFocusStep({
    title: `Review ${target.label}`,
    details: `Surface the diff for ${target.path} before finishing.`,
    pathRef: target.pathRef,
    diffRef: target.diffStoreKey,
    originalContentRef: target.contentRef,
    updatedContentRef: target.rewriteOutputRef,
    storeKey: target.reviewStoreKey,
    targetFile: target.path,
    metadata: createRelatedMetadata(target, 'review')
  });

interface GoalSignals {
  patterns: string[];
  focusLabel: string;
  priorityKeywords: string[];
  primaryPathHint?: string;
  deferPrimaryHint?: boolean;
  focusFileName?: string;
}

const QUOTED_PHRASE_PATTERN = /["'“”‘’]([^"'“”‘’\n]{2,})["'“”‘’]/g;
const TITLE_CASE_PHRASE_PATTERN = /\b([A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)+)\b/g;
const ACRONYM_PATTERN = /\b[A-Z][A-Z0-9]{1,4}\b/g;
const MAX_PHRASE_LENGTH = 80;

const normalizePhrase = (value: string): string => value.trim().replace(/\s+/g, ' ');

const shouldKeepPattern = (pattern: string): boolean => {
  const compact = pattern.replace(/[^a-z0-9]+/g, '');
  if (compact.length >= 3) {
    return true;
  }
  return compact.length >= 2 && /\d/.test(compact);
};

const expandPhrasePatterns = (phrase: string): string[] => {
  const normalized = normalizePhrase(phrase).toLowerCase();
  if (!normalized) {
    return [];
  }
  const compact = normalized.replace(/[^a-z0-9]+/g, '');
  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const snake = normalized.replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const results = [normalized];
  if (compact && compact !== normalized) {
    results.push(compact);
  }
  if (slug && slug !== normalized) {
    results.push(slug);
  }
  if (snake && snake !== normalized && snake !== slug) {
    results.push(snake);
  }
  return results;
};

const buildGoalPhrasePatterns = (goal: string): { phrases: string[]; patterns: string[] } => {
  if (!goal) {
    return { phrases: [], patterns: [] };
  }
  const phrases: string[] = [];
  const addPhrase = (value: string) => {
    const normalized = normalizePhrase(value);
    if (!normalized || normalized.length < 3 || normalized.length > MAX_PHRASE_LENGTH) {
      return;
    }
    phrases.push(normalized);
  };

  for (const match of goal.matchAll(QUOTED_PHRASE_PATTERN)) {
    if (match[1]) {
      addPhrase(match[1]);
    }
  }
  for (const match of goal.matchAll(TITLE_CASE_PHRASE_PATTERN)) {
    if (match[1]) {
      addPhrase(match[1]);
    }
  }
  for (const match of goal.matchAll(ACRONYM_PATTERN)) {
    if (match[0]) {
      addPhrase(match[0]);
    }
  }

  const uniquePhrases = phrases.filter((value, index) => phrases.indexOf(value) === index);
  const patterns: string[] = [];
  const seen = new Set<string>();
  uniquePhrases.forEach((phrase) => {
    expandPhrasePatterns(phrase).forEach((pattern) => {
      const normalized = pattern.trim().toLowerCase();
      if (!normalized || !shouldKeepPattern(normalized)) {
        return;
      }
      if (seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      patterns.push(normalized);
    });
  });

  return { phrases: uniquePhrases, patterns };
};

const analyzeGoal = (goal: string): GoalSignals => {
  const lower = goal.toLowerCase();
  const phraseSummary = buildGoalPhrasePatterns(goal);
  const explicitPaths = new Map<string, string>();
  const fileNames = new Set<string>();

  for (const match of goal.matchAll(PATH_WITH_DIR_PATTERN)) {
    const raw = match[0];
    const sanitized = sanitizeRelativePath(raw);
    explicitPaths.set(sanitized.toLowerCase(), sanitized);
  }

  for (const match of goal.matchAll(FILE_NAME_PATTERN)) {
    const raw = match[0];
    const sanitized = sanitizeRelativePath(raw);
    if (!explicitPaths.has(sanitized.toLowerCase())) {
      fileNames.add(sanitized);
    }
  }

  const tokens = lower.match(/[a-z0-9][a-z0-9_.-]+/g) ?? [];
  const keywordSet = new Set<string>();
  const tokenFrequency = new Map<string, number>();
  for (const token of tokens) {
    const normalized = token.replace(/^[._-]+|[._-]+$/g, '');
    if (!normalized || normalized.length < 4) {
      continue;
    }
    if (STOP_WORDS.has(normalized) || /^https?:/.test(normalized)) {
      continue;
    }
    keywordSet.add(normalized);
    tokenFrequency.set(normalized, (tokenFrequency.get(normalized) ?? 0) + 1);
  }

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const first = tokens[index].replace(/^[._-]+|[._-]+$/g, '');
    const second = tokens[index + 1].replace(/^[._-]+|[._-]+$/g, '');
    if (!first || !second || STOP_WORDS.has(first) || STOP_WORDS.has(second)) {
      continue;
    }
    const combined = `${first} ${second}`;
    keywordSet.add(combined);
  }

  for (const pattern of ADMIN_PANEL_PATTERNS) {
    if (lower.includes(pattern)) {
      keywordSet.add(pattern);
    }
  }

  const explicitList = Array.from(explicitPaths.values());
  const keywordList = Array.from(keywordSet).slice(0, 8);
  const fileList = Array.from(fileNames).slice(0, 5);

  const hasRelevantFilesSection = /\brelevant files\s*:/i.test(goal);
  const shouldDeferPrimaryHint = hasRelevantFilesSection && explicitList.length > 1;
  const focusLabel = shouldDeferPrimaryHint
    ? fileList[0] || phraseSummary.phrases[0] || keywordList[0] || explicitList[0] || 'primary match'
    : explicitList[0] || fileList[0] || phraseSummary.phrases[0] || keywordList[0] || 'primary match';
  const isFileNameToken = (value: string): boolean => /^[a-z0-9_.-]+\.[a-z0-9]{1,6}$/i.test(value);
  const explicitKeywordTokenSet = new Set(
    explicitList.flatMap((entry) => entry.toLowerCase().match(/[a-z0-9][a-z0-9_.-]+/g) ?? [])
  );
  const leadText = hasRelevantFilesSection
    ? goal.slice(0, goal.toLowerCase().indexOf('relevant files:'))
    : goal;
  const leadKeywordTokenSet = new Set(
    (leadText.toLowerCase().match(/[a-z0-9][a-z0-9_.-]+/g) ?? [])
      .map((token) => token.replace(/^[._-]+|[._-]+$/g, ''))
      .filter((token) => token.length > 0)
  );
  const normalizedFocusFileName = sanitizeRelativePath(focusLabel).toLowerCase();
  const focusLooksLikeFileName = normalizedFocusFileName.length > 0
    && !normalizedFocusFileName.includes('/')
    && isFileNameToken(normalizedFocusFileName);
  const shouldKeepDeferredKeyword = (token: string): boolean => {
    if (!(shouldDeferPrimaryHint && focusLooksLikeFileName)) {
      return true;
    }
    const lowered = token.toLowerCase();
    const looksLikeFile = isFileNameToken(lowered);
    if (looksLikeFile && lowered !== normalizedFocusFileName) {
      return false;
    }
    if (explicitKeywordTokenSet.has(lowered) && !leadKeywordTokenSet.has(lowered)) {
      return false;
    }
    return true;
  };

  const explicitPatternPaths = (() => {
    if (!(shouldDeferPrimaryHint && focusLooksLikeFileName)) {
      return explicitList;
    }
    const filtered = explicitList.filter((entry) => {
      const lowered = entry.toLowerCase();
      return lowered === normalizedFocusFileName || lowered.endsWith(`/${normalizedFocusFileName}`);
    });
    return filtered.length > 0 ? filtered : explicitList;
  })();

  const filePatternList = (() => {
    if (!(shouldDeferPrimaryHint && focusLooksLikeFileName)) {
      return fileList;
    }
    const filtered = fileList.filter((entry) => entry.toLowerCase() === normalizedFocusFileName);
    return filtered.length > 0 ? filtered : fileList;
  })();

  const keywordPatternList = (() => {
    if (!(shouldDeferPrimaryHint && focusLooksLikeFileName)) {
      return keywordList;
    }
    const filtered = keywordList.filter((entry) => shouldKeepDeferredKeyword(entry));
    return filtered.length > 0 ? filtered : keywordList;
  })();

  const patternSet = new Set<string>();
  explicitPatternPaths.forEach((item) => patternSet.add(item.toLowerCase()));
  filePatternList.forEach((item) => patternSet.add(item.toLowerCase()));
  phraseSummary.patterns.forEach((item) => patternSet.add(item));
  keywordPatternList.forEach((item) => patternSet.add(item.toLowerCase()));
  const helperPathHint = explicitList.find((entry) => {
    if (!HELPER_FILE_PATTERN.test(entry)) {
      return false;
    }
    const lowered = entry.toLowerCase();
    if (HELPER_PATH_HINT_PATTERN.test(lowered)) {
      return true;
    }
    const baseName = lowered.split('/').pop() ?? lowered;
    return HELPER_FILE_NAME_HINT_PATTERN.test(baseName);
  });
  const primaryPathHint = shouldDeferPrimaryHint
    ? undefined
    : helperPathHint ?? explicitList[0];

  const priorityKeywordsRaw = selectTopTokens(tokenFrequency, 6);
  const priorityKeywords = (() => {
    if (!(shouldDeferPrimaryHint && focusLooksLikeFileName)) {
      return priorityKeywordsRaw;
    }
    const filtered = priorityKeywordsRaw.filter((token) => shouldKeepDeferredKeyword(token));
    return filtered.length > 0 ? filtered : priorityKeywordsRaw;
  })();

  return {
    patterns: Array.from(patternSet).slice(0, 10),
    focusLabel: focusLabel.trim() || 'primary match',
    priorityKeywords: priorityKeywords.slice(0, 6),
    primaryPathHint,
    deferPrimaryHint: shouldDeferPrimaryHint,
    focusFileName: (shouldDeferPrimaryHint && focusLooksLikeFileName) ? normalizedFocusFileName : undefined
  };
};

const detectRequestedScripts = (goal: string): string[] => {
  const normalized = goal.toLowerCase();
  const scripts = new Set<keyof typeof SCRIPT_PATTERNS>();

  if (RUN_ALL_SCRIPTS_PATTERN.test(normalized)) {
    Object.keys(SCRIPT_PATTERNS).forEach((key) => scripts.add(key as keyof typeof SCRIPT_PATTERNS));
    return Array.from(scripts);
  }

  Object.entries(SCRIPT_PATTERNS).forEach(([script, patterns]) => {
    if (patterns.some((pattern) => pattern.test(normalized))) {
      scripts.add(script as keyof typeof SCRIPT_PATTERNS);
    }
  });

  return Array.from(scripts);
};

const buildFallbackStep = (goal: string): PlanStep => {
  const trimmedGoal = goal.trim();
  const quotedGoal = trimmedGoal ? `"${trimmedGoal}"` : 'the current goal';
  return createMessageStep(
    'Awaiting direction',
    'This goal does not map to an automated playbook yet. Use the project scan results and provide the next action.',
    `Project scan complete, but no automated plan is configured for ${quotedGoal}. Provide a specific file or task to continue — include workspace-relative paths (e.g. src/app.ts) so the agent can find the right files.`,
    'warn'
  );
};

export const plannerService = {
  async generatePlan(goal: string, options?: PlannerGenerateOptions): Promise<Plan> {
    const cleanedGoal = (goal ?? '').trim();
    const requestedScripts = detectRequestedScripts(cleanedGoal);
    const inference = extractGoalInference(options?.metadata);
    const workspaceSummary = extractWorkspaceIndexSummary(options?.metadata);
    const workspaceFileSet = buildWorkspaceFileSet(workspaceSummary);
    const workspaceDirectorySet = buildWorkspaceDirectorySet(workspaceSummary);
    const embeddingCandidates = filterEmbeddingCandidatesByWorkspace(
      extractEmbeddingCandidates(options?.metadata),
      workspaceFileSet
    );
    const contextFiles = resolvePathHints(
      extractContextFiles(options?.metadata),
      workspaceSummary
    );
    const goalFileHints = resolvePathHints(
      extractGoalFileHints(cleanedGoal),
      workspaceSummary
    );
    const primaryHint = inference?.files?.[0];
    let signals = analyzeGoal(cleanedGoal);
    const helperDirectory = resolveHelperDirectory(
      inference,
      embeddingCandidates,
      workspaceDirectorySet,
      contextFiles
    );
    const helperDirPrefix = `${helperDirectory}/`.toLowerCase();
    signals = refineGoalSignalsWithEmbeddings(signals, embeddingCandidates);
    const embeddingAlignedFiles = intersectFilesWithEmbeddings(inference, embeddingCandidates, workspaceFileSet);
    if (embeddingAlignedFiles.length > 0) {
      signals = prioritizeSignalsWithEmbeddingMatches(signals, embeddingAlignedFiles, helperDirPrefix);
    }
    signals = pruneHelperDirectoryPatterns(signals, helperDirPrefix);
    signals = applyContextFilesToSignals(signals, contextFiles, helperDirPrefix);
    const shouldDeferPrimaryHint = signals.deferPrimaryHint === true;
    const firstGoalPathHint = goalFileHints.find((hint) => hint.includes('/'));
    const primaryHasSeparator = typeof signals.primaryPathHint === 'string' && signals.primaryPathHint.includes('/');
    if ((!signals.primaryPathHint || !primaryHasSeparator) && firstGoalPathHint && !shouldDeferPrimaryHint) {
      signals = { ...signals, primaryPathHint: firstGoalPathHint };
    }
    const focusPrimaryPath = selectPrimaryFocusPath(signals, embeddingAlignedFiles, helperDirPrefix, {
      allowPatternFallback: !shouldDeferPrimaryHint
    });
    if (focusPrimaryPath && signals.primaryPathHint !== focusPrimaryPath) {
      signals = { ...signals, primaryPathHint: focusPrimaryPath };
    }
    const helperExclusions = [
      embeddingAlignedFiles[0],
      primaryHint,
      signals.primaryPathHint,
      focusPrimaryPath,
      ...contextFiles
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const expectsHelpers = shouldExtractHelpers(cleanedGoal, inference);
    const helperLimit = determineHelperChainLimit(expectsHelpers, embeddingCandidates, helperDirPrefix);
    const helperTargets = deriveHelperTargets(
      cleanedGoal,
      inference,
      helperExclusions,
      helperLimit,
      helperDirectory,
      embeddingCandidates,
      workspaceFileSet
    );
    const relatedTargets =
      helperTargets.length > 0
        ? []
        : deriveRelatedPlanTargets(
            cleanedGoal,
            inference,
            helperExclusions.concat(helperTargets.map((target) => target.path)),
            embeddingCandidates
          );
    const goalTokens = new Set(
      [...signals.patterns, ...signals.priorityKeywords]
        .map((token) => (typeof token === 'string' ? token.trim().toLowerCase() : ''))
        .filter((token) => token.length > 2)
    );
    const featuredEntries = buildFeaturedFileList({
      workspaceSummary,
      embeddingCandidates,
      helperTargets,
      relatedTargets,
      contextFiles,
      goalTokens
    });
    const featuredFiles = featuredEntries.map((entry) => entry.path);
    const normalizedPrimaryPath = focusPrimaryPath ? sanitizeRelativePath(focusPrimaryPath) : undefined;
    const domainTargets = inferDomainFileTargets(cleanedGoal, normalizedPrimaryPath, workspaceFileSet);
    // When the goal targets multiple sibling files ("all controllers", "other services",
    // "similar comments to each"), include all explicitly listed files as rewrite targets
    // so the model reads their content before attempting to modify them.
    const multiFileTargets = (() => {
      const goalLower = cleanedGoal.toLowerCase();
      const isMultiFileIntent = /\b(all|other|each|every|similar|same)\b/.test(goalLower)
        && /\b(controller|service|component|handler|model|module|file)s?\b/.test(goalLower);
      if (!isMultiFileIntent) {return [];}
      const primaryLower = normalizedPrimaryPath?.toLowerCase();
      return signals.patterns
        .map((p) => sanitizeRelativePath(p))
        .filter((p) => p && p.includes('/') && p !== primaryLower && workspaceFileSet?.has(p.toLowerCase()));
    })();
    const additionalRewriteFiles = [...new Set([...domainTargets, ...multiFileTargets])];
    const steps: PlanStep[] = [createScanStep()];
    const candidateStep = createCandidateFilesStep(featuredEntries);
    if (candidateStep) {
      steps.push(candidateStep);
    }

    let addedAction = false;

    if (signals.patterns.length > 0) {
      const locateExclusions = helperTargets.length > 0 ? [helperDirPrefix] : undefined;
      steps.push(
        createLocateFilesStep(
          signals.patterns,
          signals.priorityKeywords,
          'focus',
          signals.focusLabel,
          focusPrimaryPath,
          locateExclusions
        )
      );
      steps.push(createReadPrimaryMatchStep('focus'));
      steps.push(createConfirmTargetStep());
      if (helperTargets.length > 0) {
        steps.push(createExtractSnippetStep());
        helperTargets.forEach((target) => {
          steps.push(createHelperRewriteStep(cleanedGoal, target));
          steps.push(createHelperReviewStep(target));
          steps.push(createHelperApplyStep(target));
        });
        steps.push(createCallerRewriteStep(cleanedGoal, helperTargets));
        steps.push(createCallerReviewStep(helperTargets));
        steps.push(createCallerApplyStep(helperTargets));
      } else {
        const filesToEdit = additionalRewriteFiles.length > 0
          ? [...additionalRewriteFiles]
          : undefined;
        const requiredFileEntries = additionalRewriteFiles.length > 0
          ? [...additionalRewriteFiles]
          : undefined;
        const rewriteGuard = additionalRewriteFiles.length > 0
          ? {
              maxRemovedLineRatio: 0.4,
              maxChangedLineRatio: 0.6,
              minOriginalLineCount: 40,
              reason: 'domain-extraction'
            }
          : undefined;
        const applyMetadata = rewriteGuard ? { rewriteGuard } : undefined;
        const rewriteOverrides = filesToEdit
          ? { filesToEdit }
          : undefined;
        steps.push(createRewriteFocusStep(cleanedGoal, rewriteOverrides));
        steps.push(createReviewFocusStep());
        const applyOverrides = requiredFileEntries
          ? { requiredFileEntries, metadata: applyMetadata }
          : applyMetadata
            ? { metadata: applyMetadata }
            : undefined;
        steps.push(createApplyFocusStep(applyOverrides));
      }
      addedAction = true;
    }

    if (relatedTargets.length > 0) {
      relatedTargets.forEach((target) => {
        steps.push(createRelatedReadStep(target));
        steps.push(createRelatedRewriteStep(cleanedGoal, target));
        steps.push(createRelatedReviewStep(target));
        steps.push(createRelatedApplyStep(target));
      });
      addedAction = true;
    }

    if (requestedScripts.length > 0) {
      steps.push(createRunScriptsStep(requestedScripts));
      addedAction = true;
    }

    if (!addedAction) {
      steps.push(buildFallbackStep(cleanedGoal));
    }

    const targetValidation = validatePlanTargets(steps, workspaceFileSet, workspaceSummary);
    if (targetValidation.missing.length > 0) {
      steps.unshift(createMissingPathStep(targetValidation.missing));
    }

    const multiFilePlan = helperTargets.length > 0 || relatedTargets.length > 0;
    return {
      goal,
      steps,
      metadata: {
        featuredFiles,
        multiFile: multiFilePlan
      }
    };
  },

  async revisePlan(previous: Plan): Promise<Plan> {
    return previous;
  }
};

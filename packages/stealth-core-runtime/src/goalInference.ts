export type GoalIntent = 'refactor' | 'fix' | 'feature' | 'analyze' | 'doc' | 'style';

export interface InferenceContext {
  prompt: string;
  workspaceIndex: string[];
  symbols?: Record<string, unknown>;
}

export interface TaskSuggestion {
  title: string;
  description?: string;
  files?: string[];
}

export interface InferredGoal {
  title: string;
  intent: GoalIntent;
  files: string[];
  rationale?: string;
  tasks?: TaskSuggestion[];
}

export const PATH_PATTERN = /(?:[^\s"'`]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6}/g;
export const FILE_NAME_PATTERN = /\b[A-Za-z0-9_.-]+\.[a-z0-9]{1,6}\b/g;
const FILE_EXTENSIONS = /\.(tsx|ts|jsx|js|json|md|css|scss|sass|less|html|yml|yaml|vue|svelte|cs|csx|java|kt|kts|sql|go|py|rb|php|c|cc|cpp|h|hpp|rs|swift|sh|bash|ps1|psm1)$/i;
const BULLET_LINE_PATTERN = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const PHASE_CONNECTOR_PATTERN = /\b(?:then|next|after(?:ward|wards)?|follow(?:ed)? by|plus|as well as|finally)\b/gi;
export const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'there', 'about', 'please', 'could', 'would', 'should', 'bandit', 'stealth',
  'agent', 'mode', 'question', 'repo', 'code', 'file', 'files', 'explain', 'describe', 'thank', 'thanks', 'have', 'need',
  'maybe', 'really', 'just', 'like', 'into', 'from', 'your', 'you', 'what', 'where', 'when', 'why', 'which', 'how', 'does',
  'make', 'using', 'are', 'roughly', 'currently', 'actually', 'around', 'after', 'before', 'goal', 'task', 'work', 'project',
  'component', 'components', 'comnponent', 'comnponents', 'page', 'pages', 'little'
]);

const INTENT_PATTERNS: Record<GoalIntent, RegExp[]> = {
  refactor: [/refactor/i, /cleanup/i, /restructure/i, /modular/i, /extract/i, /split/i],
  fix: [/fix/i, /bug/i, /issue/i, /error/i, /broken/i, /correct/i],
  feature: [/add/i, /implement/i, /create/i, /support/i, /feature/i, /build/i, /introduce/i],
  analyze: [/investigate/i, /analy[sz]e/i, /review/i, /audit/i, /inspect/i, /debug/i],
  doc: [/doc/i, /readme/i, /comment/i, /explain/i, /write documentation/i, /guide/i],
  style: [/style/i, /css/i, /theme/i, /color/i, /spacing/i, /layout/i, /visual/i]
};

export async function inferGoal(context: InferenceContext): Promise<InferredGoal> {
  const prompt = context.prompt?.trim() ?? '';
  const title = buildTitle(prompt);
  const intent = classifyIntent(prompt);
  const baseFiles = selectCandidateFiles(prompt, context.workspaceIndex ?? []);
  const syntheticFiles = inferSyntheticComponentFiles(prompt, context.workspaceIndex ?? []);
  const files = dedupeFiles([...baseFiles, ...syntheticFiles]);
  const rationale = buildRationale(intent, files);
  const tasks = buildTaskSuggestions(prompt, files, intent);
  return {
    title,
    intent,
    files,
    rationale,
    tasks
  };
}

function buildTitle(prompt: string): string {
  if (!prompt) {
    return 'Bandit agent goal';
  }
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 120) {
    return capitalize(collapsed);
  }
  return `${capitalize(collapsed.slice(0, 117).trimEnd())}…`;
}

function capitalize(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function classifyIntent(prompt: string): GoalIntent {
  const normalized = prompt.toLowerCase();
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS) as Array<[GoalIntent, RegExp[]]>) {
    if (patterns.some((pattern) => pattern.test(normalized))) {
      return intent;
    }
  }

  if (/bug|error|exception|stack trace/.test(normalized)) {
    return 'fix';
  }

  if (/doc|readme|documentation|comment/.test(normalized)) {
    return 'doc';
  }

  return 'feature';
}

function selectCandidateFiles(prompt: string, workspaceIndex: string[], limit = 6): string[] {
  if (!workspaceIndex.length) {
    return [];
  }

  const normalizedIndex = workspaceIndex
    .map((file) => file.replace(/\\/g, '/'))
    .filter((file) => FILE_EXTENSIONS.test(file));

  const matches = new Set<string>();
  const addMatch = (file: string) => {
    if (!file || matches.size >= limit) {
      return;
    }
    matches.add(file);
  };

  for (const explicit of extractExplicitPaths(prompt)) {
    const exact = normalizedIndex.find((entry) => entry.toLowerCase() === explicit.toLowerCase());
    const candidate = exact ?? normalizedIndex.find((entry) => entry.toLowerCase().endsWith(explicit.toLowerCase()));
    if (candidate) {
      addMatch(candidate);
    }
    if (matches.size >= limit) {
      return Array.from(matches);
    }
  }

  const keywords = extractKeywords(prompt);
  if (!keywords.length) {
    return Array.from(matches);
  }

  const scored: Array<{ file: string; score: number }> = [];
  for (const file of normalizedIndex) {
    if (matches.has(file)) {
      continue;
    }
    const lower = file.toLowerCase();
    let score = 0;
    for (const keyword of keywords) {
      if (!lower.includes(keyword)) {
        continue;
      }
      score += keyword.length;
      if (lower.endsWith(`/${keyword}.tsx`) || lower.endsWith(`/${keyword}.ts`) || lower.endsWith(`/${keyword}.jsx`) || lower.endsWith(`/${keyword}.js`)) {
        score += 3;
      } else if (lower.endsWith(`/${keyword}.md`) || lower.endsWith(`/${keyword}.mdx`)) {
        score += 2;
      }
      if (lower.includes(`/${keyword}/`)) {
        score += 2;
      }
    }
    if (score > 0) {
      scored.push({ file, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  for (const entry of scored) {
    addMatch(entry.file);
    if (matches.size >= limit) {
      break;
    }
  }

  return Array.from(matches);
}

export function extractExplicitPaths(prompt: string): string[] {
  const matches = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = PATH_PATTERN.exec(prompt)) !== null) {
    const normalized = match[0]
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/^\/+/, '')
      .trim();
    if (normalized) {
      matches.add(normalized);
    }
  }
  return Array.from(matches);
}

export function extractKeywords(prompt: string): string[] {
  const tokens = prompt
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g);
  if (!tokens) {
    return [];
  }
  return tokens.filter((token) => !STOP_WORDS.has(token)).slice(0, 24);
}

function buildRationale(intent: GoalIntent, files: string[]): string {
  const label = intentLabel(intent);
  if (!files.length) {
    return `Detected ${label} intent from the prompt.`;
  }
  const subset = files.slice(0, 3).join(', ');
  return `Detected ${label} intent and shortlisted ${subset} as likely impacted files.`;
}

/**
 * Extract a human-readable action verb from the prompt.
 * Returns e.g. "Add comments to", "Refactor", "Fix error handling in".
 */
function inferActionVerb(prompt: string, _intent: GoalIntent): string | undefined {
  const lower = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
  // Try to extract "add X to", "add X for", "remove X from"
  const addMatch = lower.match(/\b(add\s+\w[\w\s]{0,30}?\s+(?:to|for|in))\b/);
  if (addMatch) {return capitalize(addMatch[1].trim());}
  const verbPatterns: Array<[RegExp, string]> = [
    [/\b(add\s+comments)\b/i, 'Add comments to'],
    [/\b(add\s+documentation)\b/i, 'Add documentation to'],
    [/\b(add\s+types?\s+annotations?)\b/i, 'Add type annotations to'],
    [/\b(add\s+error\s+handling)\b/i, 'Add error handling to'],
    [/\b(add\s+validation)\b/i, 'Add validation to'],
    [/\b(add\s+logging)\b/i, 'Add logging to'],
    [/\b(add\s+tests?\s+for)\b/i, 'Add tests for'],
    [/\brefactor\b/i, 'Refactor'],
    [/\bfix\b/i, 'Fix'],
    [/\bupdate\b/i, 'Update'],
    [/\bclean\s*up\b/i, 'Clean up'],
    [/\boptimize\b/i, 'Optimize'],
    [/\bdocument\b/i, 'Document'],
  ];
  for (const [pattern, verb] of verbPatterns) {
    if (pattern.test(lower)) {return verb;}
  }
  return undefined;
}

function intentVerb(intent: GoalIntent): string {
  switch (intent) {
    case 'refactor': return 'Refactor';
    case 'fix': return 'Fix';
    case 'feature': return 'Update';
    case 'analyze': return 'Analyze';
    case 'doc': return 'Document';
    case 'style': return 'Style';
  }
}

function buildTaskSuggestions(prompt: string, files: string[], intent: GoalIntent): TaskSuggestion[] {
  const clauses = extractGoalClauses(prompt);
  const suggestions: TaskSuggestion[] = [];
  const normalizedFiles = files.slice(0, 6);

  // When the goal explicitly targets multiple files ("all controllers", "each service",
  // "similar comments to the other handlers"), generate file-specific tasks with
  // interpreted intent rather than echoing the raw prompt text.
  const actionVerb = inferActionVerb(prompt, intent);
  const promptLower = prompt.toLowerCase();
  const isExplicitMultiFile = /\b(all|other|each|every|similar|same)\b/.test(promptLower)
    && normalizedFiles.length > 1;
  if (actionVerb && isExplicitMultiFile) {
    normalizedFiles.forEach((file) => {
      const fileName = file.split('/').pop() ?? file;
      suggestions.push({
        title: `${actionVerb} ${fileName}`,
        description: `${actionVerb} in ${file}`,
        files: [file]
      });
    });
  } else if (!clauses.length && normalizedFiles.length) {
    const verb = actionVerb ?? intentVerb(intent);
    normalizedFiles.forEach((file) => {
      const fileName = file.split('/').pop() ?? file;
      suggestions.push({
        title: `${verb} ${fileName}`,
        description: `Apply the requested goal to ${file}.`,
        files: [file]
      });
    });
  } else {
    clauses.forEach((clause) => {
      const title = formatClauseTitle(clause);
      if (!title) {
        return;
      }
      const associated = matchClauseToFiles(clause, normalizedFiles);
      suggestions.push({
        title,
        description: associated.length ? `Likely touched files: ${associated.join(', ')}` : undefined,
        files: associated.length ? associated : undefined
      });
    });
  }

  if (!suggestions.length && prompt.trim()) {
    suggestions.push({
      title: capitalize(prompt.trim()),
      description: normalizedFiles.length ? `Review ${normalizedFiles.join(', ')}` : undefined,
      files: normalizedFiles.length ? normalizedFiles : undefined
    });
  }

  if (intent !== 'analyze') {
    suggestions.push({
      title: 'Review and validate changes',
      description: 'Self-review the diff and run any necessary checks.',
      files: normalizedFiles.slice(0, 2)
    });
  }

  const deduped: TaskSuggestion[] = [];
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    const key = suggestion.title.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(suggestion);
    if (deduped.length >= 6) {
      break;
    }
  }
  return deduped;
}

function extractGoalClauses(prompt: string): string[] {
  const promptSansRelevantFiles = stripRelevantFilesSection(prompt);
  const listItems = extractBulletListClauses(promptSansRelevantFiles);
  if (listItems.length > 0) {
    return listItems.slice(0, 8);
  }

  const sanitized = normalizePromptForClauseExtraction(promptSansRelevantFiles);
  if (!sanitized) {
    return [];
  }
  const sentenceSplits = sanitized
    .split(/[.!?]+(?=\s|$)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!sentenceSplits.length) {
    sentenceSplits.push(sanitized);
  }
  const clauses: string[] = [];
  for (const sentence of sentenceSplits) {
    const splits = sentence.split(PHASE_CONNECTOR_PATTERN).map((segment) => segment.trim()).filter(Boolean);
    if (!splits.length) {
      continue;
    }
    for (const split of splits) {
      const normalized = normalizeClauseSegment(split);
      if (!normalized) {
        continue;
      }
      clauses.push(normalized);
      if (clauses.length >= 8) {
        return clauses;
      }
    }
  }
  return clauses;
}

function stripLikelyCodeLines(prompt: string): string {
  if (!prompt) {
    return '';
  }
  const lines = prompt.split(/\r?\n/);
  const filtered = lines.filter((line) => !isLikelyCodeLine(line));
  return filtered.join(' ');
}

function stripRelevantFilesSection(prompt: string): string {
  if (!prompt) {
    return '';
  }
  const marker = prompt.search(/\brelevant files\s*:/i);
  if (marker <= 0) {
    return prompt;
  }
  return prompt.slice(0, marker);
}

function normalizePromptForClauseExtraction(prompt: string): string {
  return stripLikelyCodeLines(prompt)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBulletListClauses(prompt: string): string[] {
  if (!prompt) {
    return [];
  }
  const lines = prompt.split(/\r?\n/);
  const clauses: string[] = [];
  for (const line of lines) {
    const match = line.match(BULLET_LINE_PATTERN);
    if (!match?.[1]) {
      continue;
    }
    const normalized = normalizeClauseSegment(match[1]);
    if (!normalized) {
      continue;
    }
    clauses.push(normalized);
    if (clauses.length >= 8) {
      break;
    }
  }
  return clauses;
}

function normalizeClauseSegment(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length < 4) {
    return '';
  }
  return normalized;
}

function isLikelyCodeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed === '{' || trimmed === '}') {
    return true;
  }
  if (/^\s*(public|private|protected|internal)\b/.test(trimmed)) {
    return true;
  }
  if (/\bclass\b/.test(trimmed) && /[{;]$/.test(trimmed)) {
    return true;
  }
  if (/\b(get;|set;)\b/.test(trimmed)) {
    return true;
  }
  return false;
}

function formatClauseTitle(clause: string): string {
  const trimmed = clause.trim().replace(/^\b(to|please|kindly)\b/i, '').trim();
  if (!trimmed) {
    return '';
  }
  const normalized = trimmed.replace(/\s+/g, ' ');
  const capped = normalized.length > 120 ? `${normalized.slice(0, 117).trimEnd()}…` : normalized;
  return capitalize(capped);
}

function matchClauseToFiles(clause: string, files: string[]): string[] {
  if (!files.length) {
    return [];
  }
  const normalizedClause = clause.toLowerCase();
  const tokens = normalizedClause.match(/[a-z0-9][a-z0-9_-]{3,}/g);
  if (!tokens || !tokens.length) {
    return [];
  }
  const matches: string[] = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const baseName = lower.split(/[\\/]/).pop() ?? lower;
    if (tokens.some((token) => lower.includes(`/${token}`) || baseName.includes(token))) {
      matches.push(file);
    }
  }
  return matches.slice(0, 3);
}

function intentLabel(intent: GoalIntent): string {
  switch (intent) {
    case 'fix':
      return 'a bug fix';
    case 'refactor':
      return 'a refactor';
    case 'analyze':
      return 'an investigation';
    case 'doc':
      return 'a documentation update';
    case 'style':
      return 'a styling update';
    default:
      return 'a feature implementation';
  }
}

function dedupeFiles(files: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const file of files) {
    if (!file) {
      continue;
    }
    const normalized = file.replace(/\\/g, '/');
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
  }
  return results;
}

const COMPONENT_REQUEST_PATTERN = /\b(?:create|add|build|use|have|refactor|split|extract|introduce|make)\s+(?:an?\s+|the\s+)?([a-z][a-z0-9\s-]{3,}?)\s+(?:component|components|comnponent|comnponents)\b/gi;
const INLINE_COMPONENT_PATTERN = /\b([a-z][a-z0-9\s-]{3,})\s+(?:component|components|comnponent|comnponents)\b/gi;
const DEFAULT_COMPONENT_DIRS = ['src/components/shared', 'src/components/ui', 'src/components', 'components', 'src'];
const COMPONENT_NAME_SEPARATORS = new Set(['to', 'into', 'with', 'using', 'use', 'and', 'while', 'when', 'that', 'which', 'for', 'of', 'by', 'a', 'an', 'the']);

function inferSyntheticComponentFiles(prompt: string, workspaceIndex: string[]): string[] {
  const actionNames = extractActionDrivenComponentNames(prompt);
  const inlineNames = extractInlineComponentNames(prompt);
  const names = inlineNames.size > 0 ? inlineNames : actionNames;
  if (!names.size) {
    return [];
  }
  const directories = collectWorkspaceDirectories(workspaceIndex);
  const knownFiles = new Set(workspaceIndex.map((file) => file.replace(/\\/g, '/').toLowerCase()));
  const knownBaseNames = new Set(
    Array.from(knownFiles)
      .map((file) => file.split('/').pop())
      .filter((value): value is string => Boolean(value))
  );
  const suggestions: string[] = [];
  for (const name of names) {
    const refined = refineComponentName(name);
    if (!refined) {
      continue;
    }
    const suggested = buildComponentPathSuggestion(refined, directories, knownFiles, knownBaseNames);
    if (suggested && !knownFiles.has(suggested)) {
      suggestions.push(suggested);
    }
  }
  return suggestions;
}

function extractActionDrivenComponentNames(prompt: string): Set<string> {
  const names = new Set<string>();
  COMPONENT_REQUEST_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMPONENT_REQUEST_PATTERN.exec(prompt)) !== null) {
    if (match[1]) {
      names.add(match[1]);
    }
  }
  return names;
}

function extractInlineComponentNames(prompt: string): Set<string> {
  const names = new Set<string>();
  INLINE_COMPONENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_COMPONENT_PATTERN.exec(prompt)) !== null) {
    if (match[1]) {
      names.add(match[1]);
    }
  }
  return names;
}

function refineComponentName(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const sanitized = raw
    .replace(/[^a-z0-9\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!sanitized) {
    return undefined;
  }
  const tokens = sanitized.split(' ');
  let start = 0;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (COMPONENT_NAME_SEPARATORS.has(tokens[index])) {
      start = index + 1;
      break;
    }
  }
  const sliced = tokens.slice(start).filter((token) => token && !STOP_WORDS.has(token));
  if (!sliced.length) {
    return undefined;
  }
  const candidateTokens = sliced.slice(-3);
  const candidate = candidateTokens.join(' ').trim();
  return candidate.length >= 3 ? candidate : undefined;
}

function collectWorkspaceDirectories(workspaceIndex: string[]): string[] {
  const directories = new Set<string>();
  for (const file of workspaceIndex) {
    const normalized = file.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash === -1) {
      continue;
    }
    const directory = normalized.slice(0, lastSlash);
    if (directory) {
      directories.add(directory);
    }
  }
  return Array.from(directories).sort((a, b) => a.length - b.length);
}

function buildComponentPathSuggestion(
  name: string,
  directories: string[],
  knownFiles: Set<string>,
  knownBaseNames: Set<string>
): string | undefined {
  const kebab = toKebabCase(name);
  if (!kebab) {
    return undefined;
  }
  if (knownBaseNames.has(`${kebab}.tsx`)) {
    return undefined;
  }
  const keywords = extractNameKeywords(name);
  const dir = selectComponentDirectory(directories, keywords);
  const normalizedDir = dir ? dir.replace(/\\/g, '/').replace(/\/+$/, '') : '';
  const proposed = normalizedDir ? `${normalizedDir}/${kebab}.tsx` : `${kebab}.tsx`;
  if (knownFiles.has(proposed.toLowerCase())) {
    return undefined;
  }
  return proposed;
}

function selectComponentDirectory(directories: string[], keywords: string[]): string | undefined {
  const keywordMatch = directories.find((dir) => {
    const lower = dir.toLowerCase();
    return keywords.some((keyword) => keyword && lower.includes(keyword));
  });
  if (keywordMatch) {
    return keywordMatch;
  }
  for (const preferred of DEFAULT_COMPONENT_DIRS) {
    const normalizedPreferred = preferred.toLowerCase();
    const found = directories.find((dir) => {
      const normalizedDir = dir.toLowerCase();
      return normalizedDir === normalizedPreferred || normalizedDir.endsWith(`/${normalizedPreferred}`);
    });
    if (found) {
      return found;
    }
  }
  const containsComponents = directories.find((dir) => dir.includes('component'));
  if (containsComponents) {
    return containsComponents;
  }
  return directories.length ? directories[0] : undefined;
}

function extractNameKeywords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function toKebabCase(value: string): string {
  const tokens = value
    .trim()
    .split(/[\s_-]+/)
    .map((token) => token.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length > 0);
  return tokens.length ? tokens.join('-') : '';
}

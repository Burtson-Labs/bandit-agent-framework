import type { AIChatRequest } from '../internalTypes';
import type { ProviderKind, ProviderSettings, ChatProvider } from '../internalTypes';
import { extractRewritePayload, parseStructuredFileOutputs } from './rewritePayload';
import type { RewriteHydrationContext, StepOutcome, IDiffManager, DiffStreamUpdate } from '../internalTypes';
import { sanitizeGeneratedSource, stripCodeFences } from './textSanitizer';
import * as path from 'path';

const MAX_PRIMARY_REWRITE_CONTEXT = 20000;
const FILE_BLOCK_REGEX = /```files/i;
const FILE_HEADER_REGEX = /FILE:\s*/i;

interface Configuration {
  get<T>(section: string, defaultValue: T): T;
}

export interface RewriteGeneratorDeps {
  getConfiguration(): Configuration;
  getProviderKind(configuration: Configuration): ProviderKind;
  getModel(configuration: Configuration, provider: ProviderKind): string;
  buildProviderSettings(configuration: Configuration, apiKey: string): ProviderSettings;
  getTopP(configuration: Configuration): number | undefined;
  fetchApiKey(): Promise<string | undefined>;
  createProvider(settings: ProviderSettings): Promise<ChatProvider>;
  diffManager: Pick<IDiffManager, 'isReviewModeEnabled'> & {
    postDiffStream(update: DiffStreamUpdate): Promise<void>;
  };
  buildHydrationBlocks(hydration: RewriteHydrationContext | undefined, relativePath: string): string[];
  normalizeRelativePath(value: string): string | undefined;
  isCancelled(): boolean;
  fileOpsMarkers: { start: string; end: string };
}

export function createRewriteGenerator(deps: RewriteGeneratorDeps) {
  async function generateRewrite(
    goal: string,
    relativePath: string,
    currentContent: string,
    projectSummary: string,
    instructions: string | undefined,
    hydration?: RewriteHydrationContext
  ): Promise<StepOutcome> {
    const configuration = deps.getConfiguration();
    const providerKind = deps.getProviderKind(configuration);
    const apiKey = providerKind === 'bandit' ? await deps.fetchApiKey() : '';

    if (providerKind === 'bandit' && !apiKey) {
      return { ok: false, error: 'Bandit API key required to draft homepage updates.' };
    }

    const provider = await deps.createProvider(deps.buildProviderSettings(configuration, apiKey ?? ''));
    const maxContent = MAX_PRIMARY_REWRITE_CONTEXT;
    const trimmedContent =
      currentContent.length > maxContent ? `${currentContent.slice(0, maxContent)}\n/* trimmed */` : currentContent;
    const hydrationBlocks = deps.buildHydrationBlocks(hydration, relativePath);

    const expectsFilesBlock = shouldExpectFilesBlock(instructions);
    const requiredFiles = extractRequiredFilesFromInstructions(instructions);
    const requiredFileMap = new Map<string, string>();
    for (const file of requiredFiles) {
      const normalized = normalizePathForCompare(file, (value) => deps.normalizeRelativePath(value));
      if (!normalized) {
        continue;
      }
      if (!requiredFileMap.has(normalized)) {
        requiredFileMap.set(normalized, file);
      }
    }
    reconcileRequiredPrimaryPath(requiredFileMap, relativePath, (value) => deps.normalizeRelativePath(value));
    const requiredFileKeys = Array.from(requiredFileMap.keys());
    const formatMissingFiles = (missing: string[]): string[] =>
      missing.map((key) => requiredFileMap.get(key) ?? key);
    const collectMissingRequired = (entries: Array<{ path: string; content: string }>): string[] => {
      if (!expectsFilesBlock || requiredFileKeys.length === 0) {
        return [];
      }
      const normalizedEntries = entries
        .map((entry) => ({
          path: normalizePathForCompare(entry.path, (value) => deps.normalizeRelativePath(value)),
          content: entry.content
        }))
        .filter((entry): entry is { path: string; content: string } => Boolean(entry.path));
      return requiredFileKeys.filter((required) => {
        const match = normalizedEntries.find((entry) => entry.path === required);
        if (!match) {
          return true;
        }
        return match.content.trim().length === 0;
      });
    };
    const requiredFileList = Array.from(requiredFileMap.values());
    if (expectsFilesBlock && requiredFileList.length >= 2) {
      const deterministicEntries = buildDomainExtractionFallback({
        primaryPath: relativePath,
        currentContent,
        requiredFiles: requiredFileList,
        normalizePath: (value) => deps.normalizeRelativePath(value)
      });
      if (deterministicEntries) {
        const normalizedEntries = deterministicEntries.map((entry) => ({
          path: deps.normalizeRelativePath(entry.path) ?? entry.path,
          content: entry.content
        }));
        const primaryEntry = normalizedEntries[0];
        const additionalWrites = normalizedEntries.slice(1).map((entry) => ({
          path: entry.path,
          content: sanitizeGeneratedSource(entry.content)
        }));
        const sanitizedContent = sanitizeGeneratedSource(primaryEntry?.content ?? '');
        if (
          sanitizedContent.trim() &&
          currentContent.length > 200 &&
          sanitizedContent.length < currentContent.length * 0.3
        ) {
          return {
            ok: false,
            error: `Deterministic rewrite is suspiciously short: ${sanitizedContent.length} chars for a ${currentContent.length}-char file.`
          };
        }
        return {
          ok: Boolean(sanitizedContent.trim()) || additionalWrites.length > 0,
          output: `Draft size: ${sanitizedContent.length} chars`,
          data: {
            content: sanitizedContent,
            additionalWrites
          }
        };
      }
    }
    const userSections = [
      `Goal: ${goal}`,
      '',
      `Project summary: ${projectSummary}`,
      '',
      `File path: ${relativePath}`,
      ''
    ];
    if (instructions?.trim()) {
      userSections.push(instructions.trim(), '');
    }
    if (requiredFileList.length > 0) {
      userSections.push('Required FILE entries:', ...requiredFileList.map((file) => `- ${file}`), '');
    }
    userSections.push('Current file:', '```', trimmedContent, '```');
    if (hydrationBlocks.length > 0) {
      userSections.push('', ...hydrationBlocks);
    }
    const brandGuard = 'You are Bandit Stealth, a coding assistant built by Burtson Labs LLC. Never identify yourself as Gemma, Llama, or any other underlying model name.';
    const systemPrompt = expectsFilesBlock
      ? `${brandGuard} Return ONLY a \`\`\`files code block with one or more FILE entries for every updated file. Do not include any other text.`
      : `${brandGuard} Return the full updated file with no additional explanation, no Markdown fences, and no commentary.`;
    const request: AIChatRequest = {
      model: deps.getModel(configuration, providerKind),
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: userSections.join('\n')
        }
      ],
      temperature: configuration.get<number>('temperature', 0.2),
      stream: true
    };

    const topP = deps.getTopP(configuration);
    if (typeof topP === 'number' && !Number.isNaN(topP)) {
      request.options = { top_p: topP };
    }

    try {
      const isReviewMode = deps.diffManager.isReviewModeEnabled();
      const runChat = async (requestPayload: AIChatRequest, attempt: number): Promise<string> => {
        let buffer = '';
        if (isReviewMode && attempt === 0) {
          await deps.diffManager.postDiffStream({ path: relativePath, kind: 'start', content: '' });
        }
        for await (const chunk of provider.chat(requestPayload)) {
          if (deps.isCancelled()) {
            throw new Error('Cancelled');
          }
          const content = chunk?.message?.content ?? '';
          if (content) {
            buffer += content;
            await deps.diffManager.postDiffStream({ path: relativePath, kind: 'progress', content: buffer });
          }
          if (chunk?.done) {
            break;
          }
        }
        return buffer.trim();
      };

      let rawResponse = await runChat(request, 0);
      let normalized = stripCodeFences(rawResponse).replace(/\r\n/g, '\n');
      let structuredEntries = parseStructuredFileOutputs(normalized);
      let missingRequired = collectMissingRequired(structuredEntries);

      const allowFallback = requiredFileKeys.length <= 1;
      if (expectsFilesBlock && structuredEntries.length === 0 && allowFallback) {
        const fallbackContent = extractFallbackFileContent(rawResponse, relativePath);
        if (fallbackContent) {
          normalized = buildFallbackFilesBlock(relativePath, fallbackContent);
          structuredEntries = parseStructuredFileOutputs(normalized);
          missingRequired = collectMissingRequired(structuredEntries);
        }
      }

      if (expectsFilesBlock && (structuredEntries.length === 0 || missingRequired.length > 0)) {
        const retryPrompt = missingRequired.length > 0
          ? [
              `Your previous response did not include FILE entries for: ${formatMissingFiles(missingRequired).join(', ')}.`,
              'Return ONLY a ```files block with FILE entries for every updated file. No other text.'
            ].join(' ')
          : [
              'Your previous response did not include the required ```files block.',
              'Return ONLY a ```files block with FILE entries for every updated file. No other text.'
            ].join(' ');
        const retryRequest: AIChatRequest = {
          ...request,
          messages: [
            {
              role: 'system',
              content: 'Return ONLY a ```files code block with one or more FILE entries for every updated file. Do not include any other text.'
            },
            {
              role: 'user',
              content: [...userSections, retryPrompt].join('\n')
            }
          ]
        };
        rawResponse = await runChat(retryRequest, 1);
        normalized = stripCodeFences(rawResponse).replace(/\r\n/g, '\n');
        structuredEntries = parseStructuredFileOutputs(normalized);
        missingRequired = collectMissingRequired(structuredEntries);
        if (structuredEntries.length === 0 && allowFallback) {
          const fallbackContent = extractFallbackFileContent(rawResponse, relativePath);
          if (fallbackContent) {
            normalized = buildFallbackFilesBlock(relativePath, fallbackContent);
            structuredEntries = parseStructuredFileOutputs(normalized);
            missingRequired = collectMissingRequired(structuredEntries);
          }
        }
      }
      if (expectsFilesBlock && (structuredEntries.length === 0 || missingRequired.length > 0)) {
        const retryFiles = requiredFileList.length > 0 ? requiredFileList : [relativePath];
        const strictPrompt = [
          'Your previous response was invalid.',
          'You must respond with exactly this structure and nothing else:',
          buildFilesBlockTemplate(retryFiles),
          'Replace each <entire updated file> section with the full file contents.'
        ].join('\n\n');
        const strictRequest: AIChatRequest = {
          ...request,
          messages: [
            {
              role: 'system',
              content: 'Return ONLY a ```files code block with one or more FILE entries for every updated file. Do not include any other text.'
            },
            {
              role: 'user',
              content: [...userSections, strictPrompt].join('\n')
            }
          ]
        };
        rawResponse = await runChat(strictRequest, 2);
        normalized = stripCodeFences(rawResponse).replace(/\r\n/g, '\n');
        structuredEntries = parseStructuredFileOutputs(normalized);
        missingRequired = collectMissingRequired(structuredEntries);
        if (structuredEntries.length === 0 && allowFallback) {
          const fallbackContent = extractFallbackFileContent(rawResponse, relativePath);
          if (fallbackContent) {
            normalized = buildFallbackFilesBlock(relativePath, fallbackContent);
            structuredEntries = parseStructuredFileOutputs(normalized);
            missingRequired = collectMissingRequired(structuredEntries);
          }
        }
      }
      if (expectsFilesBlock && missingRequired.length > 0 && structuredEntries.length > 0) {
        const primaryKey = normalizePathForCompare(relativePath, (value) => deps.normalizeRelativePath(value));
        const isPrimaryMissing = primaryKey ? missingRequired.includes(primaryKey) : false;
        if (isPrimaryMissing && missingRequired.length === 1) {
          normalized = buildFilesBlockFromEntries([
            { path: relativePath, content: currentContent },
            ...structuredEntries
          ]);
          structuredEntries = parseStructuredFileOutputs(normalized);
          missingRequired = collectMissingRequired(structuredEntries);
        }
      }
      if (expectsFilesBlock && (structuredEntries.length === 0 || missingRequired.length > 0)) {
        const fallbackEntries = buildDomainExtractionFallback({
          primaryPath: relativePath,
          currentContent,
          requiredFiles: requiredFileList,
          normalizePath: (value) => deps.normalizeRelativePath(value)
        });
        if (fallbackEntries) {
          normalized = buildFilesBlockFromEntries(fallbackEntries);
          structuredEntries = parseStructuredFileOutputs(normalized);
          missingRequired = collectMissingRequired(structuredEntries);
        }
      }
      if (expectsFilesBlock && structuredEntries.length === 0) {
        return {
          ok: false,
          error: 'Rewrite response missing ```files block with FILE entries.'
        };
      }
      if (structuredEntries.length > 0) {
        const reconciled = reconcilePrimaryStructuredEntries({
          entries: structuredEntries,
          primaryPath: relativePath,
          normalizePath: (value) => deps.normalizeRelativePath(value)
        });
        if (reconciled) {
          normalized = buildFilesBlockFromEntries(reconciled);
          structuredEntries = parseStructuredFileOutputs(normalized);
          missingRequired = collectMissingRequired(structuredEntries);
        }
        const normalizedPrimary = normalizePathForCompare(relativePath, (value) => deps.normalizeRelativePath(value));
        const normalizedEntries = structuredEntries
          .map((entry) => normalizePathForCompare(entry.path, (value) => deps.normalizeRelativePath(value)))
          .filter((entry): entry is string => Boolean(entry));
        if (normalizedPrimary && !normalizedEntries.includes(normalizedPrimary)) {
          return {
            ok: false,
            error: `Rewrite response missing primary FILE entry for ${relativePath}.`
          };
        }
      }
      if (expectsFilesBlock && missingRequired.length > 0) {
        return {
          ok: false,
          error: `Rewrite response missing FILE entries for: ${formatMissingFiles(missingRequired).join(', ')}.`
        };
      }
      const payload = extractRewritePayload(normalized, {
        primaryPath: relativePath,
        normalizePath: (value) => deps.normalizeRelativePath(value),
        fileOpsStart: deps.fileOpsMarkers.start,
        fileOpsEnd: deps.fileOpsMarkers.end
      });
      payload.content = sanitizeGeneratedSource(payload.content);
      payload.additionalWrites = payload.additionalWrites.map((entry) => ({
        ...entry,
        content: sanitizeGeneratedSource(entry.content)
      }));
      // Guard: reject if the model returned suspiciously little content compared to the original.
      // A threshold of 30% catches truncated/hallucinated responses while allowing intentional
      // file shrinkage (e.g. "delete this function"). Only applies to non-trivial files (>200 chars).
      const MIN_SHRINK_RATIO = 0.3;
      const MIN_ORIGINAL_FOR_GUARD = 200;
      if (
        payload.content.trim() &&
        currentContent.length > MIN_ORIGINAL_FOR_GUARD &&
        payload.content.length < currentContent.length * MIN_SHRINK_RATIO
      ) {
        return {
          ok: false,
          error: `Rewrite is suspiciously short: model returned ${payload.content.length} chars for a ${currentContent.length}-char file. Likely a truncated response — retrying is recommended.`
        };
      }

      if (isReviewMode) {
        await deps.diffManager.postDiffStream({ path: relativePath, kind: 'complete', content: payload.content });
      }
      return {
        ok: Boolean(payload.content.trim()) || payload.additionalWrites.length > 0,
        output: `Draft size: ${payload.content.length} chars`,
        data: {
          content: payload.content,
          additionalWrites: payload.additionalWrites
        }
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { generateRewrite };
}

function shouldExpectFilesBlock(instructions?: string): boolean {
  if (!instructions) {
    return false;
  }
  return FILE_BLOCK_REGEX.test(instructions) || FILE_HEADER_REGEX.test(instructions) || /files block/i.test(instructions);
}

function buildFilesBlockTemplate(paths: string[]): string {
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
}

function extractRequiredFilesFromInstructions(instructions?: string): string[] {
  if (!instructions) {
    return [];
  }
  const normalized = instructions.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const files: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*FILE:\s*(.+)$/i);
    if (!match) {
      continue;
    }
    const candidate = match[1]?.trim();
    if (!candidate || isPlaceholderFileEntry(candidate)) {
      continue;
    }
    files.push(candidate);
  }
  return Array.from(new Set(files));
}

function isPlaceholderFileEntry(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  if (/[<>]/.test(trimmed)) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  if (lower.includes('path to update') || lower.includes('path to new file')) {
    return true;
  }
  if (lower.includes('entire updated file')) {
    return true;
  }
  if (lower.includes('focus.primary.path') || lower.includes('focus.primary')) {
    return true;
  }
  return false;
}

function normalizePathForCompare(
  value: string,
  normalize: (value: string) => string | undefined
): string | undefined {
  if (!value) {
    return undefined;
  }
  const canonical = canonicalizeStructuredPath(value);
  if (!canonical) {
    return undefined;
  }
  const normalized = normalize(canonical) ?? canonical;
  return normalized.replace(/\\/g, '/').toLowerCase();
}

function reconcileRequiredPrimaryPath(
  requiredFileMap: Map<string, string>,
  primaryPath: string,
  normalize: (value: string) => string | undefined
): void {
  if (requiredFileMap.size === 0) {
    return;
  }
  const normalizedPrimary = normalizePathForCompare(primaryPath, normalize);
  if (!normalizedPrimary) {
    return;
  }
  if (requiredFileMap.has(normalizedPrimary)) {
    return;
  }
  const primaryBaseName = path.posix.basename(normalizedPrimary);
  const candidates = Array.from(requiredFileMap.keys()).filter((key) =>
    path.posix.basename(key) === primaryBaseName
  );
  const shouldReplaceOnlyEntry = requiredFileMap.size === 1;
  const shouldReplaceByBasename = candidates.length === 1;
  if (!shouldReplaceOnlyEntry && !shouldReplaceByBasename) {
    return;
  }
  const keyToReplace = shouldReplaceOnlyEntry
    ? Array.from(requiredFileMap.keys())[0]
    : candidates[0];
  if (!keyToReplace) {
    return;
  }
  requiredFileMap.delete(keyToReplace);
  requiredFileMap.set(normalizedPrimary, primaryPath);
}

function canonicalizeStructuredPath(rawPath: string): string {
  let value = rawPath.trim();
  if (!value) {
    return '';
  }
  value = value.replace(/^[*-]\s+/, '');
  const markdownLinkMatch = value.match(/^\[[^\]]+\]\((.+)\)$/);
  if (markdownLinkMatch?.[1]) {
    value = markdownLinkMatch[1].trim();
  }
  let previous = '';
  while (value && value !== previous) {
    previous = value;
    value = value.replace(/[;,]+$/g, '').trim();
    value = value.replace(/^`{1,3}(.+?)`{1,3}$/s, '$1').trim();
    value = value.replace(/^["'](.+)["']$/s, '$1').trim();
    value = value.replace(/^\((.+)\)$/s, '$1').trim();
  }
  value = value.replace(/[;,]+$/g, '').trim();
  return value.replace(/^\.\/+/, '');
}

function reconcilePrimaryStructuredEntries(params: {
  entries: Array<{ path: string; content: string }>;
  primaryPath: string;
  normalizePath: (value: string) => string | undefined;
}): Array<{ path: string; content: string }> | null {
  const { entries, primaryPath, normalizePath } = params;
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }
  const normalizedPrimary = normalizePathForCompare(primaryPath, normalizePath);
  if (!normalizedPrimary) {
    return null;
  }
  const primaryBaseName = path.posix.basename(normalizedPrimary);
  const normalizedEntries = entries.map((entry, index) => {
    const canonicalPath = canonicalizeStructuredPath(entry.path) || entry.path.trim();
    const normalizedPath = normalizePathForCompare(canonicalPath, normalizePath);
    const fallback = canonicalPath.replace(/\\/g, '/').toLowerCase();
    const baseName = path.posix.basename(normalizedPath ?? fallback);
    return {
      index,
      entry,
      canonicalPath,
      normalizedPath,
      fallback,
      baseName
    };
  });
  const alreadyContainsPrimary = normalizedEntries.some((entry) =>
    entry.normalizedPath === normalizedPrimary || entry.fallback === normalizedPrimary
  );
  if (alreadyContainsPrimary) {
    return null;
  }
  const suffixMatches = normalizedEntries.filter((entry) => {
    const candidate = entry.normalizedPath ?? entry.fallback;
    if (!candidate) {
      return false;
    }
    return candidate.endsWith(`/${normalizedPrimary}`) || normalizedPrimary.endsWith(`/${candidate}`);
  });
  const baseNameMatches = normalizedEntries.filter((entry) => entry.baseName === primaryBaseName);
  const target = suffixMatches.length === 1
    ? suffixMatches[0]
    : baseNameMatches.length === 1
      ? baseNameMatches[0]
      : normalizedEntries.length === 1
        ? normalizedEntries[0]
        : undefined;
  if (!target || !target.entry.content.trim()) {
    return null;
  }
  return entries.map((entry, index) => {
    if (index === target.index) {
      return { path: primaryPath, content: entry.content };
    }
    const canonicalPath = canonicalizeStructuredPath(entry.path);
    return { path: canonicalPath || entry.path, content: entry.content };
  });
}

function buildFallbackFilesBlock(relativePath: string, content: string): string {
  return ['```files', `FILE: ${relativePath}`, content, '```'].join('\n');
}

function buildFilesBlockFromEntries(entries: Array<{ path: string; content: string }>): string {
  const lines: string[] = ['```files'];
  entries.forEach((entry, index) => {
    lines.push(`FILE: ${entry.path}`);
    lines.push(entry.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    if (index !== entries.length - 1) {
      lines.push('');
    }
  });
  lines.push('```');
  return lines.join('\n');
}

function buildDomainExtractionFallback(params: {
  primaryPath: string;
  currentContent: string;
  requiredFiles: string[];
  normalizePath: (value: string) => string | undefined;
}): Array<{ path: string; content: string }> | null {
  const { primaryPath, currentContent, requiredFiles } = params;
  if (!currentContent || requiredFiles.length < 2) {
    return null;
  }
  const extension = getFileExtension(primaryPath);
  if (extension === 'cs') {
    return buildCsharpDomainExtractionFallback(params);
  }
  if (extension === 'ts' || extension === 'tsx') {
    return buildTypeScriptDomainExtractionFallback(params);
  }
  if (extension === 'py') {
    return buildPythonDomainExtractionFallback(params);
  }
  return null;
}

function collectDomainCandidateFiles(params: {
  primaryPath: string;
  requiredFiles: string[];
  normalizePath: (value: string) => string | undefined;
  allowedExtensions: string[];
}): string[] {
  const { primaryPath, requiredFiles, normalizePath, allowedExtensions } = params;
  const normalizedPrimary = normalizePathForCompare(primaryPath, normalizePath);
  return requiredFiles
    .filter((filePath) => normalizePathForCompare(filePath, normalizePath) !== normalizedPrimary)
    .filter((filePath) => /(^|[\\/])domains[\\/]/i.test(filePath))
    .filter((filePath) => allowedExtensions.includes(getFileExtension(filePath)));
}

function buildCsharpDomainExtractionFallback(params: {
  primaryPath: string;
  currentContent: string;
  requiredFiles: string[];
  normalizePath: (value: string) => string | undefined;
}): Array<{ path: string; content: string }> | null {
  const { primaryPath, currentContent, requiredFiles, normalizePath } = params;
  const candidateFiles = collectDomainCandidateFiles({
    primaryPath,
    requiredFiles,
    normalizePath,
    allowedExtensions: ['cs']
  });
  if (candidateFiles.length === 0) {
    return null;
  }
  const namespaceMatch = currentContent.match(/\bnamespace\s+([A-Za-z0-9_.]+)\b/);
  const namespaceValue = namespaceMatch?.[1];
  if (!namespaceValue) {
    return null;
  }
  const extractions: Array<{ path: string; range: { start: number; end: number }; content: string }> = [];
  for (const filePath of candidateFiles) {
    const baseName = getFileBaseName(filePath);
    const className = baseName.replace(/\.cs$/i, '');
    if (!className) {
      return null;
    }
    const range = findClassRange(currentContent, className);
    if (!range) {
      return null;
    }
    extractions.push({
      path: filePath,
      range: { start: range.start, end: range.end },
      content: buildDomainFileContent(namespaceValue, range.content)
    });
  }
  if (extractions.length === 0) {
    return null;
  }
  const ranges = extractions.map((entry) => entry.range).sort((a, b) => b.start - a.start);
  let updatedContent = currentContent;
  for (const range of ranges) {
    updatedContent = removeRange(updatedContent, range.start, range.end);
  }
  updatedContent = collapseExtraBlankLines(updatedContent);
  return [
    { path: primaryPath, content: updatedContent },
    ...extractions.map((entry) => ({ path: entry.path, content: entry.content }))
  ];
}

type TypeScriptDeclarationKind = 'class' | 'interface' | 'type' | 'enum';

function buildTypeScriptDomainExtractionFallback(params: {
  primaryPath: string;
  currentContent: string;
  requiredFiles: string[];
  normalizePath: (value: string) => string | undefined;
}): Array<{ path: string; content: string }> | null {
  const { primaryPath, currentContent, requiredFiles, normalizePath } = params;
  const candidateFiles = collectDomainCandidateFiles({
    primaryPath,
    requiredFiles,
    normalizePath,
    allowedExtensions: ['ts', 'tsx']
  });
  if (candidateFiles.length === 0) {
    return null;
  }
  const importBlock = extractTypeScriptImportBlock(currentContent);
  const extractions: Array<{
    path: string;
    range: { start: number; end: number };
    content: string;
    name: string;
    kind: TypeScriptDeclarationKind;
    importPath: string;
  }> = [];
  for (const filePath of candidateFiles) {
    const baseName = getFileBaseName(filePath);
    const className = baseName.replace(/\.(ts|tsx)$/i, '');
    if (!className) {
      return null;
    }
    const range = findTypeScriptDeclarationRange(currentContent, className);
    if (!range) {
      return null;
    }
    const importPath = buildRelativeImportPath(primaryPath, filePath);
    if (!importPath) {
      return null;
    }
    extractions.push({
      path: filePath,
      range: { start: range.start, end: range.end },
      content: buildTypeScriptDomainFileContent(importBlock, ensureTypeScriptExport(range.content, range.kind)),
      name: className,
      kind: range.kind,
      importPath
    });
  }
  if (extractions.length === 0) {
    return null;
  }
  const ranges = extractions.map((entry) => entry.range).sort((a, b) => b.start - a.start);
  let updatedContent = currentContent;
  for (const range of ranges) {
    updatedContent = removeRange(updatedContent, range.start, range.end);
  }
  updatedContent = collapseExtraBlankLines(updatedContent);
  for (const extraction of extractions) {
    const importLine = buildTypeScriptImportLine(extraction);
    updatedContent = insertTypeScriptImport(updatedContent, importLine, extraction.importPath, extraction.name);
  }
  return [
    { path: primaryPath, content: updatedContent },
    ...extractions.map((entry) => ({ path: entry.path, content: entry.content }))
  ];
}

function buildPythonDomainExtractionFallback(params: {
  primaryPath: string;
  currentContent: string;
  requiredFiles: string[];
  normalizePath: (value: string) => string | undefined;
}): Array<{ path: string; content: string }> | null {
  const { primaryPath, currentContent, requiredFiles, normalizePath } = params;
  const candidateFiles = collectDomainCandidateFiles({
    primaryPath,
    requiredFiles,
    normalizePath,
    allowedExtensions: ['py']
  });
  if (candidateFiles.length === 0) {
    return null;
  }
  const importBlock = extractPythonImportBlock(currentContent);
  const extractions: Array<{
    path: string;
    range: { start: number; end: number };
    content: string;
    name: string;
    importLine: string;
  }> = [];
  for (const filePath of candidateFiles) {
    const baseName = getFileBaseName(filePath);
    const className = fileNameToClassName(baseName.replace(/\.py$/i, ''));
    if (!className) {
      return null;
    }
    const range = findPythonClassRange(currentContent, className);
    if (!range) {
      return null;
    }
    const importLine = buildPythonImportLine(primaryPath, filePath, className);
    if (!importLine) {
      return null;
    }
    extractions.push({
      path: filePath,
      range: { start: range.start, end: range.end },
      content: buildPythonDomainFileContent(importBlock, range.content),
      name: className,
      importLine
    });
  }
  if (extractions.length === 0) {
    return null;
  }
  const ranges = extractions.map((entry) => entry.range).sort((a, b) => b.start - a.start);
  let updatedContent = currentContent;
  for (const range of ranges) {
    updatedContent = removeRange(updatedContent, range.start, range.end);
  }
  updatedContent = collapseExtraBlankLines(updatedContent);
  for (const extraction of extractions) {
    updatedContent = insertPythonImport(updatedContent, extraction.importLine);
  }
  return [
    { path: primaryPath, content: updatedContent },
    ...extractions.map((entry) => ({ path: entry.path, content: entry.content }))
  ];
}

function getFileBaseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? normalized;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function buildRelativeImportPath(fromPath: string, toPath: string): string | null {
  const fromDir = path.posix.dirname(toPosixPath(fromPath));
  const toFile = toPosixPath(toPath);
  let relative = path.posix.relative(fromDir, toFile);
  if (!relative) {
    return null;
  }
  if (!relative.startsWith('.')) {
    relative = `./${relative}`;
  }
  return relative.replace(/\.[^.\\/]+$/i, '');
}

function findTypeScriptDeclarationRange(
  source: string,
  name: string
): { start: number; end: number; content: string; kind: TypeScriptDeclarationKind } | null {
  const pattern = new RegExp(
    `(^|\\n)([\\t ]*)(?:export\\s+)?(?:declare\\s+)?(class|interface|type|enum)\\s+${escapeRegex(name)}\\b`,
    'm'
  );
  const match = pattern.exec(source);
  if (!match) {
    return null;
  }
  const kind = match[3] as TypeScriptDeclarationKind;
  const lineStart = source.lastIndexOf('\n', match.index);
  const start = lineStart === -1 ? 0 : lineStart + 1;
  if (kind === 'type') {
    const equalsIndex = source.indexOf('=', match.index + match[0].length);
    if (equalsIndex < 0) {
      return null;
    }
    const endIndex = findTypeScriptStatementEnd(source, equalsIndex + 1);
    if (endIndex === null) {
      return null;
    }
    return {
      start,
      end: endIndex,
      content: source.slice(start, endIndex + 1),
      kind
    };
  }
  const braceIndex = source.indexOf('{', match.index + match[0].length);
  if (braceIndex < 0) {
    return null;
  }
  const endIndex = findBalancedBraces(source, braceIndex);
  if (endIndex === null) {
    return null;
  }
  return {
    start,
    end: endIndex,
    content: source.slice(start, endIndex + 1),
    kind
  };
}

function findBalancedBraces(source: string, openIndex: number): number | null {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      if (!escaped && char === "'") {
        inSingle = false;
      }
      escaped = char === '\\' && !escaped;
      continue;
    }
    if (inDouble) {
      if (!escaped && char === '"') {
        inDouble = false;
      }
      escaped = char === '\\' && !escaped;
      continue;
    }
    if (inTemplate) {
      if (!escaped && char === '`') {
        inTemplate = false;
      }
      escaped = char === '\\' && !escaped;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      escaped = false;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      escaped = false;
      continue;
    }
    if (char === '`') {
      inTemplate = true;
      escaped = false;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return null;
}

function findTypeScriptStatementEnd(source: string, startIndex: number): number | null {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  for (let i = startIndex; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      if (!escaped && char === "'") {
        inSingle = false;
      }
      escaped = char === '\\' && !escaped;
      continue;
    }
    if (inDouble) {
      if (!escaped && char === '"') {
        inDouble = false;
      }
      escaped = char === '\\' && !escaped;
      continue;
    }
    if (inTemplate) {
      if (!escaped && char === '`') {
        inTemplate = false;
      }
      escaped = char === '\\' && !escaped;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      escaped = false;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      escaped = false;
      continue;
    }
    if (char === '`') {
      inTemplate = true;
      escaped = false;
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (char === ';' && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      return i;
    }
  }
  return null;
}

function ensureTypeScriptExport(content: string, kind: TypeScriptDeclarationKind): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const declarationPattern = new RegExp(`\\b${kind}\\b`);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!declarationPattern.test(line)) {
      continue;
    }
    if (/\bexport\b/.test(line)) {
      break;
    }
    lines[i] = line.replace(/^(\s*)/, '$1export ');
    break;
  }
  return lines.join('\n');
}

function extractTypeScriptImportBlock(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let firstImport = -1;
  let lastImport = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*import\b/.test(line)) {
      if (firstImport < 0) {
        firstImport = i;
      }
      lastImport = i;
      continue;
    }
    if (firstImport >= 0) {
      if (!line.trim() || /^\s*\/[/*]/.test(line) || /^\s*\*/.test(line)) {
        continue;
      }
      break;
    }
    if (!line.trim() || /^\s*\/[/*]/.test(line) || /^\s*\*/.test(line)) {
      continue;
    }
    if (/^\s*['"]use\s+/.test(line)) {
      continue;
    }
    break;
  }
  if (firstImport < 0 || lastImport < firstImport) {
    return '';
  }
  return lines.slice(firstImport, lastImport + 1).join('\n').trimEnd();
}

function buildTypeScriptDomainFileContent(importBlock: string, declarationContent: string): string {
  const parts: string[] = [];
  if (importBlock.trim().length > 0) {
    parts.push(importBlock.trimEnd());
  }
  parts.push(declarationContent.trimEnd());
  return `${parts.join('\n\n').trimEnd()}\n`;
}

function buildTypeScriptImportLine(extraction: {
  name: string;
  kind: TypeScriptDeclarationKind;
  importPath: string;
}): string {
  const typeOnly = extraction.kind === 'interface' || extraction.kind === 'type';
  const keyword = typeOnly ? 'import type' : 'import';
  return `${keyword} { ${extraction.name} } from '${extraction.importPath}';`;
}

function insertTypeScriptImport(
  source: string,
  importLine: string,
  importPath: string,
  symbolName: string
): string {
  if (hasTypeScriptImport(source, importPath, symbolName)) {
    return source;
  }
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const insertIndex = findTypeScriptImportInsertIndex(lines);
  lines.splice(insertIndex, 0, importLine);
  return lines.join('\n');
}

function hasTypeScriptImport(source: string, importPath: string, symbolName: string): boolean {
  const normalizedPath = toPosixPath(importPath);
  const symbolPattern = new RegExp(`\\b${escapeRegex(symbolName)}\\b`);
  return source
    .replace(/\r\n/g, '\n')
    .split('\n')
    .some((line) => {
      if (!/^\s*import\b/.test(line)) {
        return false;
      }
      const hasPath =
        line.includes(`'${normalizedPath}'`) ||
        line.includes(`"${normalizedPath}"`) ||
        line.includes(`'${importPath}'`) ||
        line.includes(`"${importPath}"`);
      return hasPath && symbolPattern.test(line);
    });
}

function findTypeScriptImportInsertIndex(lines: string[]): number {
  let lastImport = -1;
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*import\b/.test(line)) {
      lastImport = index;
      continue;
    }
    if (lastImport >= 0) {
      if (!line.trim() || /^\s*\/[/*]/.test(line) || /^\s*\*/.test(line)) {
        continue;
      }
      break;
    }
    if (!line.trim() || /^\s*\/[/*]/.test(line) || /^\s*\*/.test(line)) {
      continue;
    }
    if (/^\s*['"]use\s+/.test(line)) {
      continue;
    }
    break;
  }
  return lastImport >= 0 ? lastImport + 1 : index;
}

function fileNameToClassName(baseName: string): string {
  const sanitized = baseName.replace(/[^A-Za-z0-9_]/g, '_');
  if (sanitized.includes('_')) {
    return sanitized
      .split('_')
      .filter(Boolean)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join('');
  }
  if (sanitized === sanitized.toLowerCase()) {
    return sanitized.charAt(0).toUpperCase() + sanitized.slice(1);
  }
  return sanitized;
}

function findPythonClassRange(
  source: string,
  className: string
): { start: number; end: number; content: string } | null {
  const normalized = source.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const classPattern = new RegExp(`^\\s*class\\s+${escapeRegex(className)}\\b`);
  let classLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (classPattern.test(lines[i])) {
      classLine = i;
      break;
    }
  }
  if (classLine < 0) {
    return null;
  }
  const classIndent = getLineIndent(lines[classLine]);
  let startLine = classLine;
  while (startLine > 0 && /^\s*@/.test(lines[startLine - 1])) {
    const decoratorIndent = getLineIndent(lines[startLine - 1]);
    if (decoratorIndent !== classIndent) {
      break;
    }
    startLine -= 1;
  }
  let endLine = lines.length - 1;
  for (let i = classLine + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    const indent = getLineIndent(line);
    if (indent <= classIndent && !line.trim().startsWith('#')) {
      endLine = i - 1;
      break;
    }
  }
  const lineOffsets = buildLineOffsets(lines);
  const start = lineOffsets[startLine];
  const end = lineOffsets[endLine] + Math.max(0, lines[endLine].length - 1);
  return {
    start,
    end,
    content: normalized.slice(start, end + 1)
  };
}

function getLineIndent(line: string): number {
  const match = line.match(/^\s*/);
  return match ? match[0].length : 0;
}

function buildLineOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
}

function buildPythonImportLine(primaryPath: string, domainPath: string, className: string): string | null {
  const primaryDir = path.posix.dirname(toPosixPath(primaryPath));
  const domainFile = toPosixPath(domainPath);
  const relative = path.posix.relative(primaryDir, domainFile);
  if (!relative || relative.startsWith('..')) {
    return null;
  }
  const modulePath = relative.replace(/\.py$/i, '').split('/').join('.');
  const importPath = modulePath.startsWith('.') ? modulePath : `.${modulePath}`;
  return `from ${importPath} import ${className}`;
}

function extractPythonImportBlock(source: string): string {
  const normalized = source.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let index = 0;
  if (lines[0]?.startsWith('#!')) {
    index = 1;
  }
  const docstringEnd = findPythonDocstringEnd(lines, index);
  if (docstringEnd !== null) {
    index = docstringEnd + 1;
  }
  while (index < lines.length && !lines[index].trim()) {
    index += 1;
  }
  let firstImport = -1;
  let lastImport = -1;
  for (let i = index; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(from|import)\s+/.test(line)) {
      if (firstImport < 0) {
        firstImport = i;
      }
      lastImport = i;
      continue;
    }
    if (firstImport >= 0) {
      if (!line.trim() || /^\s*#/.test(line)) {
        continue;
      }
      break;
    }
    break;
  }
  if (firstImport < 0 || lastImport < firstImport) {
    return '';
  }
  return lines.slice(firstImport, lastImport + 1).join('\n').trimEnd();
}

function buildPythonDomainFileContent(importBlock: string, classContent: string): string {
  const normalized = normalizeIndent(classContent);
  const parts: string[] = [];
  if (importBlock.trim().length > 0) {
    parts.push(importBlock.trimEnd());
  }
  parts.push(normalized.trimEnd());
  return `${parts.join('\n\n').trimEnd()}\n`;
}

function insertPythonImport(source: string, importLine: string): string {
  const normalized = source.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.some((line) => line.trim() === importLine.trim())) {
    return source;
  }
  let index = 0;
  if (lines[0]?.startsWith('#!')) {
    index = 1;
  }
  const docstringEnd = findPythonDocstringEnd(lines, index);
  if (docstringEnd !== null) {
    index = docstringEnd + 1;
  }
  while (index < lines.length && !lines[index].trim()) {
    index += 1;
  }
  let insertIndex = index;
  let lastFuture = -1;
  for (let i = index; i < lines.length; i += 1) {
    if (/^\s*from\s+__future__\s+import\s+/.test(lines[i])) {
      lastFuture = i;
      continue;
    }
    break;
  }
  if (lastFuture >= 0) {
    insertIndex = lastFuture + 1;
  } else {
    let lastImport = -1;
    for (let i = index; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*(from|import)\s+/.test(line)) {
        lastImport = i;
        continue;
      }
      if (lastImport >= 0 && (!line.trim() || /^\s*#/.test(line))) {
        continue;
      }
      break;
    }
    insertIndex = lastImport >= 0 ? lastImport + 1 : index;
  }
  lines.splice(insertIndex, 0, importLine);
  return lines.join('\n');
}

function findPythonDocstringEnd(lines: string[], startIndex: number): number | null {
  const firstLine = lines[startIndex];
  if (!firstLine) {
    return null;
  }
  const trimmed = firstLine.trim();
  const quote = trimmed.startsWith('"""') ? '"""' : trimmed.startsWith("'''") ? "'''" : null;
  if (!quote) {
    return null;
  }
  if (trimmed.length > quote.length && trimmed.includes(quote, quote.length)) {
    return startIndex;
  }
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (lines[i].includes(quote)) {
      return i;
    }
  }
  return lines.length - 1;
}

function findClassRange(
  source: string,
  className: string
): { start: number; end: number; content: string } | null {
  const pattern = new RegExp(`\\bclass\\s+${escapeRegex(className)}\\b`);
  const match = pattern.exec(source);
  if (!match) {
    return null;
  }
  const braceIndex = source.indexOf('{', match.index + match[0].length);
  if (braceIndex < 0) {
    return null;
  }
  let depth = 0;
  for (let i = braceIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const lineStart = source.lastIndexOf('\n', match.index);
        const start = lineStart === -1 ? 0 : lineStart + 1;
        return {
          start,
          end: i,
          content: source.slice(start, i + 1)
        };
      }
    }
  }
  return null;
}

function buildDomainFileContent(namespaceValue: string, classContent: string): string {
  const normalized = normalizeIndent(classContent);
  const needsCollections = /\b(List|Dictionary|HashSet|IReadOnlyList|IReadOnlyDictionary)\s*</.test(normalized);
  const needsSystem = /\b(DateTime|DateOnly|TimeOnly|Guid|TimeSpan|Uri)\b/.test(normalized);
  const headerLines: string[] = [];
  if (needsSystem) {
    headerLines.push('using System;');
  }
  if (needsCollections) {
    headerLines.push('using System.Collections.Generic;');
  }
  if (headerLines.length > 0) {
    headerLines.push('');
  }
  return [
    ...headerLines,
    `namespace ${namespaceValue}`,
    '{',
    indentBlock(normalized, '    '),
    '}',
    ''
  ].join('\n');
}

function normalizeIndent(block: string): string {
  const lines = block.replace(/\r\n/g, '\n').split('\n');
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) {
    return block.trim();
  }
  const minIndent = Math.min(
    ...nonEmpty.map((line) => {
      const match = line.match(/^\s*/);
      return match ? match[0].length : 0;
    })
  );
  return lines.map((line) => line.slice(minIndent)).join('\n').trim();
}

function indentBlock(content: string, indent: string): string {
  return content
    .split('\n')
    .map((line) => (line.length > 0 ? `${indent}${line}` : line))
    .join('\n');
}

function removeRange(source: string, start: number, end: number): string {
  const before = source.slice(0, start);
  const after = source.slice(end + 1);
  return `${before.replace(/[ \t]*$/, '')}${after}`;
}

function collapseExtraBlankLines(source: string): string {
  return source.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractFallbackFileContent(rawResponse: string, relativePath: string): string | null {
  if (!rawResponse) {
    return null;
  }
  const fenced = extractLargestCodeFence(rawResponse);
  if (fenced) {
    return fenced;
  }
  const normalized = rawResponse.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return null;
  }
  const lines = normalized.split('\n');
  const startIndex = findCodeStartIndex(lines, relativePath);
  if (startIndex >= 0) {
    const trimmed = lines.slice(startIndex).join('\n').trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const stripped = stripLeadingNarrative(lines).join('\n').trim();
  if (stripped.length > 0 && looksLikeSourceFile(stripped, relativePath)) {
    return stripped;
  }
  if (looksLikeSourceFile(normalized, relativePath)) {
    return normalized;
  }
  return null;
}

function extractLargestCodeFence(rawResponse: string): string | null {
  const fenceRegex = /```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null = null;
  let best: string | null = null;
  let bestLength = 0;
  while ((match = fenceRegex.exec(rawResponse)) !== null) {
    const content = match[1]?.trim() ?? '';
    if (content.length > bestLength) {
      best = content;
      bestLength = content.length;
    }
  }
  return bestLength > 0 ? best : null;
}

function stripLeadingNarrative(lines: string[]): string[] {
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? '';
    if (!line) {
      index += 1;
      continue;
    }
    if (isNarrativeLine(line)) {
      index += 1;
      continue;
    }
    break;
  }
  return lines.slice(index);
}

function isNarrativeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }
  if (/^\/[/*]/.test(trimmed)) {
    return false;
  }
  if (/^\s*(using|namespace|public|internal|private|protected)\b/.test(trimmed)) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('sure') || lower.startsWith('okay') || lower.startsWith('here') || lower.startsWith('plan')) {
    return true;
  }
  if (lower.startsWith('steps') || lower.startsWith('explanation') || lower.startsWith('changes')) {
    return true;
  }
  if (lower.startsWith('goal:') || lower.startsWith('project summary:') || lower.startsWith('file path:')) {
    return true;
  }
  if (/^return only\b/.test(lower) || /^respond only\b/.test(lower)) {
    return true;
  }
  if (/^[-*]\s+/.test(trimmed) || /^\d+[).]\s+/.test(trimmed)) {
    return true;
  }
  return false;
}

function findCodeStartIndex(lines: string[], relativePath: string): number {
  const ext = getFileExtension(relativePath);
  const patterns = getCodeStartPatterns(ext);
  if (patterns.length === 0) {
    return -1;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (patterns.some((pattern) => pattern.test(line))) {
      return index;
    }
  }
  return -1;
}

function looksLikeSourceFile(content: string, relativePath: string): boolean {
  const ext = getFileExtension(relativePath);
  if (ext === 'cs' || ext === 'csx') {
    return /\bnamespace\b|\bclass\b|\busing\b/.test(content);
  }
  if (ext === 'csproj') {
    return /<Project\b/.test(content);
  }
  if (ext === 'sln') {
    return /Visual Studio Solution File/i.test(content);
  }
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
    return /\bimport\b|\bexport\b|\bfunction\b|\bclass\b/.test(content);
  }
  return content.includes('\n') && content.length > 40;
}

function getFileExtension(relativePath: string): string {
  const parts = relativePath.split('.');
  if (parts.length < 2) {
    return '';
  }
  return parts[parts.length - 1]?.toLowerCase() ?? '';
}

function getCodeStartPatterns(ext: string): RegExp[] {
  if (ext === 'cs' || ext === 'csx') {
    return [
      /^\s*using\s+/,
      /^\s*namespace\s+/,
      /^\s*(public|internal|private|protected)\s+(class|record|interface|struct|enum)\b/,
      /^\s*class\s+/
    ];
  }
  if (ext === 'csproj') {
    return [/^\s*<Project\b/];
  }
  if (ext === 'sln') {
    return [/^Microsoft Visual Studio Solution File/i];
  }
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
    return [
      /^\s*import\s+/,
      /^\s*export\s+/,
      /^\s*(const|let|var|function|class|interface|type)\b/
    ];
  }
  if (ext === 'json') {
    return [/^\s*[{[]/];
  }
  if (ext === 'yaml' || ext === 'yml') {
    return [/^\s*[A-Za-z0-9_-]+\s*:/];
  }
  return [];
}

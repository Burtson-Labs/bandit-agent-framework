import * as path from 'path';
import type {
  CallerStepMetadata,
  HelperStepMetadata,
  IHelperManager,
  IFsAdapter,
  StepOutcome
} from '../internalTypes';
import * as ts from 'typescript';

const HELPER_RUNTIME_STORE = 'focus.helpers';
const HELPER_IMPORT_HINT_STORE = `${HELPER_RUNTIME_STORE}.importHints`;
const MAX_HELPER_IMPORT_HINTS = 12;

interface HelperExportMetadata {
  defaultName?: string;
  named: string[];
}

interface HelperVerificationState {
  path: string;
  checkedAt: number;
  exports?: HelperExportMetadata;
  snippet?: string;
  source?: string;
  typecheck?: { ok: boolean; output?: string };
}

interface HelperUsageHint {
  path: string;
  importStatement: string;
  description?: string;
  snippet?: string;
}

interface HelperImportMapping {
  fromCaller: string;
  fromHelper: string;
  resolved: string;
}

interface TypeCheckResult {
  ok: boolean;
  output?: string;
}

export interface HelperManagerDeps {
  fs: IFsAdapter;
  getWorkspaceRoot(): string | undefined;
  getContextValue<T>(key: string): T | undefined;
  setContextValue(key: string, value: unknown): void;
  runTypeCheck(options?: { files?: string[] }): Promise<TypeCheckResult>;
  normalizeRelativePath(value: string): string | undefined;
  resolveWorkspaceImportTarget(relativePath: string): string | undefined;
  ensureWorkspaceIndex(): Promise<void>;
  conversationMarkerPatterns: RegExp[];
  clampSnippet(content: string, limit?: number): string;
}

export function createHelperManager(deps: HelperManagerDeps): IHelperManager {
  return {
    async validate(meta: HelperStepMetadata): Promise<StepOutcome> {
      const helperPath = meta.helperPath?.trim();
      if (!helperPath) {
        return { ok: false, error: 'Helper path unavailable for validation.' };
      }
      const workspaceRoot = deps.getWorkspaceRoot();
      if (!workspaceRoot) {
        return { ok: false, error: 'Workspace root unavailable for helper validation.' };
      }
      const absolute = path.join(workspaceRoot, helperPath);
      const draftContent = meta.outputRef ? deps.getContextValue<string>(meta.outputRef) : undefined;
      let content = typeof draftContent === 'string' ? draftContent : '';
      let loadedFrom: 'context' | 'workspace' | undefined;
      if (content.trim().length > 0) {
        loadedFrom = 'context';
      } else {
        try {
          const exists = await deps.fs.exists(absolute);
          if (exists) {
            content = await deps.fs.readText(absolute);
            loadedFrom = 'workspace';
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, error: `Unable to read helper file ${helperPath}: ${message}` };
        }
      }
      if (!content || content.trim().length === 0) {
        return { ok: false, error: `Helper content unavailable for validation: ${helperPath}` };
      }
      if (containsDiffMarkers(content)) {
        return {
          ok: false,
          error: `Helper file ${helperPath} contains diff markers or multiple file outputs. Return only the helper file contents.`,
          data: { helperPath }
        };
      }
      if (containsConversationMarkers(content, deps.conversationMarkerPatterns)) {
        return {
          ok: false,
          error: `Helper file ${helperPath} contains conversation markers like <start_of_turn>. Return only the helper file contents.`,
          data: { helperPath }
        };
      }
      if (!fileContainsExport(content)) {
        return { ok: false, error: `Helper file ${helperPath} must export a component or function.` };
      }
      const syntaxValidation = validateHelperSyntax(content);
      if (!syntaxValidation.ok) {
        return {
          ok: false,
          error: syntaxValidation.error ?? `Syntax validation failed for ${helperPath}`,
          data: { helperPath }
        };
      }
      const helperExports = extractHelperExports(content);
      if (usesJsx(content)) {
        if (!helperExports.defaultName) {
          return {
            ok: false,
            error: `Helper file ${helperPath} should use a default export for React components.`,
            data: { helperPath }
          };
        }
        if (hasImplicitAnyProps(content)) {
          return {
            ok: false,
            error: `Helper file ${helperPath} must strongly type component props to avoid implicit any.`,
            data: { helperPath }
          };
        }
      }
      const selfImport = findSelfImport(content, helperPath, deps.normalizeRelativePath);
      if (selfImport) {
        return {
          ok: false,
          error: `Helper file ${helperPath} imports itself via "${selfImport}". Remove the self-referencing import.`,
          data: { helperPath }
        };
      }
      const snippet = deps.clampSnippet(content.trim(), 1800);
      const helperKey = (meta.helperId ?? helperPath).replace(/[^a-z0-9]/gi, '_');
      deps.setContextValue(`${HELPER_RUNTIME_STORE}.${helperKey}.verified`, {
        path: helperPath,
        checkedAt: Date.now(),
        exports: helperExports,
        snippet,
        source: loadedFrom ?? 'unknown',
        typecheck: { ok: true }
      } satisfies HelperVerificationState);
      return { ok: true };
    },

    async buildHelperGuidance(helperPath: string): Promise<string | undefined> {
      if (!helperPath) {
        return undefined;
      }
      await deps.ensureWorkspaceIndex().catch(() => undefined);
      const callerPath = deps.getContextValue<string>('focus.extract.sourcePath');
      const callerContent = deps.getContextValue<string>('focus.primary.content');
      const projectRoot = inferProjectSourceRoot(helperPath) ?? inferProjectSourceRoot(callerPath);
      let mappings: HelperImportMapping[] = [];
      if (callerPath && typeof callerContent === 'string' && callerContent.trim().length > 0) {
        mappings = computeHelperImportMappings(helperPath, callerPath, callerContent, deps);
      }
      const sections = [
        'Path context for helper rewrite:',
        `projectRoot: ${projectRoot ?? 'workspace root'}`,
        `callerFilePath: ${callerPath ?? 'unknown'}`,
        `targetFilePath: ${helperPath}`
      ];
      if (mappings.length > 0) {
        storeHelperImportHints(helperPath, mappings, deps);
        sections.push('validRelativeImports:');
        sections.push(JSON.stringify(mappings, null, 2));
      } else {
        sections.push('validRelativeImports: []');
      }
      sections.push('Rewrite every import to resolve from targetFilePath. Never copy caller-relative import specifiers without translating them.');
      return sections.join('\n');
    },

    async buildCallerGuidance(meta: CallerStepMetadata, callerPath: string): Promise<string | undefined> {
      const hints = collectHelperUsageHints(meta, callerPath, deps);
      if (hints.length === 0) {
        const additional = buildCallerPreservationHints(callerPath, deps);
        return additional?.length ? additional.join('\n\n') : undefined;
      }
      const sections: string[] = [
        'Helper file(s) were extracted earlier. Import and invoke them directly instead of recreating their JSX or handlers.'
      ];
      hints.forEach((hint, index) => {
        const parts = [
          `${index + 1}. Helper path: ${hint.path}`,
          `Import example: ${hint.importStatement}`
        ];
        if (hint.description) {
          parts.push(hint.description);
        }
        if (hint.snippet) {
          parts.push(['```tsx', hint.snippet.trim(), '```'].join('\n'));
        }
        sections.push(parts.join('\n'));
      });
      sections.push('Do not edit the helper files in this step — only update the caller to consume them.');
      const preservationHints = buildCallerPreservationHints(callerPath, deps);
      if (preservationHints.length > 0) {
        sections.push(preservationHints.join('\n\n'));
      }
      return sections.join('\n\n');
    },

    applyImportHints(meta: HelperStepMetadata | undefined, content: string): string {
      if (!meta?.helperPath || !content) {
        return content;
      }
      const key = normalizeHelperImportKey(meta.helperPath, deps);
      if (!key) {
        return content;
      }
      const hints = deps.getContextValue<HelperImportMapping[]>(`${HELPER_IMPORT_HINT_STORE}.${key}`);
      if (!hints || hints.length === 0) {
        return content;
      }
      let updated = content;
      hints.forEach((hint) => {
        const escaped = hint.fromCaller.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`from\\s+['"]${escaped}['"]`, 'g');
        updated = updated.replace(pattern, `from '${hint.fromHelper}'`);
      });
      return updated;
    },

    async ensureChainReady(meta: CallerStepMetadata): Promise<StepOutcome> {
      const helperIds = meta.helperIds ?? [];
      const helperPaths = meta.helperPaths ?? [];
      if (!helperIds.length && !helperPaths.length) {
        return { ok: true };
      }
      const workspaceRoot = deps.getWorkspaceRoot();
      if (!workspaceRoot) {
        return { ok: false, error: 'Workspace root unavailable.' };
      }
      const resolvedPaths: string[] = [];
      for (const id of helperIds) {
        const state = deps.getContextValue<HelperVerificationState>(`${HELPER_RUNTIME_STORE}.${id}.verified`);
        if (state?.path) {
          resolvedPaths.push(state.path);
        }
      }
      helperPaths.forEach((helperPath) => {
        if (helperPath && !resolvedPaths.includes(helperPath)) {
          resolvedPaths.push(helperPath);
        }
      });
      if (!resolvedPaths.length) {
        return { ok: false, error: 'No helper paths available for caller preparation.' };
      }
      const missing: string[] = [];
      for (const helperPath of resolvedPaths) {
        const absolute = path.join(workspaceRoot, helperPath);
        const exists = await deps.fs.exists(absolute);
        if (!exists) {
          missing.push(helperPath);
        }
      }
      if (missing.length > 0) {
        return { ok: false, error: `Helper files missing before caller update: ${missing.join(', ')}` };
      }
      return { ok: true };
    }
  };
}

function fileContainsExport(content: string): boolean {
  if (!content) {
    return false;
  }
  const exportPattern = /\bexport\s+(?:default\s+)?(?:const|function|class|interface|type|enum)\b/;
  return exportPattern.test(content);
}

function containsDiffMarkers(content: string): boolean {
  if (!content) {
    return false;
  }
  const indicators = ['diff --git', '\n--- ', '\n+++ ', '\n@@', '\n// src/', '// src/'];
  return indicators.some((indicator) => content.includes(indicator));
}

function containsConversationMarkers(content: string, patterns: RegExp[]): boolean {
  if (!content) {
    return false;
  }
  for (const regex of patterns) {
    regex.lastIndex = 0;
    if (regex.test(content)) {
      return true;
    }
  }
  return false;
}

function validateHelperSyntax(content: string): { ok: boolean; error?: string } {
  try {
    const result = ts.transpileModule(content, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        allowJs: true
      },
      reportDiagnostics: true
    });
    const diagnostics = (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
    );
    if (diagnostics.length === 0) {
      return { ok: true };
    }
    const summary = diagnostics
      .map((diagnostic) => {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
        const line = diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
          : undefined;
        return line ? `line ${line}: ${message}` : message;
      })
      .slice(0, 3)
      .join('; ');
    return { ok: false, error: summary || 'Syntax errors detected.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

function usesJsx(content: string): boolean {
  if (!content) {
    return false;
  }
  const jsxPattern = /<[A-Za-z][\w:-]*(\s[^>]*>|>)/m;
  return jsxPattern.test(content);
}

function hasImplicitAnyProps(content: string): boolean {
  if (!usesJsx(content)) {
    return false;
  }
  const typedPropsPattern = /:\s*(?:React\.)?(?:FC|FunctionComponent)<[^>]+>/;
  const typedDestructurePattern = /\(\s*{\s*[^}]+}\s*:\s*[^)]+\)/;
  const typedParamPattern = /\(\s*[A-Za-z_$][\w$]*\s*:\s*[^)]+\)/;
  if (
    typedPropsPattern.test(content)
    || typedDestructurePattern.test(content)
    || typedParamPattern.test(content)
  ) {
    return false;
  }
  const exportedUntypedPattern =
    /export\s+(?:default\s+)?(?:const|function)\s+[A-Za-z0-9_]+\s*(?:=\s*)?\(\s*(?:{[^}]+}|[A-Za-z_$][\w$]*)\s*\)/;
  if (exportedUntypedPattern.test(content)) {
    return true;
  }
  const defaultExportUntypedPattern =
    /const\s+[A-Za-z0-9_]+\s*=\s*\(\s*(?:{[^}]+}|[A-Za-z_$][\w$]*)\s*\)\s*=>/;
  if (defaultExportUntypedPattern.test(content) && /export\s+default\s+[A-Za-z0-9_]+/.test(content)) {
    return true;
  }
  return false;
}

function extractHelperExports(content: string): HelperExportMetadata {
  const metadata: HelperExportMetadata = { named: [] };
  if (!content) {
    return metadata;
  }
  const defaultPatterns = [
    /export\s+default\s+function\s+([A-Za-z0-9_]+)/,
    /export\s+default\s+class\s+([A-Za-z0-9_]+)/,
    /export\s+default\s+([A-Za-z0-9_]+)/,
    /export\s+default\s+const\s+([A-Za-z0-9_]+)/,
    /export\s+default\s+let\s+([A-Za-z0-9_]+)/,
    /export\s+default\s+var\s+([A-Za-z0-9_]+)/
  ];
  for (const pattern of defaultPatterns) {
    const match = pattern.exec(content);
    if (match && match[1]) {
      metadata.defaultName = match[1];
      break;
    }
  }
  const namedPatterns = [
    /export\s+(?:const|function|class|enum|interface|type)\s+([A-Za-z0-9_]+)/g,
    /export\s+{([^}]+)}/g
  ];
  for (const pattern of namedPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (!match[1]) {
        continue;
      }
      if (pattern === namedPatterns[0]) {
        metadata.named.push(match[1]);
        continue;
      }
      const exports = match[1]
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/\s+as\s+.*/i, '').trim());
      metadata.named.push(...exports);
    }
  }
  const unique = Array.from(new Set(metadata.named.filter(Boolean)));
  metadata.named = unique;
  return metadata;
}

function findSelfImport(
  content: string,
  helperPath: string,
  normalizeRelativePath: (value: string) => string | undefined
): string | undefined {
  if (!content || !helperPath) {
    return undefined;
  }
  const normalizedPath = normalizeRelativePath(helperPath) ?? helperPath;
  const normalizedPosix = normalizedPath.replace(/\\/g, '/');
  const normalizedNoExt = normalizedPosix.replace(/\.[^.]+$/, '');
  const helperDir = path.posix.dirname(normalizedPosix);
  const specifiers = extractRelativeImportSpecifiers(content);
  for (const specifier of specifiers) {
    if (!specifier.startsWith('.')) {
      continue;
    }
    const resolved = path.posix.normalize(path.posix.join(helperDir, specifier));
    const resolvedNoExt = resolved.replace(/\.[^.]+$/, '');
    if (resolved === normalizedPosix || resolvedNoExt === normalizedNoExt) {
      return specifier;
    }
  }
  return undefined;
}

function collectHelperUsageHints(meta: CallerStepMetadata, callerPath: string, deps: HelperManagerDeps): HelperUsageHint[] {
  const hints: HelperUsageHint[] = [];
  const helperIds = meta.helperIds ?? [];
  helperIds.forEach((id) => {
    const state = deps.getContextValue<HelperVerificationState>(`${HELPER_RUNTIME_STORE}.${id}.verified`);
    if (!state?.path) {
      return;
    }
    const hint = buildHelperUsageHint(state, callerPath);
    if (hint) {
      hints.push(hint);
    }
  });
  if (hints.length === 0 && meta.helperPaths?.length) {
    meta.helperPaths.forEach((helperPath) => {
      const fallbackState: HelperVerificationState = { path: helperPath, checkedAt: Date.now(), snippet: undefined };
      const hint = buildHelperUsageHint(fallbackState, callerPath);
      if (hint) {
        hints.push(hint);
      }
    });
  }
  return hints;
}

function computeHelperImportMappings(
  helperPath: string,
  callerPath: string,
  callerContent: string,
  deps: HelperManagerDeps
): HelperImportMapping[] {
  const helperDir = path.posix.dirname(helperPath);
  const callerDir = path.posix.dirname(callerPath);
  const specifiers = extractRelativeImportSpecifiers(callerContent);
  const seen = new Set<string>();
  const mappings: HelperImportMapping[] = [];
  for (const specifier of specifiers) {
    const resolved = path.posix.normalize(path.posix.join(callerDir, specifier));
    const normalized = deps.normalizeRelativePath(resolved) ?? resolved.replace(/\\/g, '/');
    if (!normalized) {
      continue;
    }
    const workspaceTarget = deps.resolveWorkspaceImportTarget(normalized);
    if (!workspaceTarget) {
      continue;
    }
    const helperSpecifier = buildRelativeImportSpecifier(helperDir, workspaceTarget);
    if (!helperSpecifier || helperSpecifier === specifier) {
      continue;
    }
    const key = `${specifier}|${workspaceTarget.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    mappings.push({
      fromCaller: specifier,
      fromHelper: helperSpecifier,
      resolved: workspaceTarget
    });
    if (mappings.length >= MAX_HELPER_IMPORT_HINTS) {
      break;
    }
  }
  return mappings;
}

function extractRelativeImportSpecifiers(content: string): string[] {
  if (!content) {
    return [];
  }
  const specifiers = new Set<string>();
  const importRegex = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gi;
  const exportRegex = /export\s+(?:{[\s\S]*?}|\*)\s+from\s+['"]([^'"]+)['"]/gi;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    const spec = match[1]?.trim();
    if (spec && spec.startsWith('.')) {
      specifiers.add(spec);
    }
  }
  while ((match = exportRegex.exec(content)) !== null) {
    const spec = match[1]?.trim();
    if (spec && spec.startsWith('.')) {
      specifiers.add(spec);
    }
  }
  return Array.from(specifiers);
}

function inferProjectSourceRoot(pathValue?: string): string | undefined {
  if (!pathValue) {
    return undefined;
  }
  const normalized = pathValue.replace(/\\/g, '/');
  const srcIndex = normalized.indexOf('/src/');
  if (srcIndex !== -1) {
    return `${normalized.slice(0, srcIndex + 5)}`;
  }
  if (normalized.startsWith('src/')) {
    return 'src/';
  }
  const segments = normalized.split('/');
  if (segments.length >= 2) {
    return `${segments[0]}/${segments[1]}/`;
  }
  if (segments.length === 1) {
    return `${segments[0]}/`;
  }
  return undefined;
}

function buildHelperUsageHint(state: HelperVerificationState, callerPath: string): HelperUsageHint | undefined {
  if (!state.path) {
    return undefined;
  }
  const importPath = buildRelativeImportPath(callerPath, state.path);
  const defaultName = state.exports?.defaultName ?? deriveHelperNameFromPath(state.path);
  const namedExports = (state.exports?.named ?? []).filter(
    (name) => !state.exports?.defaultName || name !== state.exports.defaultName
  );
  let importStatement: string;
  if (state.exports?.defaultName) {
    importStatement = `import ${state.exports.defaultName} from '${importPath}';`;
  } else if (namedExports.length > 0) {
    importStatement = `import { ${namedExports.join(', ')} } from '${importPath}';`;
  } else {
    importStatement = `import ${defaultName} from '${importPath}';`;
  }
  const description = namedExports.length
    ? `Provides named exports: ${namedExports.join(', ')}.`
    : `Default export: ${state.exports?.defaultName ?? defaultName}.`;
  return {
    path: state.path,
    importStatement,
    description,
    snippet: state.snippet
  };
}

function buildRelativeImportPath(fromPath: string, toPath: string): string {
  const fromDir = path.dirname(fromPath);
  const relative = path.relative(fromDir, toPath).replace(/\\/g, '/');
  const trimmed = relative.replace(/\.[^.]+$/, '');
  if (!trimmed.startsWith('.')) {
    return `./${trimmed}`;
  }
  return trimmed || './';
}

function deriveHelperNameFromPath(helperPath: string): string {
  const fileName = helperPath.split(/[\\/]/).pop() ?? 'Helper';
  const base = fileName.replace(/\.[^.]+$/, '');
  return base
    .split(/[-_\s]/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('') || 'HelperComponent';
}

function storeHelperImportHints(helperPath: string, mappings: HelperImportMapping[], deps: HelperManagerDeps): void {
  if (!helperPath || !mappings.length) {
    return;
  }
  const key = normalizeHelperImportKey(helperPath, deps);
  if (!key) {
    return;
  }
  deps.setContextValue(`${HELPER_IMPORT_HINT_STORE}.${key}`, mappings);
}

function normalizeHelperImportKey(helperPath: string, deps: HelperManagerDeps): string | undefined {
  const normalized = deps.normalizeRelativePath(helperPath) ?? helperPath;
  if (!normalized) {
    return undefined;
  }
  return normalized.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function buildRelativeImportSpecifier(fromDir: string, targetPath: string): string | undefined {
  if (!fromDir) {
    return undefined;
  }
  const relative = path.posix.relative(fromDir, targetPath).replace(/\\/g, '/');
  if (!relative || relative === '.') {
    return './';
  }
  return relative.startsWith('.') ? relative : `./${relative}`;
}

interface ImportBinding {
  source: string;
  defaultName?: string;
  named: string[];
  namespace?: string;
}

function buildCallerPreservationHints(callerPath: string, deps: HelperManagerDeps): string[] {
  const callerContent = deps.getContextValue<string>('focus.primary.content');
  if (!callerContent || callerContent.trim().length === 0) {
    return [];
  }
  const bindings = parseImportBindings(callerContent);
  const relativeHelpers = bindings.filter((entry) => entry.source.startsWith('.'));
  const hints: string[] = [];
  if (relativeHelpers.length > 0) {
    const lines = ['Preserve existing helper imports from the caller instead of replacing them with new service calls:'];
    relativeHelpers.forEach((entry) => {
      if (entry.defaultName) {
        lines.push(`- default ${entry.defaultName} from '${entry.source}'`);
      }
      if (entry.named.length > 0) {
        lines.push(`- { ${entry.named.join(', ')} } from '${entry.source}'`);
      }
      if (entry.namespace) {
        lines.push(`- * as ${entry.namespace} from '${entry.source}'`);
      }
    });
    hints.push(lines.join('\n'));
  }
  const serviceImports = bindings.filter(
    (entry) => entry.defaultName && /\/services\//.test(entry.source)
  );
  serviceImports.forEach((entry) => {
    if (!entry.defaultName) {
      return;
    }
    const methods = extractMemberAccesses(callerContent, entry.defaultName);
    if (methods.length === 0) {
      return;
    }
    hints.push(
      `Only use existing ${entry.defaultName} methods already present in the caller: ${methods.join(', ')}. Do not invent new methods.`
    );
  });
  return hints;
}

function parseImportBindings(content: string): ImportBinding[] {
  if (!content) {
    return [];
  }
  const bindings: ImportBinding[] = [];
  const importRegex = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gi;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    const clause = match[1]?.trim();
    const source = match[2]?.trim();
    if (!clause || !source) {
      continue;
    }
    const parsed = parseImportClause(clause);
    bindings.push({
      source,
      defaultName: parsed.defaultName,
      named: parsed.named,
      namespace: parsed.namespace
    });
  }
  return bindings;
}

function parseImportClause(clause: string): { defaultName?: string; named: string[]; namespace?: string } {
  const cleaned = clause.replace(/^type\s+/, '').trim();
  const result = { defaultName: undefined as string | undefined, named: [] as string[], namespace: undefined as string | undefined };
  if (cleaned.startsWith('{')) {
    result.named = parseNamedBindings(cleaned);
    return result;
  }
  if (cleaned.startsWith('*')) {
    const nsMatch = cleaned.match(/\*\s+as\s+([A-Za-z0-9_$]+)/);
    if (nsMatch?.[1]) {
      result.namespace = nsMatch[1];
    }
    return result;
  }
  const braceIndex = cleaned.indexOf('{');
  if (braceIndex !== -1) {
    result.defaultName = cleaned.slice(0, braceIndex).replace(/,\s*$/, '').trim() || undefined;
    const namedPart = cleaned.slice(braceIndex);
    result.named = parseNamedBindings(namedPart);
    return result;
  }
  result.defaultName = cleaned || undefined;
  return result;
}

function parseNamedBindings(namedPart: string): string[] {
  const inner = namedPart.replace(/[{}]/g, '');
  return inner
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^type\s+/, '').split(/\s+as\s+/i)[0].trim())
    .filter(Boolean);
}

function extractMemberAccesses(content: string, identifier: string): string[] {
  if (!content || !identifier) {
    return [];
  }
  const pattern = new RegExp(`\\b${escapeRegex(identifier)}\\.([A-Za-z0-9_$]+)\\b`, 'g');
  const methods = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match[1]) {
      methods.add(match[1]);
    }
  }
  return Array.from(methods).slice(0, 12);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const isBrowser = typeof window !== 'undefined';

type PathModule = typeof import('path');
type FsPromises = typeof import('fs').promises;

const safeRandomId = (): string => {
  const globalCrypto = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto : undefined;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  return `uuid-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
};

async function getNodeDeps(): Promise<{ path: PathModule; fs: FsPromises }> {
  if (isBrowser) {
    throw new Error('TypeCheckRunner is unavailable in browser hosts.');
  }
  const [pathMod, fsMod] = await Promise.all([import('path'), import('fs')]);
  return { path: pathMod, fs: fsMod.promises };
}
let path: PathModule = null as unknown as PathModule;
import type { PythonResponse, TypeScriptDiagnostic } from '../internalTypes';
import { parseCompilerOutput, type Diagnostic } from './diagnostics';

export interface TypeCheckRunnerDeps {
  runPythonCommand(payload: { command: string; cwd: string; allowFailure?: boolean }): Promise<PythonResponse>;
  getProjectRoot(): string | undefined;
  getWorkspaceRoot(): string;
  normalizeRelativePath(value: string): string | undefined;
  getBaselineDiagnostics?(): readonly TypeScriptDiagnostic[] | undefined;
}

export interface TypeCheckRunResult {
  ok: boolean;
  output?: string;
  diagnostics?: Diagnostic[];
  ignoredDiagnostics?: Diagnostic[];
  touchedFiles?: string[];
  rawOutput?: string;
  note?: string;
  finalNotes?: string[];
  finalStatus?: 'complete' | 'best-effort';
}

export interface TypeCheckRunner {
  runProjectTypeCheck(options?: {
    cwd?: string;
    files?: string[];
    validateOnlyThesePaths?: string[];
  }): Promise<TypeCheckRunResult>;
}

export function createTypeCheckRunner(deps: TypeCheckRunnerDeps): TypeCheckRunner {
  async function runProjectTypeCheck(options?: {
    cwd?: string;
    files?: string[];
    validateOnlyThesePaths?: string[];
  }): Promise<TypeCheckRunResult> {
    if (isBrowser) {
      return { ok: true, note: 'Type check skipped in browser host.' };
    }
    if (!path) {
      ({ path } = await getNodeDeps());
    }
    let scopedConfig: { path: string; cleanup: () => Promise<void> } | undefined;
    try {
      const root = options?.cwd ?? deps.getProjectRoot() ?? deps.getWorkspaceRoot();
      const compileTargets = normalizeInputPaths(options?.files, root, deps.normalizeRelativePath);
      const validationTargets = normalizeInputPaths(options?.validateOnlyThesePaths, root, deps.normalizeRelativePath);
      const touchedFiles = validationTargets.length > 0 ? validationTargets : compileTargets;
      const tsconfig = await resolveTypeScriptConfig(root);
      scopedConfig = tsconfig && compileTargets.length > 0 ? await createScopedTsConfig(tsconfig, root, compileTargets) : undefined;
      const projectArgument = scopedConfig?.path ?? tsconfig;
      const commandParts = ['npx', 'tsc', '--noEmit', '--pretty', 'false'];
      if (projectArgument) {
        commandParts.push('--project', projectArgument);
      }
      if (!projectArgument && compileTargets.length > 0) {
        commandParts.push(...compileTargets);
      }
      const command = commandParts.map((segment) => quote(segment)).join(' ');
      const response = await deps.runPythonCommand({
        command,
        cwd: root,
        allowFailure: true
      });
      const ok = response.status === 'SUCCESS' || (typeof response.code === 'number' && response.code === 0);
      const combinedOutput = buildCombinedOutput(response);
      if (ok) {
        return {
          ok: true,
          touchedFiles,
          rawOutput: combinedOutput
        };
      }
      const diagnostics = parseCompilerOutput(combinedOutput).map((diagnostic) => ({
        ...diagnostic,
        file: normalizeDiagnosticFile(diagnostic.file, root, deps.normalizeRelativePath)
      }));
      const partitioned = partitionDiagnostics(diagnostics, touchedFiles);
      const baselineLookup = buildBaselineLookup(
        deps.getBaselineDiagnostics?.(),
        root,
        deps.normalizeRelativePath
      );
      const baselinePartitioned = partitionPreExistingDiagnostics(
        partitioned.blocking,
        baselineLookup
      );
      const ignoredDiagnostics = [...partitioned.ignored, ...baselinePartitioned.preExisting];
      const noteParts = [
        buildIgnoredNote(partitioned.ignored),
        buildPreExistingNote(baselinePartitioned.preExisting)
      ].filter((value) => value.length > 0);
      const combinedNote = noteParts.join(' ').trim() || undefined;
      if (baselinePartitioned.blocking.length === 0 && ignoredDiagnostics.length > 0 && touchedFiles.length > 0) {
        return {
          ok: true,
          diagnostics: [],
          ignoredDiagnostics,
          touchedFiles,
          rawOutput: combinedOutput,
          note: combinedNote
        };
      }
      const blockingOutput = baselinePartitioned.blocking.length > 0
        ? formatDiagnosticOutput(baselinePartitioned.blocking)
        : combinedOutput;
      return {
        ok: baselinePartitioned.blocking.length === 0,
        output: blockingOutput || 'Type check failed.',
        diagnostics: baselinePartitioned.blocking,
        ignoredDiagnostics,
        touchedFiles,
        rawOutput: combinedOutput,
        note: combinedNote
      };
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    } finally {
      await scopedConfig?.cleanup();
    }
  }

  return {
    runProjectTypeCheck
  };
}

const TSCONFIG_CANDIDATES = ['tsconfig.json', 'tsconfig.base.json', 'tsconfig.build.json', 'tsconfig.prod.json', 'jsconfig.json'];

async function resolveTypeScriptConfig(root: string): Promise<string | undefined> {
  const { path } = await getNodeDeps();
  for (const candidate of TSCONFIG_CANDIDATES) {
    const absolute = path.join(root, candidate);
    if (await pathExists(absolute)) {
      return absolute;
    }
  }
  return undefined;
}

async function pathExists(target: string): Promise<boolean> {
  const { fs } = await getNodeDeps();
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function createScopedTsConfig(baseConfig: string, root: string, files: string[]): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const { fs, path } = await getNodeDeps();
  const tempDir = path.join(root, '.bandit', 'tmp');
  await fs.mkdir(tempDir, { recursive: true });
  const scopedPath = path.join(tempDir, `tsconfig-helper-${safeRandomId()}.json`);
  const configDir = path.dirname(scopedPath);
  const relativeBase = normalizeForConfig(path.relative(configDir, baseConfig));
  const relativeFiles = Array.from(
    new Set(
      files.map((file) => normalizeForConfig(path.relative(configDir, path.resolve(root, file)))).filter((value) => value.length > 0)
    )
  );
  const scopedConfig = {
    extends: relativeBase.startsWith('.') ? relativeBase : `./${relativeBase}`,
    files: relativeFiles,
    include: []
  };
  await fs.writeFile(scopedPath, JSON.stringify(scopedConfig, null, 2), 'utf8');
  return {
    path: scopedPath,
    cleanup: async () => {
      await fs.unlink(scopedPath).catch(() => undefined);
    }
  };
}

function normalizeForConfig(value: string): string {
  return value.replace(/\\/g, '/');
}

function quote(segment: string): string {
  if (segment.includes(' ')) {
    const safe = segment.replace(/"/g, '\\"');
    return `"${safe}"`;
  }
  return segment;
}

function buildCombinedOutput(response: PythonResponse): string {
  const outputSegments = [response.output, response.error]
    .flat()
    .filter((segment): segment is string => typeof segment === 'string' && segment.trim().length > 0);
  return outputSegments.join('\n');
}

function normalizeInputPaths(values: string[] | undefined, root: string, normalizeRelativePath: (value: string) => string | undefined): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }
  const normalized = values
    .map((value) => normalizeDiagnosticFile(value, root, normalizeRelativePath))
    .filter((value): value is string => Boolean(value));
  return Array.from(new Set(normalized));
}

function normalizeDiagnosticFile(file: string, root: string, normalizeRelativePath: (value: string) => string | undefined): string {
  if (!file) {
    return '';
  }
  const trimmed = file.replace(/\\/g, '/');
  const normalized = normalizeRelativePath(trimmed);
  if (normalized) {
    return normalized;
  }
  const absolute = path.isAbsolute(trimmed) ? trimmed : path.join(root, trimmed);
  const relative = path.relative(root, absolute).replace(/\\/g, '/');
  return relative || trimmed;
}

function partitionDiagnostics(diagnostics: Diagnostic[], touchedFiles: string[]): {
  blocking: Diagnostic[];
  ignored: Diagnostic[];
} {
  if (!diagnostics.length) {
    return { blocking: [], ignored: [] };
  }
  const touchedSet = new Set(touchedFiles.map((file) => file.toLowerCase()));
  const allowAll = touchedSet.size === 0;
  const blocking: Diagnostic[] = [];
  const ignored: Diagnostic[] = [];
  diagnostics.forEach((diagnostic) => {
    const normalizedFile = diagnostic.file?.toLowerCase() ?? '';
    const isAmbient =
      normalizedFile.endsWith('.d.ts')
      || normalizedFile.includes('/node_modules/')
      || normalizedFile.includes('\\node_modules\\');
    if (isAmbient || !normalizedFile) {
      diagnostic.isAmbientError = true;
      diagnostic.isTouchedFileError = false;
      diagnostic.isExternalError = true;
      ignored.push(diagnostic);
      return;
    }
    const isTouched = allowAll || touchedSet.has(normalizedFile);
    if (isTouched) {
      diagnostic.isTouchedFileError = true;
      diagnostic.isExternalError = false;
      diagnostic.isAmbientError = false;
      blocking.push(diagnostic);
      return;
    }
    diagnostic.isTouchedFileError = false;
    diagnostic.isExternalError = true;
    diagnostic.isAmbientError = false;
    ignored.push(diagnostic);
  });
  return { blocking, ignored };
}

type BaselineLookup = Map<string, Map<string, number>>;

function buildBaselineLookup(
  diagnostics: readonly TypeScriptDiagnostic[] | undefined,
  root: string,
  normalizeRelativePath: (value: string) => string | undefined
): BaselineLookup {
  const lookup: BaselineLookup = new Map();
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    return lookup;
  }
  diagnostics.forEach((diagnostic) => {
    const normalizedFile = normalizeDiagnosticFile(diagnostic.file, root, normalizeRelativePath).toLowerCase();
    if (!normalizedFile) {
      return;
    }
    const key = createComparableDiagnosticKey(diagnostic.message, diagnostic.code);
    if (!lookup.has(normalizedFile)) {
      lookup.set(normalizedFile, new Map<string, number>());
    }
    const fileLookup = lookup.get(normalizedFile);
    if (!fileLookup) {
      return;
    }
    fileLookup.set(key, (fileLookup.get(key) ?? 0) + 1);
  });
  return lookup;
}

function partitionPreExistingDiagnostics(
  diagnostics: Diagnostic[],
  baselineLookup: BaselineLookup
): { blocking: Diagnostic[]; preExisting: Diagnostic[] } {
  if (!diagnostics.length || baselineLookup.size === 0) {
    return { blocking: diagnostics, preExisting: [] };
  }
  const consumedByFile = new Map<string, Map<string, number>>();
  const blocking: Diagnostic[] = [];
  const preExisting: Diagnostic[] = [];
  diagnostics.forEach((diagnostic) => {
    const fileKey = diagnostic.file?.toLowerCase() ?? '';
    const baselineForFile = baselineLookup.get(fileKey);
    if (!baselineForFile) {
      blocking.push(diagnostic);
      return;
    }
    const comparableKey = createComparableDiagnosticKey(diagnostic.message);
    const baselineCount = baselineForFile.get(comparableKey) ?? 0;
    if (baselineCount <= 0) {
      blocking.push(diagnostic);
      return;
    }
    if (!consumedByFile.has(fileKey)) {
      consumedByFile.set(fileKey, new Map<string, number>());
    }
    const consumedForFile = consumedByFile.get(fileKey);
    if (!consumedForFile) {
      blocking.push(diagnostic);
      return;
    }
    const usedCount = consumedForFile.get(comparableKey) ?? 0;
    if (usedCount < baselineCount) {
      consumedForFile.set(comparableKey, usedCount + 1);
      preExisting.push(diagnostic);
      return;
    }
    blocking.push(diagnostic);
  });
  return { blocking, preExisting };
}

function createComparableDiagnosticKey(message: string, codeHint?: string): string {
  const compactMessage = message.replace(/\s+/g, ' ').trim();
  const codeMatch = compactMessage.match(/\bTS\d+\b/i);
  const code = (codeHint ?? codeMatch?.[0] ?? '').toUpperCase();
  const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withoutCodePrefix = escapedCode
    ? compactMessage
      .replace(new RegExp(`^error\\s+${escapedCode}\\s*:\\s*`, 'i'), '')
      .replace(new RegExp(`^${escapedCode}\\s*:\\s*`, 'i'), '')
    : compactMessage;
  const normalizedMessage = withoutCodePrefix.replace(/\s+/g, ' ').trim().toLowerCase();
  return `${code}:${normalizedMessage}`;
}

function formatDiagnosticOutput(diagnostics: Diagnostic[]): string {
  if (!diagnostics.length) {
    return '';
  }
  const lines = diagnostics.slice(0, 10).map((diagnostic) => {
    const location = diagnostic.line > 0 ? `:${diagnostic.line}` : '';
    return `${diagnostic.file}${location} — ${diagnostic.message}`;
  });
  if (diagnostics.length > 10) {
    lines.push(`…and ${diagnostics.length - 10} more issue(s).`);
  }
  return lines.join('\n');
}

function buildIgnoredNote(diagnostics: Diagnostic[]): string {
  if (!diagnostics.length) {
    return '';
  }
  const files = Array.from(new Set(diagnostics.map((diagnostic) => diagnostic.file))).slice(0, 3);
  const suffix = diagnostics.length > files.length ? ` (+${diagnostics.length - files.length} more)` : '';
  return `Ignored ${diagnostics.length} unrelated TypeScript diagnostic${diagnostics.length === 1 ? '' : 's'} (${files.join(', ')})${suffix}.`;
}

function buildPreExistingNote(diagnostics: Diagnostic[]): string {
  if (!diagnostics.length) {
    return '';
  }
  const files = Array.from(new Set(diagnostics.map((diagnostic) => diagnostic.file))).slice(0, 3);
  const suffix = diagnostics.length > files.length ? ` (+${diagnostics.length - files.length} more)` : '';
  return `Ignored ${diagnostics.length} pre-existing TypeScript diagnostic${diagnostics.length === 1 ? '' : 's'} in touched files (${files.join(', ')})${suffix}.`;
}

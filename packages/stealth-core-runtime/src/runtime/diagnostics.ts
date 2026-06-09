import * as path from 'path';
import type { PlanStep } from '../internalTypes';
import type {
  ValidationOutcome,
  TypeScriptValidationContext,
  ITelemetry,
  IDiffManager,
  IPythonEnv,
  TypeScriptValidator,
  TypeScriptDiagnostic
} from '../internalTypes';
import type { WorkspacePackageManager } from '../internalTypes';
import type { AutoHealer } from './autoHealer';
import type { EventBus } from '../internalTypes';

export type DiagnosticType = 'syntax' | 'type' | 'missingSymbol' | 'unknown';

export interface Diagnostic {
  file: string;
  line: number;
  message: string;
  type: DiagnosticType;
  isTouchedFileError?: boolean;
  isExternalError?: boolean;
  isAmbientError?: boolean;
}

export interface DiagnosticEventPayload {
  goal?: string;
  source?: string;
  diagnostics: Diagnostic[];
  touchedFiles?: string[];
  helperStep?: boolean;
  rawOutput?: string;
}

export function parseCompilerOutput(log: string): Diagnostic[] {
  if (!log || typeof log !== 'string') {
    return [];
  }
  const diagnostics: Diagnostic[] = [];
  const lines = log.split(/\r?\n/);
  let pending: Diagnostic | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      pending = undefined;
      continue;
    }
    const parsed = parseDiagnosticLine(line);
    if (parsed) {
      diagnostics.push(parsed);
      pending = parsed;
      continue;
    }
    if (pending && /^\s+/.test(rawLine)) {
      pending.message = `${pending.message}\n${line.trim()}`;
    }
  }
  return diagnostics;
}

export interface DiagnosticsEngine {
  recordWriteContext(paths: (string | undefined)[], helperStep: boolean): void;
  clearPendingWriteContext(): void;
  runValidation(step: PlanStep, goal: string): Promise<ValidationOutcome>;
}

export interface DiagnosticsEngineDeps {
  telemetry: ITelemetry;
  typescriptValidator: TypeScriptValidator;
  workspacePackageManager: WorkspacePackageManager;
  autoHealer: AutoHealer;
  eventBus: EventBus;
  pythonEnv: IPythonEnv;
  diffManager: Pick<IDiffManager, 'getPendingDiff'>;
  isDryRun(): boolean;
  shouldSkipValidations(): boolean;
  getWorkspaceRoot(): string;
  getRunOptions(): { previewOnly?: boolean };
  getWriteTargetPath(step: PlanStep): string | undefined;
  normalizeRelativePath(value: string): string | undefined;
  pathExists(absPath: string): Promise<boolean>;
  getWorkspaceFileIndex(): string[];
  loadWorkspaceFileIndex(force?: boolean): Promise<string[]>;
  spawnValidationProcess(command: string, args: string[], cwd: string): Promise<ValidationOutcome>;
  getCommandName(base: string): string;
}

export function createDiagnosticsEngine(deps: DiagnosticsEngineDeps): DiagnosticsEngine {
  let pendingWriteContext: { helperStep: boolean; paths: string[] } | undefined;
  const validationTimestamps: Record<string, number> = {};
  const validationThrottleMs = 4000;

  function recordWriteContext(paths: (string | undefined)[], helperStep: boolean): void {
    const changed = getChangedPaths(paths);
    if (changed.length === 0) {
      pendingWriteContext = undefined;
      return;
    }
    pendingWriteContext = { helperStep, paths: changed };
  }

  function clearPendingWriteContext(): void {
    pendingWriteContext = undefined;
  }

  function consumeWriteContext(): { helperStep: boolean; paths: string[] } | undefined {
    const context = pendingWriteContext;
    pendingWriteContext = undefined;
    return context;
  }

  async function runValidation(step: PlanStep, goal: string): Promise<ValidationOutcome> {
    const previewOnly = deps.getRunOptions().previewOnly === true;
    if (previewOnly) {
      consumeWriteContext();
      return { ok: true };
    }
    if (step.action.type !== 'python' || step.action.name !== 'writeFile') {
      consumeWriteContext();
      return { ok: true };
    }

    const writeContext = consumeWriteContext();
    const relativePath = deps.getWriteTargetPath(step) ?? writeContext?.paths?.[0];
    if (!relativePath) {
      return { ok: true };
    }

    const touchedFiles = writeContext?.paths ?? [relativePath];
    const helperStep = Boolean(writeContext?.helperStep);

    if (isTypeScriptLike(relativePath)) {
      const validationContext: TypeScriptValidationContext = {
        touchedFiles,
        helperStep
      };
      const result = await deps.typescriptValidator.runValidation(validationContext);
      if (!result.ok && result.kind === 'typescript') {
        await deps.eventBus.emit('diagnostics:typescript', {
          stepId: step.id,
          goal,
          diagnostics: result.diagnostics,
          touchedFiles,
          helperStep
        });
        const normalizedDiagnostics = mapTypeScriptDiagnostics(result.diagnostics ?? []);
        if (normalizedDiagnostics.length > 0) {
          const taggedDiagnostics = annotateDiagnosticsWithTouchedContext(
            normalizedDiagnostics,
            touchedFiles,
            deps.normalizeRelativePath
          );
          await deps.eventBus.emit('diagnostics:errors', {
            goal,
            source: 'typescript',
            diagnostics: taggedDiagnostics,
            touchedFiles,
            helperStep
          } satisfies DiagnosticEventPayload);
        }
        return deps.autoHealer.autoHealTypeScriptErrors(goal, validationContext, result);
      }
      if (!result.ok) {
        return result;
      }
      const packageValidation = await ensurePackageValidation(goal, touchedFiles, helperStep);
      if (!packageValidation.ok) {
        return packageValidation;
      }
      return { ok: true };
    }

    if (isPythonLike(relativePath)) {
      const packageValidation = await ensurePackageValidation(goal, touchedFiles, helperStep);
      if (!packageValidation.ok) {
        return packageValidation;
      }
      return runPythonValidation(relativePath);
    }

    if (isDotnetLike(relativePath)) {
      const packageValidation = await ensurePackageValidation(goal, touchedFiles, helperStep);
      if (!packageValidation.ok) {
        return packageValidation;
      }
      return runDotnetValidation();
    }

    const packageValidation = await ensurePackageValidation(goal, touchedFiles, helperStep);
    if (!packageValidation.ok) {
      return packageValidation;
    }
    return { ok: true };
  }

  async function ensurePackageValidation(
    goal: string,
    touchedFiles: string[],
    helperStep: boolean
  ): Promise<ValidationOutcome> {
    const previewOnly = deps.getRunOptions().previewOnly === true;
    if (deps.shouldSkipValidations()) {
      await deps.telemetry.log({
        level: 'info',
        message: 'Developer override enabled — skipping package validation.'
      });
      return { ok: true };
    }
    if (previewOnly || touchedFiles.length === 0) {
      return { ok: true };
    }
    const workspaceRoot = deps.getWorkspaceRoot();
    const packageValidation = await deps.workspacePackageManager.runLintValidation(touchedFiles, {
      previewOnly,
      workspaceRoot
    });
    if (packageValidation.ok || deps.isDryRun()) {
      return packageValidation;
    }
    await deps.eventBus.emit('diagnostics:package', {
      goal,
      diagnostics: packageValidation.diagnostics,
      touchedFiles,
      helperStep
    });
    if (Array.isArray(packageValidation.diagnostics) && packageValidation.diagnostics.length > 0) {
      const normalizedDiagnostics = mapTypeScriptDiagnostics(packageValidation.diagnostics);
      if (normalizedDiagnostics.length > 0) {
        const taggedDiagnostics = annotateDiagnosticsWithTouchedContext(
          normalizedDiagnostics,
          touchedFiles,
          deps.normalizeRelativePath
        );
        await deps.eventBus.emit('diagnostics:errors', {
          goal,
          source: packageValidation.kind ?? 'package',
          diagnostics: taggedDiagnostics,
          touchedFiles,
          helperStep
        } satisfies DiagnosticEventPayload);
      }
    }
    return deps.autoHealer.autoRepairValidationErrors(goal, touchedFiles, helperStep, packageValidation);
  }

  function getChangedPaths(paths: (string | undefined)[]): string[] {
    const normalized = paths
      .map((value) => (typeof value === 'string' ? deps.normalizeRelativePath(value) ?? value : undefined))
      .filter((value): value is string => Boolean(value));
    const unique = Array.from(new Set(normalized));
    return unique.filter((candidate) => {
      const pending = deps.diffManager.getPendingDiff(candidate);
      if (!pending) {
        return true;
      }
      return pending.changed !== false;
    });
  }

  function isTypeScriptLike(filePath: string): boolean {
    return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(filePath);
  }

  function isPythonLike(filePath: string): boolean {
    return /\.pyw?$/i.test(filePath);
  }

  function isDotnetLike(filePath: string): boolean {
    return /\.(cs|csproj|sln)$/i.test(filePath);
  }

  function isValidationThrottled(kind: string): boolean {
    const lastRun = validationTimestamps[kind] ?? 0;
    return Date.now() - lastRun < validationThrottleMs;
  }

  function markValidationRun(kind: string): void {
    validationTimestamps[kind] = Date.now();
  }

  async function runPythonValidation(relativePath: string): Promise<ValidationOutcome> {
    const python = await deps.pythonEnv.ensure();
    if (!python.ok || !python.command) {
      return { ok: true };
    }
    if (isValidationThrottled('python')) {
      return { ok: true };
    }
    const workspaceRoot = deps.getWorkspaceRoot();
    const targetPath = path.join(workspaceRoot, relativePath);
    if (!(await deps.pathExists(targetPath))) {
      return { ok: true };
    }
    const args = ['-m', 'py_compile', targetPath];
    try {
      const result = await deps.spawnValidationProcess(python.command, args, workspaceRoot);
      if (result.ok) {
        markValidationRun('python');
      }
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function runDotnetValidation(): Promise<ValidationOutcome> {
    const target = await findDotnetProjectFile();
    if (!target) {
      return { ok: true };
    }
    if (isValidationThrottled('dotnet')) {
      return { ok: true };
    }
    const workspaceRoot = deps.getWorkspaceRoot();
    const args = ['build', target, '--nologo'];
    try {
      const result = await deps.spawnValidationProcess(deps.getCommandName('dotnet'), args, workspaceRoot);
      if (result.ok) {
        markValidationRun('dotnet');
      }
      return result;
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno?.code === 'ENOENT') {
        return { ok: true };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function findDotnetProjectFile(): Promise<string | undefined> {
    const workspaceFiles = deps.getWorkspaceFileIndex();
    if (!workspaceFiles.length) {
      await deps.loadWorkspaceFileIndex(true).catch(() => undefined);
    }
    const files = deps.getWorkspaceFileIndex();
    const solutions = files.filter((file) => file.endsWith('.sln'));
    if (solutions.length > 0) {
      return solutions[0];
    }
    const projects = files.filter((file) => file.endsWith('.csproj'));
    return projects[0];
  }

  return {
    recordWriteContext,
    clearPendingWriteContext,
    runValidation
  };
}
function annotateDiagnosticsWithTouchedContext(
  diagnostics: Diagnostic[],
  touchedFiles: string[] | undefined,
  normalizeRelativePath: (value: string) => string | undefined
): Diagnostic[] {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    return diagnostics;
  }
  const touchedSet = new Set(
    (Array.isArray(touchedFiles) ? touchedFiles : [])
      .map((file) => normalizePathForComparison(file, normalizeRelativePath))
      .filter((value): value is string => Boolean(value))
  );
  diagnostics.forEach((diagnostic) => {
    const normalizedFile = normalizePathForComparison(diagnostic.file, normalizeRelativePath);
    const isAmbient = normalizedFile ? isAmbientDiagnosticFile(normalizedFile) : false;
    diagnostic.isAmbientError = isAmbient;
    if (!normalizedFile || touchedSet.size === 0) {
      diagnostic.isTouchedFileError = isAmbient ? false : undefined;
      diagnostic.isExternalError = isAmbient ? true : undefined;
      return;
    }
    const isTouched = touchedSet.has(normalizedFile);
    diagnostic.isTouchedFileError = Boolean(isTouched && !isAmbient);
    diagnostic.isExternalError = !diagnostic.isTouchedFileError;
  });
  return diagnostics;
}

function normalizePathForComparison(
  value: string | undefined,
  normalizeRelativePath: (value: string) => string | undefined
): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = normalizeRelativePath(value) ?? value;
  return normalized.replace(/\\/g, '/').toLowerCase();
}

function isAmbientDiagnosticFile(value: string): boolean {
  return value.endsWith('.d.ts') || value.includes('/node_modules/') || value.includes('node_modules\\');
}

function parseDiagnosticLine(line: string): Diagnostic | undefined {
  const parenPattern = /^(?<file>[^:(]+)\((?<line>\d+)(?:,(?<column>\d+))?\):\s*(?<rest>.+)$/;
  const colonPattern = /^(?<file>[^:]+):(?<line>\d+):(?<column>\d+):\s*(?<rest>.+)$/;
  const webpackPattern = /^(?<level>ERROR|WARNING) in (?<file>.+)$/i;

  const parenMatch = line.match(parenPattern);
  const colonMatch = !parenMatch ? line.match(colonPattern) : undefined;
  if (parenMatch || colonMatch) {
    const groups = (parenMatch ?? colonMatch)!.groups ?? {};
    const file = normalizeDiagnosticFile(groups.file);
    const lineNumber = Number.parseInt(groups.line ?? '0', 10) || 0;
    const message = (groups.rest ?? '').trim();
    if (!file || !message) {
      return undefined;
    }
    return {
      file,
      line: lineNumber,
      message,
      type: inferDiagnosticTypeFromMessage(message)
    };
  }

  const webpackMatch = line.match(webpackPattern);
  if (webpackMatch?.groups?.file) {
    const file = normalizeDiagnosticFile(webpackMatch.groups.file.trim());
    if (!file) {
      return undefined;
    }
    const rest = line.replace(webpackMatch[0], '').trim();
    return {
      file,
      line: 0,
      message: rest || 'Compiler reported an error.',
      type: inferDiagnosticTypeFromMessage(rest)
    };
  }
  return undefined;
}

function normalizeDiagnosticFile(file: string | undefined): string {
  if (!file) {
    return '';
  }
  return file.trim().replace(/\\/g, '/');
}

function inferDiagnosticTypeFromMessage(message: string): DiagnosticType {
  const normalized = message.toLowerCase();
  if (normalized.includes('cannot find name') || normalized.includes('is not defined')) {
    return 'missingSymbol';
  }
  if (normalized.includes('type') && normalized.includes('assignable')) {
    return 'type';
  }
  if (
    normalized.includes('expected')
    && (normalized.includes('identifier') || normalized.includes('token') || normalized.includes('syntax'))
  ) {
    return 'syntax';
  }
  return 'unknown';
}

function mapTypeScriptDiagnostics(diagnostics: TypeScriptDiagnostic[]): Diagnostic[] {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    return [];
  }
  return diagnostics.map((diagnostic) => ({
    file: diagnostic.file,
    line: diagnostic.line,
    message: diagnostic.message,
    type: inferDiagnosticTypeFromMessage(diagnostic.message)
  }));
}

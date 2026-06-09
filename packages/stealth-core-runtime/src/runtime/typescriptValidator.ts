import type {
  ITelemetry,
  TypeScriptDiagnostic,
  TypeScriptValidationContext,
  TypeScriptValidator,
  ValidationOutcome
} from '../internalTypes';

const isBrowser = typeof window !== 'undefined';
const hashString = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(16, '0');
};

export interface TypeScriptValidatorDeps {
  telemetry: ITelemetry;
  shouldSkipValidations(): boolean;
  getWorkspaceRoot(): string;
  findTsConfigFile(): Promise<string | undefined>;
  buildValidationCommands(args: string[]): Promise<Array<{ command: string; args: string[] }>>;
  spawnValidationProcess(
    command: string,
    args: string[],
    cwd: string
  ): Promise<ValidationOutcome>;
  isValidationThrottled(kind: string): boolean;
  markValidationRun(kind: string): void;
  normalizeRelativePath(value: string): string | undefined;
  mapDiagnosticsToWorkspace(diagnostics: TypeScriptDiagnostic[]): TypeScriptDiagnostic[];
}

export function createTypeScriptValidator(deps: TypeScriptValidatorDeps): TypeScriptValidator {
  // Maps file → (baselineKey → count). BaselineKey is code:message (no line/col) so that
  // line-number shifts caused by writes don't invalidate pre-existing error matches.
  let baselineErrors: Map<string, Map<string, number>> | undefined;
  let baselineConfig: string | undefined;
  let baselinePromise: Promise<void> | undefined;
  let baselineDiagnostics: TypeScriptDiagnostic[] = [];
  const rewriteHints = new Map<string, string>();

  async function captureBaseline(): Promise<void> {
    if (baselinePromise) {
      await baselinePromise.catch(() => undefined);
    }
    const tsconfig = await deps.findTsConfigFile();
    if (!tsconfig) {
      baselineErrors = new Map();
      baselineConfig = undefined;
      baselineDiagnostics = [];
      return;
    }
    const workspaceRoot = deps.getWorkspaceRoot();
    baselinePromise = (async () => {
      const baseline = await runTypeScriptCheck(tsconfig, workspaceRoot);
      baselineDiagnostics = deps.mapDiagnosticsToWorkspace(baseline.diagnostics ?? []);
      baselineErrors = groupDiagnosticsByFile(baselineDiagnostics);
      baselineConfig = tsconfig;
      if (!baseline.ok && baseline.error) {
        await deps.telemetry.log({
          message: `TypeScript baseline issues detected: ${baseline.error}`,
          level: 'warn'
        });
      }
    })();
    await baselinePromise.catch(() => undefined);
    baselinePromise = undefined;
  }

  async function runValidation(context: TypeScriptValidationContext): Promise<ValidationOutcome> {
    const tsconfig = await deps.findTsConfigFile();
    if (!tsconfig) {
      return { ok: true };
    }
    if (isBrowser) {
      return { ok: true };
    }
    const touched = normalizeTouchedFiles(context.touchedFiles);
    if (touched.length === 0) {
      return { ok: true };
    }
    if (deps.shouldSkipValidations()) {
      await deps.telemetry.log({
        level: 'info',
        message: 'Developer override enabled — skipping TypeScript validation.'
      });
      return {
        ok: true,
        diagnostics: [],
        touchedFiles: touched
      };
    }
    const workspaceRoot = deps.getWorkspaceRoot();
    await ensureBaseline(tsconfig, workspaceRoot);
    if (deps.isValidationThrottled('tsc')) {
      return { ok: true };
    }
    const check = await runTypeScriptCheck(tsconfig, workspaceRoot);
    deps.markValidationRun('tsc');
    const workspaceDiagnostics = deps.mapDiagnosticsToWorkspace(check.diagnostics ?? []);
    if (workspaceDiagnostics.length === 0) {
      clearRewriteHintsForFiles(touched);
      if (!check.ok && check.error) {
        await deps.telemetry.log({
          message: `TypeScript validation skipped: ${check.error}`,
          level: 'warn'
        });
      }
      return { ok: true };
    }
    const baseline = baselineErrors ?? new Map<string, Map<string, number>>();
    const touchedSet = new Set(touched.map((file) => file.toLowerCase()));
    const scopedDiagnostics = workspaceDiagnostics.filter((diagnostic) => {
      const normalizedFile = normalizeFilePath(diagnostic.file);
      if (!normalizedFile) {
        return false;
      }
      return touchedSet.has(normalizedFile.toLowerCase());
    });
    const ignoredDiagnostics = workspaceDiagnostics.filter((diagnostic) => !scopedDiagnostics.includes(diagnostic));
    if (scopedDiagnostics.length === 0) {
      clearRewriteHintsForFiles(touched);
      if (ignoredDiagnostics.length > 0) {
        await deps.telemetry.log({
          message: `TypeScript reported ${ignoredDiagnostics.length} diagnostic${
            ignoredDiagnostics.length === 1 ? '' : 's'
          } outside the touched files — ignoring.`,
          level: 'info'
        });
      }
      return {
        ok: true,
        diagnostics: [],
        ignoredDiagnostics,
        touchedFiles: touched
      };
    }
    // Count-based matching keyed by code+message (no line/col) so that writes that shift
    // line numbers don't cause pre-existing errors to appear as new regressions.
    const consumedByFile = new Map<string, Map<string, number>>();
    const newDiagnostics = scopedDiagnostics.filter((diagnostic) => {
      const normalizedFile = normalizeFilePath(diagnostic.file);
      if (!normalizedFile) {
        return false;
      }
      const fileKey = normalizedFile.toLowerCase();
      if (!touchedSet.has(fileKey)) {
        return false;
      }
      const baselineForFile = baseline.get(fileKey);
      if (!baselineForFile) {
        return true;
      }
      const bKey = createBaselineKey(diagnostic.code, diagnostic.message);
      const baselineCount = baselineForFile.get(bKey) ?? 0;
      if (baselineCount <= 0) {
        return true;
      }
      if (!consumedByFile.has(fileKey)) {
        consumedByFile.set(fileKey, new Map<string, number>());
      }
      const consumed = consumedByFile.get(fileKey)!;
      const usedCount = consumed.get(bKey) ?? 0;
      if (usedCount < baselineCount) {
        consumed.set(bKey, usedCount + 1);
        return false; // pre-existing — not a new regression
      }
      return true; // count exceeded baseline — genuinely new
    });
    const newSet = new Set(newDiagnostics);
    const existingDiagnostics = scopedDiagnostics.filter((diagnostic) => {
      const normalizedFile = normalizeFilePath(diagnostic.file);
      if (!normalizedFile) {
        return false;
      }
      const fileKey = normalizedFile.toLowerCase();
      if (!touchedSet.has(fileKey)) {
        return false;
      }
      return !newSet.has(diagnostic);
    });
    if (newDiagnostics.length === 0) {
      clearRewriteHintsForFiles(touched);
      return {
        ok: true,
        diagnostics: scopedDiagnostics,
        existingDiagnostics,
        ignoredDiagnostics
      };
    }
    const summary = formatTypeScriptErrorSummary(newDiagnostics);
    await deps.telemetry.log({
      message: `TypeScript validation failed:\n${summary}`,
      level: 'error'
    });
    setRewriteHintsFromDiagnostics(newDiagnostics);
    return {
      ok: false,
      error: summary,
      output: check.stdout,
      diagnostics: newDiagnostics,
      existingDiagnostics,
      ignoredDiagnostics,
      touchedFiles: touched,
      helperStep: context.helperStep,
      kind: 'typescript'
    };
  }

  async function ensureBaseline(tsconfig: string, workspaceRoot: string): Promise<void> {
    if (baselinePromise) {
      await baselinePromise.catch(() => undefined);
    }
    if (baselineErrors && baselineConfig === tsconfig) {
      return;
    }
    baselineErrors = new Map();
    baselineConfig = tsconfig;
    const baseline = await runTypeScriptCheck(tsconfig, workspaceRoot);
    baselineDiagnostics = deps.mapDiagnosticsToWorkspace(baseline.diagnostics ?? []);
    baselineErrors = groupDiagnosticsByFile(baselineDiagnostics);
    if (!baseline.ok && (!baseline.diagnostics || baseline.diagnostics.length === 0) && baseline.error) {
      await deps.telemetry.log({
        message: `TypeScript baseline check failed: ${baseline.error}`,
        level: 'warn'
      });
    }
  }

  function normalizeTouchedFiles(files: string[]): string[] {
    return files
      .map((file) => deps.normalizeRelativePath(file) ?? file)
      .filter((file): file is string => Boolean(file));
  }

  function normalizeFilePath(pathValue: string): string | undefined {
    return deps.normalizeRelativePath(pathValue) ?? pathValue;
  }

  async function runTypeScriptCheck(
    tsconfig: string,
    workspaceRoot: string
  ): Promise<{ ok: boolean; diagnostics: TypeScriptDiagnostic[]; stdout?: string; error?: string }> {
    const args = ['--noEmit', '--pretty', 'false', '--project', tsconfig];
    const candidates = await deps.buildValidationCommands(args);
    for (const candidate of candidates) {
      try {
        const result = await deps.spawnValidationProcess(candidate.command, candidate.args, workspaceRoot);
        const combinedOutput = [result.stdout, result.stderr, result.output]
          .filter((value): value is string => Boolean(value))
          .join('\n');
        const diagnostics = parseTypeScriptDiagnostics(combinedOutput);
        return {
          ok: result.ok,
          diagnostics,
          stdout: combinedOutput || result.output,
          error: result.error
        };
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno?.code === 'ENOENT') {
          continue;
        }
        return {
          ok: false,
          diagnostics: [],
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
    return { ok: true, diagnostics: [] };
  }

  function parseTypeScriptDiagnostics(output: string | undefined): TypeScriptDiagnostic[] {
    if (!output) {
      return [];
    }
    const lines = output.split(/\r?\n/);
    const diagnostics: TypeScriptDiagnostic[] = [];
    const pattern = /^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\):\s+error\s+(?<code>TS\d+):\s+(?<message>.+)$/;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const match = pattern.exec(line);
      if (!match?.groups) {
        continue;
      }
      const filePath = normalizeFilePath(match.groups.file.trim());
      if (!filePath) {
        continue;
      }
      const lineNumber = Number(match.groups.line);
      const columnNumber = Number(match.groups.column);
      const code = match.groups.code.trim();
      const message = match.groups.message.trim();
      diagnostics.push({
        file: filePath,
        line: Number.isFinite(lineNumber) ? lineNumber : 0,
        column: Number.isFinite(columnNumber) ? columnNumber : 0,
        code,
        message,
        fingerprint: createDiagnosticFingerprint(filePath, code, lineNumber, columnNumber, message)
      });
    }
    return diagnostics;
  }

  function groupDiagnosticsByFile(diagnostics: TypeScriptDiagnostic[]): Map<string, Map<string, number>> {
    const grouped = new Map<string, Map<string, number>>();
    diagnostics.forEach((diagnostic) => {
      const normalized = normalizeFilePath(diagnostic.file);
      if (!normalized) {
        return;
      }
      const key = normalized.toLowerCase();
      if (!grouped.has(key)) {
        grouped.set(key, new Map<string, number>());
      }
      const fileMap = grouped.get(key);
      if (!fileMap) {
        return;
      }
      const bKey = createBaselineKey(diagnostic.code, diagnostic.message);
      fileMap.set(bKey, (fileMap.get(bKey) ?? 0) + 1);
    });
    return grouped;
  }

  function indexDiagnosticsByFileInternal(
    diagnostics: TypeScriptDiagnostic[]
  ): Map<string, TypeScriptDiagnostic[]> {
    const grouped = new Map<string, TypeScriptDiagnostic[]>();
    diagnostics.forEach((diagnostic) => {
      const normalized = normalizeFilePath(diagnostic.file);
      if (!normalized) {
        return;
      }
      const key = normalized.toLowerCase();
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)?.push(diagnostic);
    });
    return grouped;
  }

  function formatTypeScriptErrorSummary(diagnostics: TypeScriptDiagnostic[]): string {
    const summaryLines = diagnostics.slice(0, 6).map((diagnostic) => {
      return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} — ${diagnostic.code} ${diagnostic.message}`;
    });
    if (diagnostics.length > 6) {
      summaryLines.push(`…and ${diagnostics.length - 6} more diagnostic(s).`);
    }
    return summaryLines.join('\n');
  }

  function setRewriteHintsFromDiagnostics(diagnostics: TypeScriptDiagnostic[]): void {
    if (!diagnostics.length) {
      return;
    }
    const grouped = indexDiagnosticsByFileInternal(diagnostics);
    grouped.forEach((fileDiagnostics, key) => {
      if (!fileDiagnostics.length) {
        return;
      }
      const summary = formatTypeScriptErrorSummary(fileDiagnostics);
      rewriteHints.set(key, summary);
    });
  }

  function clearRewriteHintsForFiles(files: string[]): void {
    files.forEach((file) => {
      const normalized = normalizeFilePath(file);
      if (!normalized) {
        return;
      }
      rewriteHints.delete(normalized.toLowerCase());
    });
  }

  function createBaselineKey(code: string, message: string): string {
    return `${code.toUpperCase()}:${message.replace(/\s+/g, ' ').trim().toLowerCase()}`;
  }

  function createDiagnosticFingerprint(
    file: string,
    code: string,
    line: number,
    column: number,
    message: string
  ): string {
    return hashString(
      `${file.toLowerCase()}:${code}:${String(line)}:${String(column)}:${message.replace(/\s+/g, ' ').toLowerCase()}`
    );
  }

  return {
    captureBaseline,
    runValidation,
    indexDiagnosticsByFile: indexDiagnosticsByFileInternal,
    getBaselineDiagnostics(): TypeScriptDiagnostic[] {
      return [...baselineDiagnostics];
    },
    getRewriteHint(relativePath: string): string | undefined {
      const normalized = normalizeFilePath(relativePath);
      if (!normalized) {
        return undefined;
      }
      return rewriteHints.get(normalized.toLowerCase());
    }
  };
}

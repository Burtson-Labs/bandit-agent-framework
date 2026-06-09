import type {
  ITelemetry,
  TypeScriptDiagnostic,
  TypeScriptValidationContext,
  ValidationOutcome,
  TypeScriptValidator,
  IDiffManager,
  StepOutcome,
  IUndoManager
} from '../internalTypes';
import type { WorkspacePackageManager } from '../internalTypes';

type TextReplacement = {
  start: number;
  end: number;
  text: string;
};

export interface AutoHealerDeps {
  telemetry: ITelemetry;
  diffManager: IDiffManager;
  typescriptValidator: TypeScriptValidator;
  workspacePackageManager: WorkspacePackageManager;
  ensureSession(): { workspaceRoot: string };
  readWorkspaceFile(path: string, encoding?: BufferEncoding): Promise<string>;
  writeWorkspaceFile(path: string, content: string, encoding?: BufferEncoding): Promise<void>;
  normalizeRelativePath(value: string): string | undefined;
  getProjectSummary(): string;
  generateRewrite(
    goal: string,
    relativePath: string,
    currentContent: string,
    projectSummary: string,
    instructions: string
  ): Promise<StepOutcome>;
  isDryRunEnabled(): boolean;
  isPreviewOnly(): boolean;
  scheduleEmbeddingUpsert(relativePath: string, content: string): void;
  undoManager: Pick<IUndoManager, 'recordSnapshot'>;
  getWorkspaceRoot(): string;
}

const MAX_LOCAL_FIX_ITERATIONS = 3;
const isBrowser = typeof window !== 'undefined';

const hashString = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(16, '0');
};

const joinPath = (root: string, relative: string): string => {
  const cleanRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const cleanRel = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  return `${cleanRoot}/${cleanRel}`;
};

export interface AutoHealer {
  autoHealTypeScriptErrors(
    goal: string,
    context: TypeScriptValidationContext,
    initial: ValidationOutcome
  ): Promise<ValidationOutcome>;
  autoRepairValidationErrors(
    goal: string,
    touchedFiles: string[],
    helperStep: boolean,
    initial: ValidationOutcome
  ): Promise<ValidationOutcome>;
}

export function createAutoHealer(deps: AutoHealerDeps): AutoHealer {
  async function autoHealTypeScriptErrors(
    goal: string,
    context: TypeScriptValidationContext,
    initial: ValidationOutcome
  ): Promise<ValidationOutcome> {
    if (isBrowser) {
      return initial;
    }
    if (!initial.diagnostics || initial.diagnostics.length === 0 || !context.touchedFiles?.length) {
      return initial;
    }
    if (deps.isDryRunEnabled()) {
      return initial;
    }
    const maxIterations = MAX_LOCAL_FIX_ITERATIONS;
    const normalizedTouchedKeys = normalizeTouchedFileKeys(context.touchedFiles, deps.normalizeRelativePath);
    const diagnosticHistory = new Map<string, string>();
    const diffHistory = new Map<string, string>();
    let stalledDiagnostics = false;
    let noChangesApplied = false;
    updateDiagnosticsSignatureMap(
      diagnosticHistory,
      initial.diagnostics,
      normalizedTouchedKeys,
      deps.normalizeRelativePath
    );
    let attempt = 0;
    let current = initial;
    while (!current.ok && current.diagnostics && current.diagnostics.length > 0 && attempt < maxIterations) {
      attempt += 1;
      const grouped = deps.typescriptValidator.indexDiagnosticsByFile(current.diagnostics);
      let applied = false;
      for (const file of context.touchedFiles) {
        const diagnostics = grouped.get(file.toLowerCase());
        if (!diagnostics || diagnostics.length === 0) {
          continue;
        }
        const fixed = await applyTypeScriptFix(goal, file, diagnostics, context.helperStep ?? false, diffHistory);
        applied = applied || fixed;
      }
      if (!applied) {
        noChangesApplied = true;
        break;
      }
      current = await deps.typescriptValidator.runValidation(context);
      if (current.ok) {
        return current;
      }
      const diagnosticsChanged = updateDiagnosticsSignatureMap(
        diagnosticHistory,
        current.diagnostics,
        normalizedTouchedKeys,
        deps.normalizeRelativePath
      );
      if (!diagnosticsChanged) {
        await deps.telemetry.log({
          message: `TypeScript diagnostics unchanged after ${attempt} self-correction attempt${attempt === 1 ? '' : 's'} for ${context.touchedFiles.join(', ')}`,
          level: 'warn'
        });
        stalledDiagnostics = true;
        break;
      }
    }
    if (!current.ok) {
      if (stalledDiagnostics) {
        appendFinalNote(
          current,
          'best-effort',
          `Local auto-healing stopped because diagnostics for ${formatTouchedList(context.touchedFiles)} remained unchanged across iterations.`
        );
      } else if (noChangesApplied) {
        appendFinalNote(
          current,
          'best-effort',
          `Local auto-healing halted because rewrite attempts for ${formatTouchedList(context.touchedFiles)} produced no diff.`
        );
      } else if (attempt >= maxIterations) {
        appendFinalNote(
          current,
          'best-effort',
          `Local auto-healing reached the ${MAX_LOCAL_FIX_ITERATIONS} iteration limit for ${formatTouchedList(context.touchedFiles)}.`
        );
      }
    }
    return current;
  }

  async function autoRepairValidationErrors(
    goal: string,
    touchedFiles: string[],
    helperStep: boolean,
    initial: ValidationOutcome
  ): Promise<ValidationOutcome> {
    if (
      initial.ok
      || deps.isPreviewOnly()
      || deps.isDryRunEnabled()
      || !initial.diagnostics
      || initial.diagnostics.length === 0
      || !touchedFiles.length
      || initial.kind === 'typescript'
    ) {
      return initial;
    }
    const normalizedTargets = touchedFiles
      .map((file) => deps.normalizeRelativePath(file) ?? file)
      .filter((file): file is string => Boolean(file));
    if (!normalizedTargets.length) {
      return initial;
    }
    const maxIterations = helperStep ? 1 : 2;
    let attempt = 0;
    let current = initial;
    const repairedFiles = new Set<string>();
    let fallbackDiagnostics = initial.diagnostics;

    while (!current.ok && attempt < maxIterations) {
      attempt += 1;
      const activeDiagnostics =
        current.diagnostics && current.diagnostics.length > 0 ? current.diagnostics : fallbackDiagnostics ?? [];
      if (!activeDiagnostics.length) {
        break;
      }
      fallbackDiagnostics = activeDiagnostics;
      const grouped = deps.typescriptValidator.indexDiagnosticsByFile(activeDiagnostics);
      let applied = false;
      for (const file of normalizedTargets) {
        const diagnostics = grouped.get(file.toLowerCase()) ?? activeDiagnostics;
        if (!diagnostics || diagnostics.length === 0) {
          continue;
        }
        const fixed = await applyGenericValidationFix(goal, file, diagnostics, helperStep, current.kind);
        if (fixed) {
          applied = true;
          repairedFiles.add(file);
        }
      }
      if (!applied) {
        break;
      }
      current = await deps.workspacePackageManager.runLintValidation(normalizedTargets, {
        previewOnly: deps.isPreviewOnly(),
        workspaceRoot: deps.getWorkspaceRoot()
      });
      if (current.ok) {
        return {
          ...current,
          repairedFiles: Array.from(repairedFiles),
          repairAttempts: attempt,
          repairKind: initial.kind ?? 'package'
        };
      }
    }

    if (!current.ok && repairedFiles.size > 0) {
      current.repairedFiles = Array.from(
        new Set([...(current.repairedFiles ?? []), ...Array.from(repairedFiles)])
      );
    }
    current.repairAttempts = attempt;
    current.repairKind = initial.kind ?? 'package';
    if (!current.ok) {
      const files = touchedFiles.join(', ') || 'touched files';
      await deps.telemetry.log({
        message: `Validation auto-repair exhausted for ${files} (${current.kind ?? 'package'}) after ${attempt} attempt${attempt === 1 ? '' : 's'}.`,
        level: 'warn'
      });
    }
    return current;
  }

  async function applyGenericValidationFix(
    goal: string,
    relativePath: string,
    diagnostics: TypeScriptDiagnostic[],
    helperStep: boolean,
    kind?: string
  ): Promise<boolean> {
    const session = deps.ensureSession();
    const absolutePath = joinPath(session.workspaceRoot, relativePath);
    let original = '';
    try {
      original = await deps.readWorkspaceFile(absolutePath);
    } catch (error) {
      await deps.telemetry.log({
        message: `Auto-repair skipped — unable to read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
        level: 'warn'
      });
      return false;
    }
    const projectSummary = deps.getProjectSummary();
    const instructions = composeValidationRepairInstructions(goal, relativePath, diagnostics, kind, helperStep);
    const rewrite = await deps.generateRewrite(goal, relativePath, original, projectSummary, instructions);
    if (!rewrite.ok || typeof rewrite.data?.content !== 'string') {
      await deps.telemetry.log({
        message: `Auto-repair rewrite failed for ${relativePath}: ${rewrite.error ?? rewrite.output ?? 'unknown error'}`,
        level: 'warn'
      });
      return false;
    }
    const content = rewrite.data.content;
    if (!content.trim() || content.trim() === original.trim()) {
      return false;
    }
    const applied = await applyAutofixRewrite(relativePath, original, content);
    if (applied) {
      await deps.telemetry.log({
        message: `Auto-repair applied to ${relativePath} to address ${kind ?? 'package'} diagnostics.`,
        level: 'info'
      });
    }
    return applied;
  }

  function composeValidationRepairInstructions(
    goal: string,
    relativePath: string,
    diagnostics: TypeScriptDiagnostic[],
    kind?: string,
    helperStep?: boolean
  ): string {
    const header = [
      `Validation kind: ${kind ?? 'package'}.`,
      `File path: ${relativePath}`,
      helperStep
        ? 'This is a helper file. Preserve its exports and public surface.'
        : 'This is a caller file. Keep helper usage intact and avoid creating new helpers.',
      'Resolve the following diagnostics:'
    ];
    const bulletList = diagnostics.slice(0, 10).map((diagnostic, index) => {
      const location = `${diagnostic.line}:${diagnostic.column}`;
      const code = diagnostic.code || 'DIAG';
      return `${index + 1}. ${code} at ${location} — ${diagnostic.message}`;
    });
    if (diagnostics.length > 10) {
      bulletList.push(`…and ${diagnostics.length - 10} more issue(s).`);
    }
    if (bulletList.length === 0) {
      bulletList.push('1. Resolve the lint/test failures emitted by the validation command.');
    }
    const footer = [
      'Modify only the sections required to satisfy these diagnostics.',
      'Do not invent new files or imports; stay consistent with the workspace index.',
      `Original goal: ${goal}`
    ];
    return [...header, ...bulletList, ...footer].join('\n');
  }

  async function applyTypeScriptFix(
    goal: string,
    relativePath: string,
    diagnostics: TypeScriptDiagnostic[],
    helperStep: boolean,
    diffHistory: Map<string, string>
  ): Promise<boolean> {
    const deterministicApplied = await applyDeterministicTypeScriptFixes(relativePath, diagnostics);
    if (deterministicApplied) {
      return true;
    }
    const session = deps.ensureSession();
    const absolutePath = joinPath(session.workspaceRoot, relativePath);
    let original = '';
    try {
      original = await deps.readWorkspaceFile(absolutePath);
    } catch (error) {
      await deps.telemetry.log({
        message: `Auto-fix skipped — unable to read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
        level: 'warn'
      });
      return false;
    }
    const projectSummary = deps.getProjectSummary();
    const instructions = composeTypeScriptFixInstructions(goal, relativePath, diagnostics, helperStep);
    const rewrite = await deps.generateRewrite(goal, relativePath, original, projectSummary, instructions);
    if (!rewrite.ok || typeof rewrite.data?.content !== 'string') {
      await deps.telemetry.log({
        message: `Auto-fix rewrite failed for ${relativePath}: ${rewrite.error ?? rewrite.output ?? 'unknown error'}`,
        level: 'warn'
      });
      return false;
    }
    const content = rewrite.data.content;
    if (!content.trim() || content.trim() === original.trim()) {
      return false;
    }
    const applied = await applyAutofixRewrite(relativePath, original, content, diffHistory);
    if (applied) {
      await deps.telemetry.log({
        message: `Auto-fix applied to ${relativePath} to address TypeScript diagnostics.`,
        level: 'info'
      });
    }
    return applied;
  }

  async function applyDeterministicTypeScriptFixes(
    relativePath: string,
    diagnostics: TypeScriptDiagnostic[]
  ): Promise<boolean> {
    const fixers: Array<() => Promise<boolean>> = [
      () => applyMuiBoxSpacingFix(relativePath, diagnostics)
    ];
    for (const fixer of fixers) {
      if (await fixer()) {
        return true;
      }
    }
    return false;
  }

  async function applyMuiBoxSpacingFix(
    relativePath: string,
    diagnostics: TypeScriptDiagnostic[]
  ): Promise<boolean> {
    const hasSpacingDiagnostic = diagnostics.some((diagnostic) => isMuiBoxSpacingDiagnostic(diagnostic));
    if (!hasSpacingDiagnostic) {
      return false;
    }
    const session = deps.ensureSession();
    const absolutePath = joinPath(session.workspaceRoot, relativePath);
    let original = '';
    try {
      original = await deps.readWorkspaceFile(absolutePath);
    } catch (error) {
      await deps.telemetry.log({
        message: `Box spacing fix skipped — unable to read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
        level: 'warn'
      });
      return false;
    }
    const updated = rewriteMuiBoxSpacing(original);
    if (!updated || updated === original) {
      return false;
    }
    const applied = await applyAutofixRewrite(relativePath, original, updated);
    if (applied) {
      await deps.telemetry.log({
        message: `Replaced invalid Box spacing usage with Stack in ${relativePath}.`,
        level: 'info'
      });
    }
    return applied;
  }

function composeTypeScriptFixInstructions(
  goal: string,
  relativePath: string,
  diagnostics: TypeScriptDiagnostic[],
  helperStep: boolean
  ): string {
    const header = [
      `Goal: ${goal}`,
      `File path: ${relativePath}`,
      helperStep
        ? 'This is a helper file. Maintain its exports and be conservative with new dependencies.'
        : 'This is a caller file. Keep helper usage intact and do not introduce new helpers unless required.'
    ];
    const body = diagnostics.slice(0, 12).map((diagnostic, index) => {
      const location = `${diagnostic.line}:${diagnostic.column}`;
      const code = diagnostic.code || 'TS';
      return `${index + 1}. ${code} at ${location} — ${diagnostic.message}`;
    });
    if (diagnostics.length > 12) {
      body.push(`…and ${diagnostics.length - 12} more TypeScript issue(s).`);
    }
  const footer = [
    'Adjust only the regions necessary to satisfy these diagnostics.',
    'Respect existing patterns and avoid large-scale rewrites.',
    'Return the full, compilable file with no commentary.',
    'Keep the file name and exports the same — rewrite this file only.'
  ];
  return [...header, 'Resolve these TypeScript diagnostics:', ...body, ...footer].join('\n');
}

  function isMuiBoxSpacingDiagnostic(diagnostic: TypeScriptDiagnostic): boolean {
    const normalized = diagnostic.message.toLowerCase();
    const mentionsBox = normalized.includes('boxownprops') || normalized.includes('boxprops');
    return mentionsBox && normalized.includes('spacing');
  }

  function rewriteMuiBoxSpacing(content: string): string | undefined {
    const pattern = /<Box\b[^>]*\bspacing\s*=\s*\{[^}]+\}[^>]*>/g;
    const replacements: TextReplacement[] = [];
    const closingReplacements = new Set<number>();
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const openStart = match.index;
      const openEnd = openStart + match[0].length;
      replacements.push({ start: openStart + 1, end: openStart + 4, text: 'Stack' });
      const trimmed = match[0].trimEnd();
      const selfClosing = /\/\s*>$/.test(trimmed);
      if (!selfClosing) {
        const closingIndex = findMatchingTagCloseIndex(content, openEnd, 'Box');
        if (closingIndex !== -1 && !closingReplacements.has(closingIndex)) {
          replacements.push({ start: closingIndex + 2, end: closingIndex + 5, text: 'Stack' });
          closingReplacements.add(closingIndex);
        }
      }
    }
    if (replacements.length === 0) {
      return undefined;
    }
    let updated = applyTextReplacements(content, replacements);
    const importResult = ensureStackImport(updated);
    updated = importResult.content;
    return updated;
  }

  function findMatchingTagCloseIndex(source: string, searchFrom: number, tagName: string): number {
    let depth = 1;
    let cursor = searchFrom;
    while (cursor < source.length) {
      const nextOpen = source.indexOf(`<${tagName}`, cursor);
      const nextClose = source.indexOf(`</${tagName}`, cursor);
      if (nextClose === -1) {
        return -1;
      }
      if (nextOpen !== -1 && nextOpen < nextClose) {
        const openEnd = source.indexOf('>', nextOpen);
        if (openEnd === -1) {
          return -1;
        }
        const snippet = source.slice(nextOpen, openEnd + 1).trimEnd();
        const selfClosing = snippet.endsWith('/>');
        if (!selfClosing) {
          depth += 1;
        }
        cursor = openEnd + 1;
        continue;
      }
      depth -= 1;
      if (depth === 0) {
        return nextClose;
      }
      const closeEnd = source.indexOf('>', nextClose);
      if (closeEnd === -1) {
        return -1;
      }
      cursor = closeEnd + 1;
    }
    return -1;
  }

  function applyTextReplacements(source: string, replacements: TextReplacement[]): string {
    if (replacements.length === 0) {
      return source;
    }
    const sorted = [...replacements].sort((a, b) => a.start - b.start);
    let result = '';
    let cursor = 0;
    for (const replacement of sorted) {
      if (replacement.start < cursor) {
        continue;
      }
      result += source.slice(cursor, replacement.start);
      result += replacement.text;
      cursor = replacement.end;
    }
    result += source.slice(cursor);
    return result;
  }

  function ensureStackImport(content: string): { content: string; added: boolean } {
    const lines = content.split(/\r?\n/);
    let hasStackImport = false;
    let lastImportIndex = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (/^import\s+Stack\b/.test(trimmed) && trimmed.includes('@mui/material')) {
        hasStackImport = true;
      }
      if (trimmed.startsWith('import ')) {
        lastImportIndex = i;
      }
    }
    if (hasStackImport) {
      return { content, added: false };
    }
    const statement = "import Stack from '@mui/material/Stack';";
    if (lastImportIndex >= 0) {
      lines.splice(lastImportIndex + 1, 0, statement);
    } else {
      lines.unshift(statement, '');
    }
    return { content: lines.join('\n'), added: true };
  }

  async function applyAutofixRewrite(
    relativePath: string,
    original: string,
    updated: string,
    diffHistory?: Map<string, string>
  ): Promise<boolean> {
    if (deps.isPreviewOnly() || deps.isDryRunEnabled()) {
      return false;
    }
    const normalized = deps.normalizeRelativePath(relativePath) ?? relativePath;
    if (!normalized) {
      return false;
    }
    const diffRecord = await deps.diffManager.registerPendingDiff(normalized, original, updated, undefined);
    if (!diffRecord.diff) {
      await deps.telemetry.log({
        message: `Unable to compute diff for ${normalized}; skipping auto-fix write.`,
        level: 'warn'
      });
      return false;
    }
    const shouldWrite = diffRecord.changed !== false;
    if (!shouldWrite) {
      return false;
    }
    if (diffHistory && !diffRecordRepresentsChange(normalized, original, updated, diffHistory, diffRecord.diff)) {
      return false;
    }
    const session = deps.ensureSession();
    const absolutePath = joinPath(session.workspaceRoot, normalized);
    try {
      await deps.writeWorkspaceFile(absolutePath, updated, 'utf8');
    } catch (error) {
      await deps.telemetry.log({
        message: `Failed to write ${normalized}: ${error instanceof Error ? error.message : String(error)}`,
        level: 'error'
      });
      return false;
    }
    deps.undoManager.recordSnapshot({
      path: normalized,
      absolutePath,
      before: original,
      after: updated,
      encoding: 'utf8',
      timestamp: Date.now(),
      existedBefore: true
    });
    deps.scheduleEmbeddingUpsert(normalized, updated);
    return true;
  }

  return {
    autoHealTypeScriptErrors,
    autoRepairValidationErrors
  };
}

function appendFinalNote(
  outcome: ValidationOutcome | undefined,
  status: 'complete' | 'best-effort',
  note: string
): void {
  if (!outcome || !note) {
    return;
  }
  const notes = Array.isArray(outcome.finalNotes) ? [...outcome.finalNotes] : [];
  if (!notes.includes(note)) {
    notes.push(note);
  }
  outcome.finalNotes = notes;
  outcome.finalStatus = status;
}

function formatTouchedList(files: string[]): string {
  if (!Array.isArray(files) || files.length === 0) {
    return 'the target file';
  }
  if (files.length === 1) {
    return files[0];
  }
  return files.join(', ');
}

function normalizeTouchedFileKeys(
  files: string[] | undefined,
  normalizeRelativePath: (value: string) => string | undefined
): string[] {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }
  const normalized = files
    .map((file) => normalizeRelativePath(file) ?? file)
    .map((file) => file.replace(/\\/g, '/').toLowerCase())
    .filter((file) => file.length > 0);
  return Array.from(new Set(normalized));
}

function updateDiagnosticsSignatureMap(
  state: Map<string, string>,
  diagnostics: TypeScriptDiagnostic[] | undefined,
  touchedFileKeys: string[],
  normalizeRelativePath: (value: string) => string | undefined
): boolean {
  const grouped = groupDiagnosticsByFileKey(diagnostics, normalizeRelativePath);
  const keys = touchedFileKeys.length > 0 ? touchedFileKeys : Array.from(grouped.keys());
  let changed = false;
  keys.forEach((key) => {
    const signature = buildDiagnosticsSignature(grouped.get(key));
    const previous = state.get(key) ?? '';
    if (signature !== previous) {
      changed = true;
      if (signature.length > 0) {
        state.set(key, signature);
      } else {
        state.delete(key);
      }
    }
  });
  return changed;
}

function groupDiagnosticsByFileKey(
  diagnostics: TypeScriptDiagnostic[] | undefined,
  normalizeRelativePath: (value: string) => string | undefined
): Map<string, TypeScriptDiagnostic[]> {
  const bucket = new Map<string, TypeScriptDiagnostic[]>();
  if (!Array.isArray(diagnostics)) {
    return bucket;
  }
  diagnostics.forEach((diagnostic) => {
    const normalizedPath = (normalizeRelativePath(diagnostic.file) ?? diagnostic.file)?.replace(/\\/g, '/').toLowerCase();
    if (!normalizedPath) {
      return;
    }
    const list = bucket.get(normalizedPath) ?? [];
    list.push(diagnostic);
    bucket.set(normalizedPath, list);
  });
  return bucket;
}

function buildDiagnosticsSignature(diagnostics: TypeScriptDiagnostic[] | undefined): string {
  if (!diagnostics || diagnostics.length === 0) {
    return '';
  }
  const hashes = diagnostics.map((diagnostic) => buildDiagnosticFingerprint(diagnostic)).sort();
  return hashes.join('|');
}

function buildDiagnosticFingerprint(diagnostic: TypeScriptDiagnostic): string {
  if (typeof diagnostic.fingerprint === 'string' && diagnostic.fingerprint.length > 0) {
    return diagnostic.fingerprint;
  }
  const fingerprint = [
    diagnostic.file ?? '',
    String(diagnostic.line ?? '0'),
    String((diagnostic as { column?: number }).column ?? '0'),
    diagnostic.code ?? '',
    diagnostic.message ?? ''
  ].join('|');
  return hashString(fingerprint);
}

function diffRecordRepresentsChange(
  relativePath: string,
  _original: string,
  _updated: string,
  diffHistory: Map<string, string>,
  diffContent: string | undefined
): boolean {
  if (!diffContent) {
    return true;
  }
  const normalizedPath = relativePath.replace(/\\/g, '/').toLowerCase();
  const previous = diffHistory.get(normalizedPath);
  const current = hashString(`${normalizedPath}:${diffContent}`);
  if (previous === current) {
    return false;
  }
  diffHistory.set(normalizedPath, current);
  return true;
}

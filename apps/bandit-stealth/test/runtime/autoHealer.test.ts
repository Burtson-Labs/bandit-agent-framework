import { describe, expect, it, vi } from 'vitest';
import {
  createAutoHealer,
  type AutoHealerDeps,
  type FileChangeSnapshot,
  type IDiffManager,
  type ITelemetry,
  type TypeScriptDiagnostic,
  type TypeScriptValidationContext,
  type TypeScriptValidator,
  type ValidationOutcome,
  type WorkspacePackageManager
} from '@burtson-labs/stealth-core-runtime';
import path from 'path';

const WORKSPACE_ROOT = '/tmp/workspace';

function createTelemetry(): ITelemetry & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    status: vi.fn(),
    log: vi.fn(async (payload) => {
      if (payload.message) {
        logs.push(payload.message);
      }
    }),
    event: vi.fn()
  };
}

function createDiffManager(diffChanged = true): IDiffManager {
  return {
    clear: vi.fn(),
    getPendingDiff: vi.fn(),
    registerPendingDiff: vi.fn().mockResolvedValue({
      diff: diffChanged ? 'diff' : undefined,
      changed: diffChanged
    }),
    recordSnapshot: vi.fn(),
    popSnapshot: vi.fn(),
    hasSnapshots: vi.fn().mockReturnValue(false),
    getSnapshotCount: vi.fn().mockReturnValue(0),
    enableReviewMode: vi.fn(),
    isReviewModeEnabled: vi.fn().mockReturnValue(false),
    postDiffStream: vi.fn()
  };
}

function createValidator(): TypeScriptValidator & {
  runValidation: ReturnType<typeof vi.fn>;
} {
  const validator: TypeScriptValidator & { runValidation: ReturnType<typeof vi.fn> } = {
    captureBaseline: vi.fn(),
    runValidation: vi.fn(),
    indexDiagnosticsByFile: (diagnostics: TypeScriptDiagnostic[]) => {
      const map = new Map<string, TypeScriptDiagnostic[]>();
      diagnostics.forEach((diagnostic) => {
        const key = (diagnostic.file ?? '').toLowerCase();
        if (!map.has(key)) {
          map.set(key, []);
        }
        map.get(key)?.push(diagnostic);
      });
      return map;
    },
    getBaselineDiagnostics: vi.fn().mockReturnValue([]),
    getRewriteHint: vi.fn()
  };
  return validator;
}

function createWorkspacePackageManager(): WorkspacePackageManager {
  return {
    updateFromSnapshot: vi.fn(),
    runLintValidation: vi.fn()
  };
}

function createDeps(options?: {
  diffChanged?: boolean;
  previewOnly?: boolean;
  rewriteContent?: string;
}) {
  const telemetry = createTelemetry();
  const diffManager = createDiffManager(options?.diffChanged ?? true);
  const validator = createValidator();
  const workspacePackageManager = createWorkspacePackageManager();
  const writes: Array<{ path: string; content: string }> = [];
  const snapshots: FileChangeSnapshot[] = [];
  const rewriteContent = options?.rewriteContent ?? 'rewritten content';

  const undoManager = {
    recordSnapshot: vi.fn((snapshot: FileChangeSnapshot) => {
      snapshots.push(snapshot);
    })
  };

  const deps: AutoHealerDeps = {
    telemetry,
    diffManager,
    typescriptValidator: validator,
    workspacePackageManager,
    ensureSession: () => ({ workspaceRoot: WORKSPACE_ROOT }),
    readWorkspaceFile: vi.fn().mockResolvedValue('original file contents'),
    writeWorkspaceFile: vi.fn(async (target, content) => {
      writes.push({ path: target, content });
    }),
    normalizeRelativePath: (value) => (typeof value === 'string' ? value.replace(/^\.\//, '') : undefined),
    getProjectSummary: () => 'Test summary',
    generateRewrite: vi.fn().mockResolvedValue({
      ok: true,
      data: { content: rewriteContent }
    }),
    isDryRunEnabled: () => false,
    isPreviewOnly: () => Boolean(options?.previewOnly),
    scheduleEmbeddingUpsert: vi.fn(),
    undoManager,
    getWorkspaceRoot: () => WORKSPACE_ROOT
  };

  return { deps, telemetry, diffManager, validator, workspacePackageManager, writes, snapshots };
}

function sampleDiagnostic(file: string): TypeScriptDiagnostic {
  return {
    file,
    line: 10,
    column: 5,
    code: 'TS2322',
    message: 'Type mismatch',
    fingerprint: 'ts-error'
  };
}

describe('autoHealer', () => {
  it('repairs TypeScript diagnostics by rewriting files and re-running validation', async () => {
    const { deps, validator, diffManager, writes, snapshots } = createDeps();
    const autoHealer = createAutoHealer(deps);
    const diagnostic = sampleDiagnostic('src/feature.ts');
    (validator.runValidation as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });

    const result = await autoHealer.autoHealTypeScriptErrors(
      'Ship the hero banner',
      { touchedFiles: ['src/feature.ts'], helperStep: false } as TypeScriptValidationContext,
      {
        ok: false,
        diagnostics: [diagnostic],
        kind: 'typescript'
      }
    );

    expect(result.ok).toBe(true);
    expect(deps.generateRewrite).toHaveBeenCalledWith(
      'Ship the hero banner',
      'src/feature.ts',
      'original file contents',
      'Test summary',
      expect.stringContaining('Resolve these TypeScript diagnostics')
    );
    expect(diffManager.registerPendingDiff).toHaveBeenCalledWith(
      'src/feature.ts',
      'original file contents',
      'rewritten content',
      undefined
    );
    expect(writes).toEqual([
      {
        path: path.join(WORKSPACE_ROOT, 'src/feature.ts'),
        content: 'rewritten content'
      }
    ]);
    expect(snapshots).toHaveLength(1);
    expect(validator.runValidation).toHaveBeenCalledTimes(1);
  });

  it('skips writing when no diff could be computed', async () => {
    const { deps, validator, writes } = createDeps({ diffChanged: false });
    const autoHealer = createAutoHealer(deps);
    const diagnostic = sampleDiagnostic('src/noop.ts');
    (validator.runValidation as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      diagnostics: [diagnostic],
      kind: 'typescript'
    });

    const initial: ValidationOutcome = { ok: false, diagnostics: [diagnostic], kind: 'typescript' };
    const result = await autoHealer.autoHealTypeScriptErrors(
      'Fix types',
      { touchedFiles: ['src/noop.ts'], helperStep: false },
      initial
    );

    expect(result).toEqual(initial);
    expect(writes).toHaveLength(0);
    expect(validator.runValidation).not.toHaveBeenCalled();
  });

  it('repairs package diagnostics and re-runs lint validation', async () => {
    const { deps, workspacePackageManager, writes } = createDeps();
    const autoHealer = createAutoHealer(deps);
    const diagnostic = sampleDiagnostic('src/lint-me.ts');
    (workspacePackageManager.runLintValidation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true });

    const result = await autoHealer.autoRepairValidationErrors(
      'Fix lint',
      ['src/lint-me.ts'],
      false,
      {
        ok: false,
        diagnostics: [diagnostic],
        kind: 'package'
      }
    );

    expect(result.ok).toBe(true);
    expect(workspacePackageManager.runLintValidation).toHaveBeenCalledWith(
      ['src/lint-me.ts'],
      expect.objectContaining({ previewOnly: false, workspaceRoot: WORKSPACE_ROOT })
    );
    expect(deps.generateRewrite).toHaveBeenCalledWith(
      'Fix lint',
      'src/lint-me.ts',
      'original file contents',
      'Test summary',
      expect.stringContaining('Validation kind: package')
    );
    expect(writes.length).toBeGreaterThan(0);
  });
});

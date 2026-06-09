import { describe, expect, it, vi } from 'vitest';
import { createTypeCheckRunner } from '../src/runtime/typeCheckRunner';
import { createInternalActionExecutor } from '../src/runtime/internalActions';
import type { TypeScriptDiagnostic } from '../src/runtime/types';

const WORKSPACE_ROOT = '/workspace';
const TARGET_FILE = 'apps/agent-ui-workbench/src/App.tsx';

function createBaselineDiagnostic(partial?: Partial<TypeScriptDiagnostic>): TypeScriptDiagnostic {
  return {
    file: TARGET_FILE,
    line: 20,
    column: 30,
    code: 'TS2307',
    message: "Cannot find module 'uuid' or its corresponding type declarations.",
    fingerprint: 'baseline-diagnostic',
    ...partial
  };
}

describe('typeCheckRunner baseline filtering', () => {
  it('ignores pre-existing diagnostics in touched files', async () => {
    const runner = createTypeCheckRunner({
      runPythonCommand: vi.fn().mockResolvedValue({
        status: 'FAILED',
        code: 1,
        output: `${TARGET_FILE}(21,30): error TS2307: Cannot find module 'uuid' or its corresponding type declarations.`
      }),
      getProjectRoot: () => WORKSPACE_ROOT,
      getWorkspaceRoot: () => WORKSPACE_ROOT,
      normalizeRelativePath: (value: string) => value.replace(`${WORKSPACE_ROOT}/`, '').replace(/\\/g, '/'),
      getBaselineDiagnostics: () => [createBaselineDiagnostic()]
    });

    const result = await runner.runProjectTypeCheck({
      cwd: WORKSPACE_ROOT,
      files: [TARGET_FILE],
      validateOnlyThesePaths: [TARGET_FILE]
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.ignoredDiagnostics).toHaveLength(1);
    expect(result.note).toContain('pre-existing TypeScript diagnostic');
  });

  it('still blocks newly introduced diagnostics', async () => {
    const runner = createTypeCheckRunner({
      runPythonCommand: vi.fn().mockResolvedValue({
        status: 'FAILED',
        code: 1,
        output: [
          `${TARGET_FILE}(21,30): error TS2307: Cannot find module 'uuid' or its corresponding type declarations.`,
          `${TARGET_FILE}(53,66): error TS2353: Object literal may only specify known properties, and 'step' does not exist in type 'AgentUIEvent'.`
        ].join('\n')
      }),
      getProjectRoot: () => WORKSPACE_ROOT,
      getWorkspaceRoot: () => WORKSPACE_ROOT,
      normalizeRelativePath: (value: string) => value.replace(`${WORKSPACE_ROOT}/`, '').replace(/\\/g, '/'),
      getBaselineDiagnostics: () => [createBaselineDiagnostic()]
    });

    const result = await runner.runProjectTypeCheck({
      cwd: WORKSPACE_ROOT,
      files: [TARGET_FILE],
      validateOnlyThesePaths: [TARGET_FILE]
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics?.[0]?.message).toContain("Object literal may only specify known properties");
    expect(result.ignoredDiagnostics).toHaveLength(1);
  });
});

describe('locateFiles hint handling', () => {
  it('does not force a lower-ranked primaryPathHint over stronger matches', async () => {
    const context = new Map<string, unknown>();
    context.set('project', {
      files: [
        'apps/agent-ui-workbench/src/App.tsx',
        'apps/bandit-stealth-web/src/App.tsx',
        'apps/bandit-stealth/webview-v2/src/App.tsx',
        'apps/agent-ui-workbench/src/main.tsx',
        'apps/bandit-stealth-web/src/components/AuthGuard.tsx'
      ]
    });

    const executor = createInternalActionExecutor({
      getContextValue: <T>(key: string): T | undefined => context.get(key) as T | undefined,
      setContextValue: (key: string, value: unknown): void => {
        context.set(key, value);
      },
      normalizeRelativePath: (value: string): string | undefined =>
        value.replace(/\\/g, '/').replace(/^\.\/+/, '') || undefined,
      runPythonStep: vi.fn(),
      isCancelled: () => false,
      reviewDiff: vi.fn(),
      extractRelevantSection: vi.fn(),
      clampSnippet: vi.fn()
    });

    const locateStep = {
      id: 'locate-step',
      title: 'Locate relevant files',
      details: 'test',
      action: {
        type: 'internal',
        name: 'locateFiles'
      }
    } as const;

    const outcome = await executor.execute(locateStep as any, {
      type: 'internal',
      name: 'locateFiles',
      patterns: [
        'apps/agent-ui-workbench/src/App.tsx',
        'apps/bandit-stealth-web/src/App.tsx',
        'apps/bandit-stealth/webview-v2/src/App.tsx',
        'apps/agent-ui-workbench/src/app.tsx',
        'apps/bandit-stealth-web/src/app.tsx',
        'apps/bandit-stealth/webview-v2/src/app.tsx',
        'app.tsx',
        'comment'
      ],
      priorityKeywords: [
        'apps',
        'app.tsx',
        'bandit-stealth',
        'agent-ui-workbench',
        'bandit-stealth-web',
        'webview-v2'
      ],
      storePath: 'focus',
      primaryPathHint: 'apps/agent-ui-workbench/src/App.tsx',
      maxMatches: 3
    });

    expect(outcome.ok).toBe(true);
    const primary = context.get('focus.primary') as { path: string } | undefined;
    expect(primary?.path).toBe('apps/bandit-stealth/webview-v2/src/App.tsx');
  });
});

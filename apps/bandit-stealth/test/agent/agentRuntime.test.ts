import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

// Plan file actions used to go through src/python/bandit_agent.py and showed
// a modal "requires Python 3" prompt when Python was missing. They now run
// in-process; these tests run a plan with Python reported missing.

const state = vi.hoisted(() => ({
  workspaceRoot: '',
  errors: [] as string[],
  warnings: [] as string[],
  agentPlan: undefined as unknown
}));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return [{ uri: { fsPath: state.workspaceRoot } }];
    },
    getConfiguration: () => ({ get: (_key: string, defaultValue?: unknown) => defaultValue })
  },
  window: {
    showErrorMessage: vi.fn(async (message: string) => {
      state.errors.push(message);
      return undefined;
    }),
    showWarningMessage: vi.fn(async (message: string) => {
      state.warnings.push(message);
      return undefined;
    }),
    showInformationMessage: vi.fn(async () => undefined),
    showInputBox: vi.fn(async () => undefined)
  },
  env: { openExternal: vi.fn() },
  commands: { executeCommand: vi.fn() },
  Uri: { joinPath: vi.fn(), parse: vi.fn() },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 }
}));

vi.mock('../../src/agent/environmentService', () => ({
  environmentService: {
    postToWebview: vi.fn(async () => undefined),
    getRunContext: () => ({ conversationId: 'conversation', runId: 'run' }),
    resolvePlanRunDirectory: (root: string) => path.join(root, '.bandit', 'plans'),
    saveReport: vi.fn(async () => undefined)
  }
}));

vi.mock('../../src/agent/plannerAgent', () => ({
  StealthPlannerAgent: class {
    createPlan = async () => state.agentPlan;
    getRuntime() {
      return {};
    }
  }
}));

vi.mock('../../src/agent/pythonEnvironment', () => ({
  ensurePython: vi.fn(async () => ({ error: 'Python runtime not detected.' })),
  clearPythonCache: vi.fn()
}));

import { StealthAgentRuntime } from '../../src/agent/agentRuntime';

function makeContext() {
  return {
    extensionUri: { fsPath: path.join(state.workspaceRoot, 'ext') },
    extensionMode: 1,
    storageUri: { fsPath: path.join(state.workspaceRoot, '.storage') },
    globalStorageUri: { fsPath: path.join(state.workspaceRoot, '.global') },
    secrets: { get: async () => undefined, store: async () => undefined }
  } as never;
}

function planWith(steps: Array<{ id: string; action: Record<string, unknown> }>) {
  const createdAt = Date.now();
  return {
    id: `plan-${createdAt}`,
    goal: 'test',
    summary: 'test',
    createdAt,
    version: 'test',
    steps: steps.map((step) => ({
      id: step.id,
      title: step.id,
      description: '',
      metadata: { action: step.action }
    }))
  };
}

beforeEach(() => {
  state.workspaceRoot = mkdtempSync(path.join(tmpdir(), 'stealth-ext-runtime-'));
  state.errors = [];
  state.warnings = [];
});

afterEach(() => {
  rmSync(state.workspaceRoot, { recursive: true, force: true });
});

describe('StealthAgentRuntime without Python', () => {
  it('does not bind a Python bridge script', () => {
    const runtime = new StealthAgentRuntime(makeContext());
    const python = runtime.getHostBindings().python;
    expect(python && 'scriptPath' in python).toBe(false);
    runtime.cancel();
  });

  it('runs scan, command and confinement steps in-process with no Python prompt', async () => {
    writeFileSync(path.join(state.workspaceRoot, 'package.json'), JSON.stringify({ name: 'demo', scripts: { build: 'tsc' } }));
    writeFileSync(path.join(state.workspaceRoot, 'index.ts'), 'export {};\n');
    state.agentPlan = planWith([
      { id: 'scan', action: { type: 'python', name: 'scanProject', storeKey: 'project.scan' } },
      {
        id: 'run',
        action: {
          type: 'python',
          name: 'runCommand',
          command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', process.cwd())"'
        }
      }
    ]);
    const runtime = new StealthAgentRuntime(makeContext());
    try {
      const report = await runtime.startGoal('scan and run');
      expect(report.results.map((result) => [result.stepId, result.ok])).toEqual([
        ['scan', true],
        ['run', true]
      ]);
      const scan = report.results[0].data as { files?: string[]; scripts?: Record<string, string> };
      expect(scan.files).toEqual(expect.arrayContaining(['index.ts', 'package.json']));
      expect(scan.scripts).toEqual({ build: 'tsc' });
      expect(existsSync(path.join(state.workspaceRoot, 'ran.txt'))).toBe(true);
      // The command ran in the workspace root.
      expect(realpathSync(readFileSync(path.join(state.workspaceRoot, 'ran.txt'), 'utf8'))).toBe(
        realpathSync(state.workspaceRoot)
      );
      expect([...state.errors, ...state.warnings].filter((message) => /python/i.test(message))).toEqual([]);
    } finally {
      runtime.cancel();
    }
  });

  it('reports a failed command without a Python prompt', async () => {
    state.agentPlan = planWith([{ id: 'fail', action: { type: 'python', name: 'runCommand', command: 'exit 4' } }]);
    const runtime = new StealthAgentRuntime(makeContext());
    try {
      const report = await runtime.startGoal('fail');
      expect(report.results[0].ok).toBe(false);
      expect(report.results[0].data).toMatchObject({ code: 4, status: 'FAILED' });
      expect([...state.errors, ...state.warnings].filter((message) => /python/i.test(message))).toEqual([]);
    } finally {
      runtime.cancel();
    }
  });
});

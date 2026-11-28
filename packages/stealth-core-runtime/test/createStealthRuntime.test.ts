import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import type { AgentPlan } from '@burtson-labs/agent-core';
import { createNodeFsAdapter, createShellAdapter, createStealthRuntime } from '../src';
import type { StealthHostBindings } from '../src/hostTypes';
import type { IFsAdapter, IShellAdapter, ITelemetry } from '../src/hostTypes';
import type { AgentReport } from '../src/types';

function createRuntime() {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'stealth-runtime-'));
  const savedReports: AgentReport[] = [];
  const hostBindings = createFakeHostBindings(workspaceRoot, savedReports);
  const runtime = createStealthRuntime(hostBindings);
  const cleanup = () => {
    runtime.cancel();
    rmSync(workspaceRoot, { recursive: true, force: true });
  };
  return { runtime, savedReports, cleanup };
}

function createFakeHostBindings(workspaceRoot: string, savedReports: AgentReport[]): StealthHostBindings {
  const artifactRoot = path.join(workspaceRoot, '.bandit');
  mkdirSync(artifactRoot, { recursive: true });
  const telemetry: ITelemetry = {
    async status() {},
    async log() {},
    async event() {}
  };
  const fsAdapter: IFsAdapter = {
    async readText() {
      return '';
    },
    async writeText() {},
    async exists() {
      return true;
    },
    async listRecursive() {
      return [];
    },
    async ensureDir() {},
    async readDir() {
      return [];
    },
    async remove() {}
  };
  const shellAdapter: IShellAdapter = {
    async run() {
      return { code: 0, stdout: '', stderr: '' };
    }
  };

  return {
    env: {
      getRunContext: () => ({ conversationId: 'conversation', runId: 'run' }),
      resolvePlanRunDirectory: (root) => {
        const planDir = path.join(root ?? workspaceRoot, '.bandit', 'plans', 'conversation', 'run');
        mkdirSync(planDir, { recursive: true });
        return planDir;
      },
      async postMessage() {},
      async saveReport(report) {
        savedReports.push(report);
      }
    },
    fs: fsAdapter,
    shell: shellAdapter,
    telemetry,
    ui: {
      async showError() {},
      async showInfo() {},
      promptInput: async () => undefined
    },
    config: {
      get: <T,>(_key: string, defaultValue?: T) => defaultValue
    },
    secrets: {
      get: async () => undefined
    },
    workspace: {
      getInitialWorkspaceRoot: () => workspaceRoot
    },
    artifacts: {
      getStoragePath: () => artifactRoot,
      getGlobalStoragePath: () => path.join(workspaceRoot, '.bandit-global')
    },
    python: {
      ensure: async () => ({ ok: true, version: '3.10.0', command: 'python3' }),
      clearCache: async () => {}
    },
    flags: {
      isDevelopmentMode: () => false,
      shouldSkipValidationInDev: () => false,
      isDryRunEnabled: () => false
    },
    planner: {
      createPlan: async (goal) => createFakeAgentPlan(goal)
    }
  };
}

function createFakeAgentPlan(goal: string): AgentPlan {
  const createdAt = Date.now();
  return {
    id: `plan-${createdAt}`,
    goal,
    summary: `Plan for ${goal}`,
    steps: [
      {
        id: 'step-1',
        title: 'Mock task',
        description: 'Emit a placeholder message.',
        metadata: {
          action: {
            type: 'internal',
            name: 'emitMessage',
            message: 'noop'
          }
        }
      }
    ],
    createdAt,
    version: 'test'
  };
}

describe('createStealthRuntime', () => {
  it('prepares a plan with fake host bindings', async () => {
    const { runtime, cleanup } = createRuntime();
    try {
      const plan = await runtime.preparePlan('Add logging');
      expect(plan.goal).toBe('Add logging');
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].title).toBe('Mock task');
    } finally {
      cleanup();
    }
  });

  it('runs startGoal and emits a report via the host bindings', async () => {
    const { runtime, savedReports, cleanup } = createRuntime();
    try {
      const report = await runtime.startGoal('Ship feature');
      expect(report.goal).toBe('Ship feature');
      expect(savedReports).toHaveLength(1);
      expect(savedReports[0].goal).toBe('Ship feature');
    } finally {
      cleanup();
    }
  });

  it('runs plan file actions in-process with no Python binding', async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'stealth-runtime-nopy-'));
    const savedReports: AgentReport[] = [];
    const errors: string[] = [];
    const bindings = createFakeHostBindings(workspaceRoot, savedReports);
    bindings.fs = createNodeFsAdapter(workspaceRoot);
    bindings.shell = createShellAdapter();
    bindings.ui.showError = async (message) => {
      errors.push(message);
    };
    delete bindings.python;
    writeFileSync(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'demo', scripts: {} }));
    const runtime = createStealthRuntime(bindings);
    try {
      const createdAt = Date.now();
      bindings.planner.createPlan = async (goal) => ({
        id: `plan-${createdAt}`,
        goal,
        summary: goal,
        createdAt,
        version: 'test',
        steps: [
          {
            id: 'scan',
            title: 'Scan project',
            description: '',
            metadata: { action: { type: 'python', name: 'scanProject', storeKey: 'project.scan' } }
          },
          {
            id: 'run',
            title: 'Run command',
            description: '',
            metadata: {
              action: {
                type: 'python',
                name: 'runCommand',
                command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'ok\')"'
              }
            }
          }
        ]
      });
      const report = await runtime.startGoal('Scan and run');
      expect(errors.filter((message) => /python/i.test(message))).toEqual([]);
      expect(report.results.map((result) => [result.stepId, result.ok])).toEqual([['scan', true], ['run', true]]);
      expect(readFileSync(path.join(workspaceRoot, 'ran.txt'), 'utf8')).toBe('ok');
    } finally {
      runtime.cancel();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('reports a failing project script as failed (allowFailure only keeps the run going)', async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'stealth-runtime-scripts-'));
    const savedReports: AgentReport[] = [];
    const bindings = createFakeHostBindings(workspaceRoot, savedReports);
    bindings.fs = createNodeFsAdapter(workspaceRoot);
    bindings.shell = createShellAdapter();
    delete bindings.python;
    writeFileSync(
      path.join(workspaceRoot, 'package.json'),
      JSON.stringify({
        name: 'demo',
        scripts: { lint: 'node -e "process.exit(0)"', test: 'node -e "console.error(\'expected 2, got 3\'); process.exit(1)"' }
      })
    );
    const runtime = createStealthRuntime(bindings);
    try {
      const createdAt = Date.now();
      bindings.planner.createPlan = async (goal) => ({
        id: `plan-${createdAt}`,
        goal,
        summary: goal,
        createdAt,
        version: 'test',
        steps: [
          {
            id: 'scan',
            title: 'Scan project',
            description: '',
            metadata: { action: { type: 'python', name: 'scanProject', storeKey: 'project' } }
          },
          {
            id: 'scripts',
            title: 'Run project scripts',
            description: '',
            metadata: { action: { type: 'internal', name: 'runProjectScripts', scripts: ['lint', 'test'] } }
          }
        ]
      });
      const report = await runtime.startGoal('Run the scripts');
      const scripts = report.results.find((result) => result.stepId === 'scripts');
      expect(scripts?.ok).toBe(false);
      expect(scripts?.output).toBe('Some scripts failed: lint, test');
      const runs = (scripts?.data as { runs: Array<{ script: string; ok: boolean; error?: string }> }).runs;
      expect(runs.map((run) => [run.script, run.ok])).toEqual([['lint', true], ['test', false]]);
      expect(runs[1].error).toContain('expected 2, got 3');
    } finally {
      runtime.cancel();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }, 60000);
});

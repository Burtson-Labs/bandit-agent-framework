import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import type { AgentPlan } from '@burtson-labs/agent-core';
import { createStealthRuntime } from '../src';
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
    async run(_command, _args, options = {}) {
      const rawInput =
        typeof options.input === 'string'
          ? options.input
          : options.input instanceof Buffer
            ? options.input.toString()
            : '{}';
      let action = 'unknown';
      try {
        const parsed = JSON.parse(rawInput) as { action?: string };
        action = parsed.action ?? 'unknown';
      } catch {
        action = 'unknown';
      }
      const payload = buildPythonResponse(action);
      return {
        code: 0,
        stdout: JSON.stringify(payload),
        stderr: ''
      };
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
      scriptPath: path.join(workspaceRoot, 'bridge.py'),
      getWorkingDirectory: () => workspaceRoot,
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

function buildPythonResponse(action: string): Record<string, unknown> {
  if (action === 'diffText') {
    return { status: 'SUCCESS', data: { diff: '' } };
  }
  return { status: 'SUCCESS', data: {} };
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
});

export interface IFsAdapter {
  readText(absPath: string, encoding?: BufferEncoding): Promise<string>;
  writeText(absPath: string, content: string, encoding?: BufferEncoding): Promise<void>;
  exists(absPath: string): Promise<boolean>;
  listRecursive(root: string): Promise<string[]>;
  ensureDir(absPath: string): Promise<void>;
  readDir(absPath: string): Promise<string[]>;
  remove(absPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

export interface IShellAdapter {
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number; input?: string | Buffer }
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

import type { StatusPayload, LogPayload } from './statusTypes';
import type { AgentReport } from './types';
import type { PlanOptions, AgentPlan } from '@burtson-labs/agent-core';

export interface ITelemetry {
  status(payload: StatusPayload): Promise<void>;
  log(payload: LogPayload): Promise<void>;
  event(kind: string, data?: Record<string, unknown>): Promise<void>;
}

export interface StealthHostBindings {
  env: {
    getRunContext(): unknown;
    resolvePlanRunDirectory(workspaceRoot: string): string;
    postMessage?(message: unknown): Promise<void> | void;
    saveReport?(report: AgentReport): Promise<void>;
  };

  fs: IFsAdapter;
  shell: IShellAdapter;
  telemetry: ITelemetry;

  ui: {
    showError(message: string, detail?: string): Promise<void>;
    showInfo(message: string, detail?: string): Promise<void>;
    promptInput(options: { title: string; prompt: string; value?: string }): Promise<string | undefined>;
  };

  config: {
    get<T = unknown>(key: string, defaultValue?: T): T | undefined;
  };

  secrets: {
    get(key: string): Promise<string | undefined>;
    set?(key: string, value: string): Promise<void>;
  };

  workspace: {
    getInitialWorkspaceRoot(): string;
    getLastWorkspaceRoot?(): string | undefined;
  };

  artifacts: {
    getStoragePath(): string | undefined;
    getGlobalStoragePath(): string | undefined;
  };

  python: {
    scriptPath: string;
    getWorkingDirectory(): string;
    ensure(): Promise<{ ok: boolean; version?: string; command?: string; error?: string }>;
    clearCache(): Promise<void> | void;
  };

  flags: {
    isDevelopmentMode(): boolean;
    shouldSkipValidationInDev(): boolean;
    isDryRunEnabled(): boolean;
  };

  planner: {
    createPlan(goal: string, options: PlanOptions): Promise<AgentPlan>;
  };
}

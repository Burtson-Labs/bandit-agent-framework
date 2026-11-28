import * as vscode from 'vscode';
import type { AgentRuntime as FrameworkAgentRuntime } from '@burtson-labs/agent-core';
import {
  createNodeFsAdapter,
  createShellAdapter,
  createStealthRuntime,
  createTelemetry,
  type AgentGoalOptions,
  type AgentReport,
  type IUndoManager,
  type ITelemetry,
  type Plan,
  type StealthHostBindings,
  type StealthRuntime
} from '@burtson-labs/stealth-core-runtime';
import { environmentService } from './environmentService';
import { ensurePython, clearPythonCache } from './pythonEnvironment';
import { StealthPlannerAgent } from './plannerAgent';

export type { FileChangeSnapshot, IUndoManager } from '@burtson-labs/stealth-core-runtime';

export class StealthAgentRuntime {
  private readonly plannerAgent = new StealthPlannerAgent();
  private readonly telemetry: ITelemetry;
  private readonly hostBindings: StealthHostBindings;
  private readonly runtime: StealthRuntime;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.telemetry = createTelemetry({
      post: (message) => environmentService.postToWebview(message)
    });

    this.hostBindings = this.createHostBindings();
    this.runtime = createStealthRuntime(this.hostBindings);
  }

  public cancel(): void {
    this.runtime.cancel();
  }

  public getFrameworkRuntime(): FrameworkAgentRuntime {
    return this.plannerAgent.getRuntime();
  }

  public getHostBindings(): StealthHostBindings {
    return this.hostBindings;
  }

  public getUndoManager(): IUndoManager {
    return this.runtime.getUndoManager();
  }

  public preparePlan(goal: string, options?: AgentGoalOptions): Promise<Plan> {
    return this.runtime.preparePlan(goal, options);
  }

  public executePlan(plan: Plan, goal: string, options?: AgentGoalOptions): Promise<AgentReport> {
    return this.runtime.executePlan(plan, goal, options);
  }

  public startGoal(goal: string, options?: AgentGoalOptions): Promise<AgentReport> {
    return this.runtime.startGoal(goal, options);
  }

  public replayStep(stepId: string, mode: 'replay' | 'refine'): Promise<void> {
    return this.runtime.replayStep(stepId, mode);
  }

  private createHostBindings(): StealthHostBindings {
    const fsAdapter = createNodeFsAdapter(this.requireWorkspaceRoot());
    const shellAdapter = createShellAdapter();
    const getBanditConfiguration = () => vscode.workspace.getConfiguration('banditStealth');

    return {
      env: {
        getRunContext: () => environmentService.getRunContext(),
        resolvePlanRunDirectory: (workspaceRoot) => environmentService.resolvePlanRunDirectory(workspaceRoot),
        postMessage: (message) => environmentService.postToWebview(message),
        saveReport: (report) => environmentService.saveReport(report)
      },
      fs: fsAdapter,
      shell: shellAdapter,
      telemetry: this.telemetry,
      ui: {
        showError: async (message, detail) => {
          const text = detail ? `${message}\n\n${detail}` : message;
          await vscode.window.showErrorMessage(text);
        },
        showInfo: async (message, detail) => {
          const text = detail ? `${message}\n\n${detail}` : message;
          await vscode.window.showInformationMessage(text);
        },
        promptInput: (options) =>
          Promise.resolve(
            vscode.window.showInputBox({
              title: options.title,
              prompt: options.prompt,
              value: options.value
            })
          )
      },
      config: {
        get: <T,>(key: string, defaultValue?: T) =>
          getBanditConfiguration().get<T | undefined>(key, defaultValue)
      },
      secrets: {
        get: (key) => Promise.resolve(this.context.secrets.get(key)),
        set: (key, value) => Promise.resolve(this.context.secrets.store(key, value))
      },
      workspace: {
        getInitialWorkspaceRoot: () => this.requireWorkspaceRoot()
      },
      artifacts: {
        getStoragePath: () => this.context.storageUri?.fsPath,
        getGlobalStoragePath: () => this.context.globalStorageUri?.fsPath
      },
      // Plan file actions run in-process in stealth-core-runtime. Python is
      // only detected (silently) to syntax-check .py files the agent writes;
      // when it is missing that check is skipped.
      python: {
        ensure: () => this.detectPython(),
        clearCache: async () => {
          clearPythonCache();
        }
      },
      flags: {
        isDevelopmentMode: () => this.context.extensionMode === vscode.ExtensionMode.Development,
        shouldSkipValidationInDev: () =>
          getBanditConfiguration().get<boolean>('agent.skipValidationInDev', false) === true,
        isDryRunEnabled: () => getBanditConfiguration().get<boolean>('agent.dryRun', false) === true
      },
      planner: {
        createPlan: (goal, options) => this.plannerAgent.createPlan(goal, options)
      }
    };
  }

  private async detectPython(force = false): Promise<{
    ok: boolean;
    version?: string;
    command?: string;
    error?: string;
  }> {
    const result = await ensurePython({ force });
    if (result.info) {
      return {
        ok: true,
        version: result.info.version,
        command: result.info.command
      };
    }
    return {
      ok: false,
      error: result.error ?? 'Python runtime not detected.'
    };
  }

  private requireWorkspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      throw new Error('Agent mode requires an open workspace folder.');
    }
    return folder;
  }
}

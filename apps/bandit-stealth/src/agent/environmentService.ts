import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import type { AgentReport } from '@burtson-labs/stealth-core-runtime';

interface RunContext {
  conversationId?: string;
  conversationName?: string;
  runId?: string;
}

let webview: vscode.Webview | undefined;
const listeners = new Set<(message: unknown) => void>();
let runContext: RunContext | undefined;

function sanitizeSegment(input: string, fallback: string): string {
  const normalized = input.replace(/[^a-z0-9._-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return normalized.length > 0 ? normalized.slice(0, 100) : fallback;
}

function ensureBanditDirectory(workspaceRoot: string): void {
  const folder = path.join(workspaceRoot, '.bandit');
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
  }
}

export const environmentService = {
  setWebview(view: vscode.Webview): void {
    webview = view;
  },

  async postToWebview(message: unknown): Promise<void> {
    webview?.postMessage(message);
    for (const listener of listeners) {
      try {
        listener(message);
      } catch (error) {
        console.warn('Agent environment listener failed', error);
      }
    }
  },

  subscribe(listener: (message: unknown) => void): vscode.Disposable {
    listeners.add(listener);
    return {
      dispose: () => {
        listeners.delete(listener);
      }
    };
  },

  async saveReport(report: AgentReport): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('banditStealth');
    const emitArtifacts = configuration.get<boolean>('debug.emitPlanJson', true);
    if (!emitArtifacts) {
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      return;
    }

    ensureBanditDirectory(workspaceFolder);
    const latestFile = path.join(workspaceFolder, '.bandit', 'agent-report.json');
    await fsp.writeFile(latestFile, JSON.stringify(report, null, 2), 'utf8');

    const planFolder = this.resolvePlanRunDirectory(workspaceFolder);
    await fsp.mkdir(planFolder, { recursive: true });
    const conversationSegment = runContext?.conversationId
      ? sanitizeSegment(runContext.conversationId, 'conversation')
      : 'conversation';
    const runSegment = runContext?.runId
      ? sanitizeSegment(runContext.runId, 'run')
      : 'run';
    const payload = {
      conversationId: runContext?.conversationId ?? null,
      conversationName: runContext?.conversationName ?? null,
      runId: runContext?.runId ?? null,
      artifactsPath: ['plans', conversationSegment, runSegment].join('/'),
      report
    };
    await fsp.writeFile(path.join(planFolder, 'report.json'), JSON.stringify(payload, null, 2), 'utf8');
  },

  setRunContext(context?: RunContext): void {
    if (!context) {
      runContext = undefined;
      return;
    }
    runContext = { ...runContext, ...context };
    if (runContext.runId === undefined) {
      delete runContext.runId;
    }
    if (runContext.conversationId === undefined) {
      delete runContext.conversationId;
    }
    if (runContext.conversationName === undefined) {
      delete runContext.conversationName;
    }
  },

  getRunContext(): RunContext | undefined {
    return runContext ? { ...runContext } : undefined;
  },

  resolvePlanRunDirectory(workspaceRoot: string): string {
    const base = path.join(workspaceRoot, '.bandit', 'plans');
    if (!runContext?.runId) {
      const fallback = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      runContext = { ...runContext, runId: fallback };
    }
    const conversationSegment = runContext?.conversationId
      ? sanitizeSegment(runContext.conversationId, 'conversation')
      : 'conversation';
    const runSegment = runContext?.runId
      ? sanitizeSegment(runContext.runId, 'run')
      : 'run';
    return path.join(base, conversationSegment, runSegment);
  }
};

import { Buffer } from "buffer";
import type {
  AgentRuntime,
  AgentPlan,
  AgentReport,
  AgentExecutionResult,
  PlanOptions,
  ExecuteOptions,
  AgentEvent,
  CreateAgentRuntimeOptions
} from "@burtson-labs/agent-core";
import {
  createAgentRuntime
} from "@burtson-labs/agent-core";

export interface VscodeLike {
  workspace: {
    fs: {
      readFile(uri: unknown): Uint8Array | PromiseLike<Uint8Array>;
      writeFile(uri: unknown, content: Uint8Array): void | PromiseLike<void>;
    };
  };
  Uri: {
    file(path: string): unknown;
  };
  window?: {
    showInformationMessage?(message: string): void;
  };
  postMessage?: (payload: unknown) => void;
}

export interface VscodeAdapterFs {
  read(path: string): Promise<Uint8Array>;
  write(path: string, content: string | Uint8Array): Promise<void>;
}

export interface VscodeAdapter {
  runtime: AgentRuntime;
  activate(): void;
  dispose(): void;
  fs: VscodeAdapterFs;
  log(message: string): void;
  plan(goal: string, options?: PlanOptions): Promise<AgentPlan>;
  execute(options?: ExecuteOptions): Promise<AgentExecutionResult[]>;
  report(metadata?: Record<string, unknown>): Promise<AgentReport>;
  on(event: string, listener: (event: AgentEvent) => void): void;
  off(event: string, listener: (event: AgentEvent) => void): void;
}

export type VscodeAdapterOptions = CreateAgentRuntimeOptions;

export const createVscodeAdapter = (vscode: VscodeLike, options: VscodeAdapterOptions = {}): VscodeAdapter => {
  const runtime = createAgentRuntime(options);
  let activated = false;

  const fs: VscodeAdapterFs = {
    read: async (path: string) => {
      ensureActivated();
      const uri = vscode.Uri.file(path);
      const data = await Promise.resolve(vscode.workspace.fs.readFile(uri));
      return data;
    },
    write: async (path: string, content: string | Uint8Array) => {
      ensureActivated();
      const uri = vscode.Uri.file(path);
      const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      await Promise.resolve(vscode.workspace.fs.writeFile(uri, buffer));
    }
  };

  const log = (message: string): void => {
    if (vscode.window?.showInformationMessage) {
      vscode.window.showInformationMessage(message);
    }
  };

  const ensureActivated = () => {
    if (!activated) {
      throw new Error("VS Code adapter must be activated before invoking workspace APIs.");
    }
  };

  const relayEvent = (event: AgentEvent): void => {
    if (typeof vscode.postMessage === "function") {
      vscode.postMessage({ type: event.type, payload: event.payload, timestamp: event.timestamp });
    }
  };

  const on = (event: string, listener: (evt: AgentEvent) => void): void => {
    runtime.on(event, listener);
  };

  const off = (event: string, listener: (evt: AgentEvent) => void): void => {
    runtime.off(event, listener);
  };

  runtime.on("plan:complete", relayEvent);
  runtime.on("step:complete", relayEvent);
  runtime.on("diff:apply", relayEvent);
  runtime.on("report:complete", relayEvent);

  return {
    runtime,
    fs,
    log,
    on,
    off,
    activate: () => {
      activated = true;
      runtime.emit("adapter:activated", {
        type: "adapter:activated",
        payload: { adapter: "vscode" },
        timestamp: Date.now()
      });
    },
    dispose: () => {
      activated = false;
      runtime.removeListener("plan:complete", relayEvent);
      runtime.removeListener("step:complete", relayEvent);
      runtime.removeListener("diff:apply", relayEvent);
      runtime.removeListener("report:complete", relayEvent);
    },
    plan: (goal: string, planOptions?: PlanOptions) => runtime.plan(goal, planOptions),
    execute: (executeOptions?: ExecuteOptions) => runtime.execute(executeOptions),
    report: (metadata?: Record<string, unknown>) => runtime.report(metadata)
  };
};

export const makeVsCodeAdapter = createVscodeAdapter;

import { Buffer } from "buffer";
import type { VscodeLike } from "@burtson-labs/agent-adapters-vscode";
import { createVscodeAdapter } from "@burtson-labs/agent-adapters-vscode";

const mockFs = new Map<string, Uint8Array>();

const fakeVsCode: VscodeLike = {
  workspace: {
    fs: {
      readFile: async (uri: { fsPath: string }) => mockFs.get(uri.fsPath) ?? Buffer.from("", "utf8"),
      writeFile: async (uri: { fsPath: string }, content: Uint8Array) => {
        mockFs.set(uri.fsPath, content);
      }
    }
  },
  Uri: {
    file: (path: string) => ({ fsPath: path })
  },
  window: {
    showInformationMessage: (message: string) => {
      console.log(`[VSCode Adapter] ${message}`);
    }
  },
  postMessage: (payload: unknown) => {
    console.log("[VSCode Adapter] Event:", payload);
  }
};

const adapter = createVscodeAdapter(fakeVsCode);

export const activate = () => {
  adapter.activate();
  adapter.log("VS Code demo activated.");
};

export const runGoal = async (goal: string) => {
  await adapter.plan(goal);
  await adapter.execute();
  const report = await adapter.report();
  return report.summary;
};

if (require.main === module) {
  activate();
  runGoal("Explain how the VS Code adapter bridges the runtime.").then((summary) => {
    console.log(summary);
  });
}

/**
 * Shared test helpers for host-kit tests.
 */
import type { ToolExecutionContext, AgentTool, ToolResult, ChatFn } from '@burtson-labs/agent-core';

export const testCtx: ToolExecutionContext = {
  workspaceRoot: '/tmp/test',
  async readFile() { return ''; },
  async writeFile() { return; },
  async listFiles() { return []; },
  async searchCode() { return ''; },
  async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
};

/** Build a chat function that responds in a scripted sequence. */
export function buildScriptedChat(responder: (turn: number) => string | string[]): {
  chat: ChatFn;
  callCount: () => number;
  capturedSystemPrompts: string[];
  capturedToolsArg: Array<unknown>;
} {
  let count = 0;
  const capturedSystemPrompts: string[] = [];
  const capturedToolsArg: Array<unknown> = [];
  const chat: ChatFn = async function* (messages, tools) {
    count += 1;
    capturedSystemPrompts.push(
      messages.find((m) => m.role === 'system')?.content ?? ''
    );
    capturedToolsArg.push(tools);
    const out = responder(count);
    const chunks = Array.isArray(out) ? out : [out];
    for (const c of chunks) yield c;
  };
  return {
    chat,
    callCount: () => count,
    capturedSystemPrompts,
    capturedToolsArg
  };
}

/** Build a no-op tool that records each invocation. */
export function buildRecordingTool(name: string, captured: { calls: number }): AgentTool {
  return {
    name,
    description: `recording ${name}`,
    parameters: [],
    async execute(): Promise<ToolResult> {
      captured.calls += 1;
      return { output: `${name} ran (call ${captured.calls})` };
    }
  };
}

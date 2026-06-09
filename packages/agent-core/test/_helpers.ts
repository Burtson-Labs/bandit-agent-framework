/**
 * Shared test helpers for agent-core tests.
 *
 * Built minimal on purpose — every test writes a tiny chat function
 * that yields preset chunks, registers a tiny tool, and asserts on
 * the result + the captured emit events. No global state, no
 * cross-test fixtures, so test failures point at one cause not five.
 */
import type { ToolExecutionContext, AgentTool, ToolResult } from '../src/index';

/**
 * Minimal ToolExecutionContext for tests. Methods return inert
 * defaults; tests register their own tools when they need behavior.
 */
export const testCtx: ToolExecutionContext = {
  workspaceRoot: '/tmp/test',
  async readFile() { return ''; },
  async writeFile() { return; },
  async listFiles() { return []; },
  async searchCode() { return ''; },
  async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
};

/** Yield a sequence of preset string chunks as one chat() call. */
export async function* yieldChunks(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

/**
 * Mock chat function whose response per turn is determined by a
 * caller-supplied responder. Captures every call's messages, options,
 * and tools so tests can assert on what the loop actually sent.
 */
export interface MockChatRecorder {
  callCount: number;
  calls: Array<{
    messages: ReadonlyArray<{ role: string; content: string }>;
    tools?: unknown;
    options?: { think?: boolean };
  }>;
}

export function buildMockChat(
  responder: (turn: number, recorder: MockChatRecorder) => string[] | string
): {
  chat: (
    messages: ReadonlyArray<{ role: string; content: string }>,
    tools?: unknown,
    options?: { think?: boolean }
  ) => AsyncIterable<string>;
  recorder: MockChatRecorder;
} {
  const recorder: MockChatRecorder = { callCount: 0, calls: [] };
  return {
    recorder,
    chat: function (messages, tools, options) {
      recorder.callCount += 1;
      recorder.calls.push({ messages, tools, options });
      const result = responder(recorder.callCount, recorder);
      const chunks = Array.isArray(result) ? result : [result];
      return yieldChunks(chunks);
    }
  };
}

/** Build a tiny `read_file` mock that captures invocations. */
export function buildReadFileTool(
  captured: { paths: string[] },
  output = (path: string) => `mock contents of ${path}`
): AgentTool {
  return {
    name: 'read_file',
    description: 'Read a file from the workspace.',
    parameters: [{ name: 'path', description: 'File path', required: true }],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      const path = params.path ?? '';
      captured.paths.push(path);
      return { output: output(path) };
    }
  };
}

/** Build a tiny `noop` tool with controlled output. */
export function buildNoopTool(name: string, output = 'ok'): AgentTool {
  return {
    name,
    description: `noop ${name}`,
    parameters: [],
    async execute(): Promise<ToolResult> {
      return { output };
    }
  };
}

/**
 * Capture every emit event the loop produces. Tests can then
 * assert on the names + payload shape that fired.
 */
export function buildEmitRecorder(): {
  events: Array<{ type: string; payload: unknown }>;
  emit: (type: string, payload?: unknown) => void;
} {
  const events: Array<{ type: string; payload: unknown }> = [];
  return {
    events,
    emit: (type, payload) => events.push({ type, payload })
  };
}

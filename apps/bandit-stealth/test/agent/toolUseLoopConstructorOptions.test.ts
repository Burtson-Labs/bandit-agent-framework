import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { ToolRegistry, ToolUseLoop } = require('@burtson-labs/agent-core');

type ToolResult = { output: string; isError?: boolean };
type ToolParam = { name: string; description: string; required?: boolean };
type AgentTool = {
  name: string;
  description: string;
  parameters: ToolParam[];
  execute(params: Record<string, string>): Promise<ToolResult>;
};

const ctx = {
  workspaceRoot: '/tmp',
  async readFile() { return ''; },
  async writeFile() { /* no-op */ },
  async listFiles() { return []; },
  async searchCode() { return ''; },
  async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
};

async function* yieldChunks(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

function makeReadTool(captured: { paths: string[] }): AgentTool {
  return {
    name: 'read_file',
    description: 'Read a file from the workspace.',
    parameters: [{ name: 'path', description: 'File path', required: true }],
    async execute(params) {
      captured.paths.push(params.path);
      return { output: `contents of ${params.path}` };
    }
  };
}

describe('ToolUseLoop constructor options', () => {
  it('honors constructor-level isSubagent when run() has no per-call option', async () => {
    const registry = new ToolRegistry();
    const captured = { paths: [] as string[] };
    registry.register(makeReadTool(captured));

    const events: Array<{ type: string; payload: unknown }> = [];
    const loop = new ToolUseLoop(registry, ctx, {
      isSubagent: true,
      emitEvent: (type: string, payload: unknown) => events.push({ type, payload })
    });

    let turn = 0;
    const chat = () => {
      turn++;
      if (turn === 1) {
        return yieldChunks(['This requires repository inspection before I can answer.']);
      }
      if (turn === 2) {
        return yieldChunks([
          '<tool_call>{"name":"read_file","params":{"path":"package.json"}}</tool_call>'
        ]);
      }
      return yieldChunks(['I read package.json and found the project metadata.']);
    };

    const result = await loop.run('analyze the repository', chat);

    expect(events.some(e => e.type === 'tool_loop:subagent_first_iter_no_tool_call')).toBe(true);
    expect(captured.paths).toEqual(['package.json']);
    expect(result.finalResponse).toContain('project metadata');
  });

  it('honors constructor-level nativeTools and forwards schemas to chat()', async () => {
    const registry = new ToolRegistry();
    registry.register(makeReadTool({ paths: [] }));

    const loop = new ToolUseLoop(registry, ctx, { nativeTools: true });

    let seenTools: unknown[] | undefined;
    let seenSystemPrompt = '';
    const chat = (messages: Array<{ role: string; content: string }>, tools?: unknown[]) => {
      seenTools = tools;
      seenSystemPrompt = messages.find(m => m.role === 'system')?.content ?? '';
      return yieldChunks(['No tool needed for this assertion.']);
    };

    await loop.run('say hello', chat, 'base prompt');

    expect(seenTools).toHaveLength(1);
    expect(seenSystemPrompt).toBe('base prompt');
    expect(seenSystemPrompt).not.toContain('## Available Tools');
  });
});

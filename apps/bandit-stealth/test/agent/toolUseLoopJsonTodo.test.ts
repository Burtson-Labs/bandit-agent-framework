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

function makeTodoTool(captured: { items?: string }) {
  const tool: AgentTool = {
    name: 'todo_write',
    description: 'Write or update the current todo list.',
    parameters: [{ name: 'items', description: 'JSON array of todos', required: true }],
    async execute(params) {
      captured.items = params.items;
      return { output: 'todo list updated' };
    }
  };
  return tool;
}

async function* yieldChunks(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

describe('ToolUseLoop JSON-todo auto-promote', () => {
  it('synthesizes a todo_write call when the model pastes a JSON todo list', async () => {
    const registry = new ToolRegistry();
    const captured: { items?: string } = {};
    registry.register(makeTodoTool(captured));

    // Minimal execution context — the synthetic todo_write call only uses
    // the tool itself, never the host context methods.
    const ctx = {
      workspaceRoot: '/tmp',
      async readFile() { return ''; },
      async writeFile() { /* no-op */ },
      async listFiles() { return []; },
      async searchCode() { return ''; },
      async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
    };

    const loop = new ToolUseLoop(registry, ctx);

    const jsonTodoResponse = [
      'Here is my plan:',
      '',
      '```json',
      JSON.stringify(
        [
          { content: 'Read the controller', status: 'pending' },
          { content: 'Apply the fix', status: 'pending' }
        ],
        null,
        2
      ),
      '```',
      '',
      'I will execute it next.'
    ].join('\n');

    // First call: model emits JSON-fenced todo (no tool call). After the
    // loop auto-promotes + nudges, the model returns a plain final answer.
    let turn = 0;
    const chat = (_messages: unknown) => {
      turn++;
      return turn === 1
        ? yieldChunks([jsonTodoResponse])
        : yieldChunks(['Done planning — task complete.']);
    };

    const events: Array<{ type: string; payload: unknown }> = [];
    const result = await loop.run('plan this work', chat, undefined, {
      emitEvent: (type: string, payload: unknown) => events.push({ type, payload })
    });

    // Detector fired exactly once.
    const autoPromoted = events.filter(e => e.type === 'tool_loop:json_todo_auto_promoted');
    expect(autoPromoted).toHaveLength(1);
    expect((autoPromoted[0].payload as { itemCount: number }).itemCount).toBe(2);

    // The synthesized todo_write actually executed with the parsed items.
    expect(captured.items).toBeDefined();
    const parsed = JSON.parse(captured.items ?? '[]') as Array<{ content: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0].content).toBe('Read the controller');

    // Loop terminated on the second turn's plain-prose response.
    expect(result.finalResponse).toContain('Done planning');
    expect(result.hitLimit).toBe(false);
  });

  it('does not promote a non-todo JSON array', async () => {
    const registry = new ToolRegistry();
    const captured: { items?: string } = {};
    registry.register(makeTodoTool(captured));

    const ctx = {
      workspaceRoot: '/tmp',
      async readFile() { return ''; },
      async writeFile() { /* no-op */ },
      async listFiles() { return []; },
      async searchCode() { return ''; },
      async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
    };

    const loop = new ToolUseLoop(registry, ctx);

    // Shape-mismatched JSON — array of items with `name` but no `content`.
    // Detector must NOT fire.
    const response = [
      'Here is some config data:',
      '',
      '```json',
      JSON.stringify([{ name: 'foo', value: 1 }, { name: 'bar', value: 2 }]),
      '```'
    ].join('\n');

    const chat = (_messages: unknown) => yieldChunks([response]);

    const events: Array<{ type: string; payload: unknown }> = [];
    await loop.run('show config', chat, undefined, {
      emitEvent: (type: string, payload: unknown) => events.push({ type, payload })
    });

    expect(events.some(e => e.type === 'tool_loop:json_todo_auto_promoted')).toBe(false);
    expect(captured.items).toBeUndefined();
  });
});

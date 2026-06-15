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

function makeReadTool(captured: { paths: string[] }) {
  const tool: AgentTool = {
    name: 'read_file',
    description: 'Read a file from the workspace.',
    parameters: [{ name: 'path', description: 'File path', required: true }],
    async execute(params) {
      captured.paths.push(params.path);
      return { output: `// stub contents of ${params.path}` };
    }
  };
  return tool;
}

async function* yieldChunks(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

const ctx = {
  workspaceRoot: '/tmp',
  async readFile() { return ''; },
  async writeFile() { /* no-op */ },
  async listFiles() { return []; },
  async searchCode() { return ''; },
  async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
};

/**
 * Helper: run the loop until the iteration cap fires the wrap-up nudge,
 * then capture the wrap-up message that landed in the conversation.
 * The model's stub keeps emitting a single read_file call each iteration
 * so the loop runs to maxIterations and the wrap-up nudge appends.
 */
async function runUntilWrapUp(userGoal: string): Promise<string> {
  const registry = new ToolRegistry();
  registry.register(makeReadTool({ paths: [] }));
  const loop = new ToolUseLoop(registry, ctx);
  const chat = (_messages: unknown) => yieldChunks([
    '<tool_call>{"name":"read_file","params":{"path":"src/foo.ts"}}</tool_call>'
  ]);
  const result = await loop.run(userGoal, chat, undefined, { maxIterations: 2 });
  // Find the wrap-up message — it's a user message that mentions "limit"
  // and contains either a "**Findings**" or "**Shipped**" header.
  const wrapUp = result.messages.find((m: { role: string; content: string }) =>
    m.role === 'user'
    && (m.content.includes('iteration limit') || m.content.includes('per-turn cap'))
    && (m.content.includes('**Findings**') || m.content.includes('**Shipped**'))
  ) as { content: string } | undefined;
  return wrapUp?.content ?? '';
}

describe('wrap-up template picker', () => {
  it('uses Findings/Evidence/Gaps for analysis-shaped goals', async () => {
    const wrapUp = await runUntilWrapUp(
      'I want you to do a deep self evaluation of this repo and tell me what is keeping you from being a better agent'
    );
    expect(wrapUp).toContain('**Findings**');
    expect(wrapUp).toContain('**Evidence**');
    expect(wrapUp).toContain("didn't get to");
    expect(wrapUp).not.toContain('**Shipped**');
  });

  it('uses Shipped/Partway/Blocked for edit-shaped goals', async () => {
    const wrapUp = await runUntilWrapUp(
      'fix the bug in packages/agent-core/src/tools/tool-use-loop.ts where the spinner does not clear'
    );
    expect(wrapUp).toContain('**Shipped**');
    expect(wrapUp).toContain('**Partway**');
    expect(wrapUp).toContain('**Blocked / not attempted**');
    expect(wrapUp).not.toContain('**Findings**');
  });

  it('always leads the wrap-up with the original user goal', async () => {
    const goal = 'review the auth flow and explain how tokens get refreshed';
    const wrapUp = await runUntilWrapUp(goal);
    // The automated-check marker leads (so small models don't narrate
    // the wrap-up as user feedback), with the goal-recall block
    // immediately after — still the first substantive content.
    expect(wrapUp.startsWith('AUTOMATED HARNESS CHECK')).toBe(true);
    expect(wrapUp).toContain('## ORIGINAL USER GOAL');
    // Includes the literal goal text.
    expect(wrapUp).toContain(goal);
  });
});

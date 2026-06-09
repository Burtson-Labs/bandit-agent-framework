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

describe('ToolUseLoop announce-then-stall nudge', () => {
  it('nudges and continues when the model announces intent without a tool call', async () => {
    const registry = new ToolRegistry();
    const captured = { paths: [] as string[] };
    registry.register(makeReadTool(captured));

    const loop = new ToolUseLoop(registry, ctx);

    // Turn 1: model "announces" what it's about to do but emits no tool
    // call. The verbs ("dig", "drill", etc.) are deliberately chosen to
    // sit outside the upstream narrate-detector verb whitelist — this
    // exercise the terminal-block detector specifically. Mirrors the real
    // 2026-05-05 trace where the model said "Let me dig deeper into the
    // core architecture" with no tool call and the runtime exited.
    // Turn 2: model takes the announced action.
    let turn = 0;
    const chat = (_messages: unknown) => {
      turn++;
      if (turn === 1) {
        return yieldChunks([
          '```bandit-reasoning\nThinking about what to inspect next.\n```\n',
          'Let me dig deeper into the core architecture - the planner, tool definitions, auto-healer, and how I handle conversations.'
        ]);
      }
      if (turn === 2) {
        return yieldChunks([
          '<tool_call>{"name":"read_file","params":{"path":"src/planner.ts"}}</tool_call>'
        ]);
      }
      return yieldChunks(['Done — the planner orchestrates signal sources and emits a ranked plan.']);
    };

    const events: Array<{ type: string; payload: unknown }> = [];
    const result = await loop.run('audit the planner', chat, undefined, {
      emitEvent: (type: string, payload: unknown) => events.push({ type, payload })
    });

    const nudged = events.filter(e => e.type === 'tool_loop:announce_intent_nudge');
    expect(nudged).toHaveLength(1);

    // Loop must have continued past the announcement and actually invoked
    // the tool the model promised.
    expect(captured.paths).toEqual(['src/planner.ts']);
    expect(result.hitLimit).toBe(false);
  });

  it('does not fire on a complete prose final answer', async () => {
    const registry = new ToolRegistry();
    const captured = { paths: [] as string[] };
    registry.register(makeReadTool(captured));

    const loop = new ToolUseLoop(registry, ctx);

    // Long, conclusive prose answer. No forward-looking commitment, well
    // over the length cap. Detector must stay silent.
    const longAnswer = [
      'The planner module composes signal sources and emits a ranked plan.',
      'It reads embeddings, applies path hints, and prioritizes file reads.',
      'The bug we discussed in plannerService.ts was fixed by guarding the',
      'primaryPathHint overwrite with a deferPrimaryHint check. This is now',
      'covered by the prioritizeSignals tests and the regression suite.',
      'Nothing further is needed for this question.'
    ].join(' ');

    const chat = (_messages: unknown) => yieldChunks([longAnswer]);

    const events: Array<{ type: string; payload: unknown }> = [];
    const result = await loop.run('explain the planner fix', chat, undefined, {
      emitEvent: (type: string, payload: unknown) => events.push({ type, payload })
    });

    expect(events.some(e => e.type === 'tool_loop:announce_intent_nudge')).toBe(false);
    expect(result.finalResponse).toContain('planner module');
    expect(captured.paths).toEqual([]);
  });

  it('only fires once per turn (one-shot guard)', async () => {
    const registry = new ToolRegistry();
    const captured = { paths: [] as string[] };
    registry.register(makeReadTool(captured));

    const loop = new ToolUseLoop(registry, ctx);

    // Both turns announce intent without acting. After the first nudge
    // the detector must NOT re-fire on the second stall — instead the
    // loop terminates so the user can intervene. Verb "dig" is outside
    // the upstream narrate-detector whitelist so this exercises the
    // terminal-block detector and not the empty-retry path.
    const chat = (_messages: unknown) => yieldChunks([
      "Let me dig into the architecture before I answer."
    ]);

    const events: Array<{ type: string; payload: unknown }> = [];
    const result = await loop.run('analyze this', chat, undefined, {
      emitEvent: (type: string, payload: unknown) => events.push({ type, payload })
    });

    const nudged = events.filter(e => e.type === 'tool_loop:announce_intent_nudge');
    expect(nudged.length).toBeLessThanOrEqual(1);
    expect(result.hitLimit).toBe(false);
  });
});

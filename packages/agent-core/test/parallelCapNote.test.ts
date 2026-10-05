/**
 * When the per-reply cap cuts calls off, the model has to be told which ones did not run.
 *
 * BanditBench 2026-10-05, qwen3:14b on the default profile (one call per reply): it sent
 * two apply_edit calls for main.ts (the import and the call site). One ran. The note said
 * "Do not re-issue duplicates — instead, read the results above and pick a single
 * most-promising next action", and the model answered that the rename was done in both
 * files. refactor.multi_file failed 0/3 that way for qwen3:8b and qwen3:14b.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import type { AgentTool } from '../src/index';
import { buildEmitRecorder, buildMockChat, testCtx } from './_helpers';

const edit = (path: string, find: string): string =>
  `<tool_call>${JSON.stringify({ name: 'apply_edit', params: { path, find, replace: 'x' } })}</tool_call>`;

function editTool(ran: string[]): AgentTool {
  return {
    name: 'apply_edit',
    description: 'edit',
    parameters: [{ name: 'path', description: 'path', required: true }],
    async execute(params) {
      ran.push(`${params.path}:${params.find}`);
      return { output: `Replaced 1 occurrence in ${params.path}` };
    }
  };
}

async function runCapped(firstReply: string, cap: number) {
  const ran: string[] = [];
  const registry = new ToolRegistry();
  registry.register(editTool(ran));
  const { chat, recorder } = buildMockChat((turn) => (turn === 1 ? firstReply : 'Done.'));
  const { emit } = buildEmitRecorder();
  const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxParallelTools: cap });
  await loop.run('rename greet to sayHello in main.ts', chat);
  // The recorder holds the loop's live message list; pick the results turn out of it.
  const resultsMessage = recorder.calls[1].messages.find((m) => m.role === 'user' && m.content.includes('<tool_result'))?.content ?? '';
  return { ran, resultsMessage };
}

describe('per-reply cap note', () => {
  it('names the call that did not run and says it can be sent again', async () => {
    const { ran, resultsMessage } = await runCapped(`${edit('main.ts', 'import { greet }')}\n${edit('main.ts', 'greet("world")')}`, 1);
    expect(ran).toEqual(['main.ts:import { greet }']);
    expect(resultsMessage).toContain('you sent 2 tool calls in one reply; at most 1 runs per reply, so only the first 1 was executed');
    expect(resultsMessage).toContain('NOT executed: apply_edit(main.ts).');
    expect(resultsMessage).toContain('If you still need that call, send it again');
    expect(resultsMessage).not.toMatch(/re-issue duplicates|single most-promising/);
  });

  it('lists several cut calls, bounded', async () => {
    const batch = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((n) => edit(`${n}.ts`, n)).join('\n');
    const { ran, resultsMessage } = await runCapped(batch, 2);
    expect(ran).toHaveLength(2);
    expect(resultsMessage).toContain('you sent 10 tool calls in one reply; at most 2 run per reply, so only the first 2 were executed');
    expect(resultsMessage).toContain('NOT executed: apply_edit(c.ts), apply_edit(d.ts), apply_edit(e.ts), apply_edit(f.ts), apply_edit(g.ts), apply_edit(h.ts), and 2 more.');
    expect(resultsMessage).toContain('If you still need those calls, send them again (2 per reply)');
  });

  it('says nothing when the batch fits', async () => {
    const { ran, resultsMessage } = await runCapped(`${edit('a.ts', 'a')}\n${edit('b.ts', 'b')}`, 4);
    expect(ran).toHaveLength(2);
    expect(resultsMessage).not.toContain('[Note:');
  });
});

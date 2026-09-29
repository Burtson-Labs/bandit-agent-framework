import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import { testCtx, buildMockChat, buildReadFileTool, buildEmitRecorder } from './_helpers';

describe('parallel tool budgets', () => {
  async function run(maxIterations: number, maxTotalTools?: number) {
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool(captured));
    const { chat } = buildMockChat((turn) => turn <= 20
      ? Array.from({ length: 4 }, (_, i) => `<tool_call>${JSON.stringify({ name: 'read_file', params: { path: `file-${turn}-${i}.ts` } })}</tool_call>`).join('\n')
      : 'The architecture analysis is complete.');
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { maxIterations, maxTotalTools, emitEvent: emit });
    const result = await loop.run('Evaluate the architecture.', chat);
    return { captured, events, result };
  }

  it('lets a frontier-model turn complete more than 60 successful calls', async () => {
    const { captured, result } = await run(40);
    expect(captured.paths).toHaveLength(80);
    expect(result.hitLimit).toBe(false);
  });

  it('extends the derived tool budget along with productive iterations', async () => {
    const { captured, events, result } = await run(5);
    expect(captured.paths).toHaveLength(80);
    expect(result.hitLimit).toBe(false);
    expect(events.filter((e) => e.type === 'tool_loop:iteration_cap_extended')).toHaveLength(2);
  });

  it('never extends an explicitly configured tool cap', async () => {
    const { captured, events, result } = await run(5, 60);
    expect(captured.paths).toHaveLength(60);
    expect(result.hitLimit).toBe(true);
    expect(events.find((e) => e.type === 'tool_loop:total_tool_cap')?.payload).toMatchObject({ maxTotalTools: 60 });
  });
});

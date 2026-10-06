/**
 * A reply that is only a status line ("Reading the project structure to find package.json.")
 * is a stall, not a final answer.
 *
 * BanditBench edit.version_bump, gemma4:12b-it-qat, 2026-10-05: the whole run was the user's
 * "Bump the patch version in package.json." and that one line back, with no tool call. The
 * narrate gate needs an intent phrase ("I'll", "let me") and Gemma's status lines have none,
 * so the loop closed the turn with the line as the answer.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import type { AgentTool, ToolResult } from '../src/index';
import { testCtx, buildMockChat, buildEmitRecorder } from './_helpers';

function readFileTool(captured: { reads: number }): AgentTool {
  return {
    name: 'read_file',
    description: 'Read a file from disk.',
    parameters: [{ name: 'path', description: 'File path.', required: true }],
    async execute(): Promise<ToolResult> {
      captured.reads += 1;
      return { output: '{ "version": "1.2.3" }' };
    }
  };
}

async function runWith(replies: string[]) {
  const captured = { reads: 0 };
  const registry = new ToolRegistry();
  registry.register(readFileTool(captured));
  let turn = 0;
  const { chat } = buildMockChat(() => replies[Math.min(turn++, replies.length - 1)]);
  const { events, emit } = buildEmitRecorder();
  const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });
  const result = await loop.run('Bump the patch version in package.json.', chat);
  const nudges = events.filter(
    (e) => e.type === 'tool_loop:empty_retry' && (e.payload as { narratedButNoAction?: boolean }).narratedButNoAction
  );
  return { result, nudges, captured };
}

describe('status line with no tool call', () => {
  it('nudges instead of ending the turn on the line from the trace', async () => {
    const { result, nudges, captured } = await runWith([
      'Reading the project structure to find package.json.',
      '<tool_call>{"name":"read_file","params":{"path":"package.json"}}</tool_call>',
      'The version is 1.2.3.'
    ]);
    expect(nudges).toHaveLength(1);
    expect(captured.reads).toBe(1);
    expect(result.finalResponse).toContain('1.2.3');
  });

  it('also for a status line with a code span ("Updating `src/x.ts` to add …")', async () => {
    const { nudges } = await runWith([
      'Updating `src/utils/scoring.ts` to add detailed "why" comments for each scoring branch.',
      'Done.'
    ]);
    expect(nudges).toHaveLength(1);
  });

  it('does not fire on an answer that starts with an -ing word and goes on', async () => {
    const { nudges, result } = await runWith([
      'Reading package.json shows the version is already 1.2.4. Nothing to change.'
    ]);
    expect(nudges).toHaveLength(0);
    expect(result.finalResponse).toContain('Nothing to change');
  });

  it('does not fire on a one-line answer that does not open with an action verb', async () => {
    const { nudges } = await runWith(['Nothing in package.json needs a bump; it is a private package.']);
    expect(nudges).toHaveLength(0);
  });

  it('does not fire on a one-line past-tense summary', async () => {
    const { nudges } = await runWith(['Bumped the patch version in package.json to 1.2.4.']);
    expect(nudges).toHaveLength(0);
  });
});

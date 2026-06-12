/**
 * Detector contract: narrated-tool-call stall.
 *
 * Replays the 2026-06-12 Portfolio CLI failure (gemma4:e4b): the model
 * emits a LONG reasoning recap that ends with a performative prose call
 * — "I call read_file with path=README.md" — and no tool_call envelope.
 * The generic narrate gate misses it (over its 240-char cap; intent list
 * has no present-tense "I call"), so before this detector the loop
 * accepted the narration as a final answer and the turn died.
 *
 * Contract: when the tail of a no-tool-call response names a REGISTERED
 * tool in a performative phrase, the loop nudges (tool_loop:empty_retry
 * with narratedToolCallNoAction) instead of terminating. Unregistered
 * names must NOT fire — the tool-name anchor is the false-positive guard.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import type { AgentTool, ToolResult } from '../src/index';
import { testCtx, buildMockChat, buildEmitRecorder } from './_helpers';

function buildReadFileTool(captured: { reads: number }): AgentTool {
  return {
    name: 'read_file',
    description: 'Read a file from disk.',
    parameters: [
      { name: 'path', description: 'File path.', required: true }
    ],
    async execute(): Promise<ToolResult> {
      captured.reads += 1;
      return { output: '# Portfolio\nA personal site.' };
    }
  };
}

const LONG_RECAP =
  'The user wants an overview of the repository, a to-do list, and a markdown summary. ' +
  'I have run ls and see common web development files: README.md likely contains initial project info, ' +
  'package.json defines dependencies and scripts, src contains source code, public contains static assets, ' +
  'and vite.config.ts plus tsconfig.json configure the build. Next I should read the README and the manifest ' +
  'to understand the stack and synthesize the final answer with all three requested sections. ' +
  'I call read_file with path=README.md';

describe('narrated-tool-call detector (narratedToolCallNoAction)', () => {
  it('nudges instead of terminating when a long recap ends with "I call <registered tool>"', async () => {
    const captured = { reads: 0 };
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {return LONG_RECAP;}
      if (turn === 2) {return '<tool_call>{"name":"read_file","params":{"path":"README.md"}}</tool_call>';}
      return 'This repo is a Vite personal portfolio site.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });

    const result = await loop.run('tell me about this repo', chat);

    const nudges = events.filter(
      (e) => e.type === 'tool_loop:empty_retry'
        && (e.payload as { narratedToolCallNoAction?: boolean }).narratedToolCallNoAction
    );
    expect(nudges.length).toBe(1);
    expect(captured.reads).toBe(1);
    expect(result.finalResponse).toContain('portfolio');
  });

  it('does NOT fire when the narrated name is not a registered tool', async () => {
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool({ reads: 0 }));
    const { chat } = buildMockChat(() =>
      'The build pipeline is straightforward. For deeper analysis I call sonarqube with the default profile.');
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('how does CI work here', chat);

    const fires = events.filter(
      (e) => e.type === 'tool_loop:empty_retry'
        && (e.payload as { narratedToolCallNoAction?: boolean }).narratedToolCallNoAction
    );
    expect(fires.length).toBe(0);
  });

  it('does NOT fire on a normal final answer that mentions a tool name non-performatively', async () => {
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool({ reads: 0 }));
    const { chat } = buildMockChat(() =>
      'This repo is a Vite app. You can inspect any file yourself — the read_file tool I used earlier showed the README is minimal.');
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('tell me about this repo', chat);

    const fires = events.filter(
      (e) => e.type === 'tool_loop:empty_retry'
        && (e.payload as { narratedToolCallNoAction?: boolean }).narratedToolCallNoAction
    );
    expect(fires.length).toBe(0);
  });
});

/**
 * A bare `<tool_call>` at the end of a finished answer is not a malformed tool call.
 *
 * BanditBench 2026-10-05, qwen3-coder:30b on Ollama's native tool path: after a successful
 * apply_edit the model answered "…No additional steps are needed.<tool_call>" and stopped.
 * The loop treated the leaked opener as a call that failed to parse, asked for it again,
 * and the model re-read and re-edited the file it had already fixed until the fixture's
 * iteration cap failed the run (edit.json_setting_change, 2 of 3 runs).
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import { stripDanglingToolCallOpener } from '../src/tools/tool-use-parser';
import { buildEmitRecorder, buildMockChat, buildReadFileTool, testCtx } from './_helpers';

const CALL = '<tool_call>{"name":"read_file","params":{"path":"config/features.json"}}</tool_call>';

describe('stripDanglingToolCallOpener', () => {
  it('removes the opener when a reply ends with it', () => {
    expect(stripDanglingToolCallOpener('No additional steps are needed.<tool_call>')).toBe('No additional steps are needed.');
    expect(stripDanglingToolCallOpener('Done.\n\n<tool_call>\n')).toBe('Done.');
  });

  it('leaves everything else alone', () => {
    for (const text of [
      'No tools needed here.',
      '<tool_call>',                                            // nothing was said: still a stall
      '  <tool_call>  ',
      CALL,
      `Reading it.\n${CALL}`,
      `${CALL}\n<tool_call>`,                                   // a complete call is present
      'Updating.\n<tool_call>{"name":"apply_edit","params":{"path":"a.ts","find":"x', // truncated body
      'The loop wraps calls in <tool_call> tags, like this.',   // prose that mentions the tag
      '```tool_call\n{"name":"read_file"}\n```\n<tool_call>'
    ]) {
      expect(stripDanglingToolCallOpener(text)).toBe(text);
    }
  });
});

describe('tool loop: answer that ends with a leaked <tool_call>', () => {
  const run = async (replies: string[]) => {
    const registry = new ToolRegistry();
    const captured = { paths: [] as string[] };
    registry.register(buildReadFileTool(captured));
    const { chat, recorder } = buildMockChat((turn) => replies[Math.min(turn, replies.length) - 1]);
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });
    const result = await loop.run('enable darkMode', chat);
    return { result, recorder, events, captured };
  };

  it('ends the turn with the answer instead of asking for the "tool call" again', async () => {
    const { result, recorder, events, captured } = await run([
      CALL,
      'darkMode is now enabled. No additional steps are needed.<tool_call>',
      'I re-did the work.' // never requested
    ]);
    expect(recorder.callCount).toBe(2);
    expect(captured.paths).toEqual(['config/features.json']);
    expect(result.finalResponse).toBe('darkMode is now enabled. No additional steps are needed.');
    expect(events.filter((e) => e.type === 'tool_loop:parse_retry')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'tool_loop:dangling_tool_call_stripped')).toHaveLength(1);
    // The leaked tag is not kept in the transcript either.
    expect(result.messages.some((m) => m.role === 'assistant' && /<tool_call>\s*$/.test(m.content))).toBe(false);
  });

  it('a call body that really failed to parse still gets its retry', async () => {
    const { recorder, events } = await run([
      'Updating.\n<tool_call>{"name":"read_file","params":{"path":"a.ts}</tool_call>',
      CALL,
      'Done.'
    ]);
    expect(events.filter((e) => e.type === 'tool_loop:parse_retry')).toHaveLength(1);
    expect(recorder.callCount).toBe(3);
  });
});

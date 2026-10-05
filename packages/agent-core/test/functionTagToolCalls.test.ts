/**
 * Qwen3-Coder writes tool calls as <function=name><parameter=key>value</parameter></function>.
 *
 * Ollama turns that into a native call when it is the whole reply. When the model writes a
 * sentence first, Ollama 0.35.1 returns the call as content with the opening <tool_call>
 * eaten and the closing one left in. The loop did not recognise it, took the reply for a
 * final answer, and the turn ended with nothing done (BanditBench 2026-10-05,
 * qwen3-coder:30b, refactor.multi_file and search.then_edit: two of three runs each).
 *
 * The first reply below is verbatim from one of those runs.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import { hasToolCalls, looksLikeAttemptedToolCall, parseToolCalls, stripToolCallMarkup } from '../src/tools/tool-use-parser';
import { buildEmitRecorder, buildMockChat, buildReadFileTool, testCtx } from './_helpers';

const FROM_TRACE = "I'll rename the `greet` function to `sayHello` in both files. First, let me check what these files look like to understand the current implementation.\n\n<function=read_file>\n<parameter=path>\nsrc/greetings.ts\n</parameter>\n</function>\n</tool_call>";

describe('parseToolCalls: <function=…> blocks', () => {
  it('reads the call Ollama left in content, with the opening tag missing', () => {
    expect(hasToolCalls(FROM_TRACE)).toBe(true);
    const calls = parseToolCalls(FROM_TRACE);
    expect(calls.map((c) => ({ name: c.name, params: c.params }))).toEqual([{ name: 'read_file', params: { path: 'src/greetings.ts' } }]);
  });

  it('reads the fully wrapped form, several parameters and several calls', () => {
    const text = [
      '<tool_call>',
      '<function=apply_edit>',
      '<parameter=path>',
      'main.ts',
      '</parameter>',
      '<parameter=find>',
      'greet("world")',
      '</parameter>',
      '<parameter=replace>',
      'sayHello("world")',
      '</parameter>',
      '</function>',
      '</tool_call>',
      '<tool_call>',
      '<function=read_file>',
      '<parameter=path>',
      'greetings.ts',
      '</parameter>',
      '</function>',
      '</tool_call>'
    ].join('\n');
    expect(parseToolCalls(text).map((c) => [c.name, c.params])).toEqual([
      ['apply_edit', { path: 'main.ts', find: 'greet("world")', replace: 'sayHello("world")' }],
      ['read_file', { path: 'greetings.ts' }]
    ]);
  });

  it('keeps multi-line content exactly: indentation, blank lines, fenced code', () => {
    const content = 'export function clamp(n: number): number {\n\n  return Math.max(0, n);\n}\n\n```ts\nclamp(2);\n```';
    const text = `<function=write_file>\n<parameter=path>\nsrc/clamp.ts\n</parameter>\n<parameter=content>\n${content}\n</parameter>\n</function>`;
    expect(parseToolCalls(text)[0].params).toEqual({ path: 'src/clamp.ts', content });
  });

  it('a call with no parameters is still a call', () => {
    expect(parseToolCalls('<function=git_status>\n</function>').map((c) => [c.name, c.params])).toEqual([['git_status', {}]]);
  });

  it('does not add a second call when a JSON call merely mentions the syntax', () => {
    const json = `<tool_call>${JSON.stringify({ name: 'write_file', params: { path: 'NOTES.md', content: 'Qwen writes <function=read_file><parameter=path>x</parameter></function>' } })}</tool_call>`;
    expect(parseToolCalls(json).map((c) => c.name)).toEqual(['write_file']);
  });

  it('an unterminated block is an attempted call, not prose and not a call', () => {
    const cut = 'Writing it now.\n<function=write_file>\n<parameter=path>\nsrc/a.ts\n</parameter>\n<parameter=content>\nexport const a =';
    expect(hasToolCalls(cut)).toBe(false);
    expect(looksLikeAttemptedToolCall(cut)).toBe(true);
  });

  it('is stripped from text shown to the user', () => {
    expect(stripToolCallMarkup(FROM_TRACE)).not.toMatch(/<function=|<\/tool_call>|<parameter=/);
  });
});

describe('tool loop: a reply in <function=…> form after a sentence of prose', () => {
  it('runs the call instead of ending the turn', async () => {
    const registry = new ToolRegistry();
    const captured = { paths: [] as string[] };
    registry.register(buildReadFileTool(captured));
    const { chat, recorder } = buildMockChat((turn) => (turn === 1 ? FROM_TRACE : 'Both files read.'));
    const { emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });
    const result = await loop.run('rename greet to sayHello', chat);
    expect(captured.paths).toEqual(['src/greetings.ts']);
    expect(recorder.callCount).toBe(2);
    expect(result.finalResponse).toBe('Both files read.');
  });
});

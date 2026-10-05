import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProvider, serializeBanditPayload } from '../src/banditEngineProvider';
import { clearModelBehaviorOverrides, getBuiltInModelBehaviorProfiles, registerModelBehaviorConfig } from '../src/runtime/modelBehavior';
import { planToolHistory, resolveToolHistoryMode, toOllamaToolHistory, toPartsToolHistory } from '../src/toolHistory';
import type { AIChatRequest, OllamaToolSchema } from '../src/types/bandit';

const call = (name: string, params: Record<string, unknown>): string => `<tool_call>${JSON.stringify({ name, params })}</tool_call>`;
const result = (name: string, body: string, error = false): string =>
  `<tool_result name="${name}"${error ? ' status="error"' : ''}>\n${body}\n</tool_result>`;

const TOOLS: OllamaToolSchema[] = [{
  type: 'function',
  function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' } }, required: ['path'] } }
}];

/** A turn as the tool loop stores it: one read, its result, then the model is asked again. */
const TURN = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'enable darkMode' },
  { role: 'assistant', content: `Reading the config.\n${call('read_file', { path: 'config/features.json' })}` },
  { role: 'user', content: result('read_file', '{ "darkMode": false }') }
];

describe('toOllamaToolHistory', () => {
  it('turns an inline tool call and its result into native assistant/tool messages', () => {
    expect(toOllamaToolHistory(TURN)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'enable darkMode' },
      { role: 'assistant', content: 'Reading the config.', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'config/features.json' } } }] },
      { role: 'tool', tool_name: 'read_file', content: '{ "darkMode": false }' }
    ]);
  });

  it('keeps a batch together: two calls, two results, and the loop\'s trailing note stays a user turn', () => {
    const out = toOllamaToolHistory([
      { role: 'assistant', content: `${call('read_file', { path: 'a.ts' })}\n${call('read_file', { path: 'b.ts' })}` },
      { role: 'user', content: `${result('read_file', 'A')}\n\n${result('read_file', 'ENOENT: no such file', true)}\n\n[Note: keep going]` }
    ]);
    expect(out[0].tool_calls).toHaveLength(2);
    expect(out.slice(1)).toEqual([
      { role: 'tool', tool_name: 'read_file', content: 'A' },
      { role: 'tool', tool_name: 'read_file', content: 'ERROR: ENOENT: no such file' },
      { role: 'user', content: '[Note: keep going]' }
    ]);
  });

  it('drops calls the loop did not run, so an unanswered call is not read as done', () => {
    // Default profile: one call per reply. The second edit was never executed.
    const out = toOllamaToolHistory([
      { role: 'assistant', content: `${call('apply_edit', { path: 'a.ts' })}\n${call('apply_edit', { path: 'b.ts' })}` },
      { role: 'user', content: `${result('apply_edit', 'Replaced 1 occurrence in a.ts')}\n\n[Note: you emitted 2 tool calls in one iteration; only the first 1 were executed.]` }
    ]);
    expect(out[0].tool_calls).toEqual([{ function: { name: 'apply_edit', arguments: { path: 'a.ts' } } }]);
    expect(out.map((message) => message.role)).toEqual(['assistant', 'tool', 'user']);
  });

  it('attributes results by tool name when a call in the middle of the batch was dropped', () => {
    // A duplicate read_file was removed by the loop; the results are read_file, search_code.
    const out = toOllamaToolHistory([
      { role: 'assistant', content: [call('read_file', { path: 'a.ts' }), call('read_file', { path: 'a.ts' }), call('search_code', { pattern: 'x' })].join('\n') },
      { role: 'user', content: `${result('read_file', 'A')}\n\n${result('search_code', 'a.ts:1')}` }
    ]);
    expect(out[0].tool_calls).toEqual([
      { function: { name: 'read_file', arguments: { path: 'a.ts' } } },
      { function: { name: 'search_code', arguments: { pattern: 'x' } } }
    ]);
    expect(out.slice(1).map((message) => message.tool_name)).toEqual(['read_file', 'search_code']);
  });

  it('leaves what it cannot parse or cannot attribute exactly as it was', () => {
    const untouched = [
      { role: 'assistant', content: '<tool_call>{"name":"' },                         // the loop's prefill fragment
      { role: 'assistant', content: 'No tools needed here.' },
      { role: 'user', content: 'Please look at <tool_result name="x"> in the docs' },  // prose, not an envelope
      { role: 'user', content: 'AUTOMATED HARNESS CHECK — your previous response was empty.' },
      // A call the loop refused to run (a nudge follows, not a result) stays text.
      { role: 'assistant', content: call('todo_write', { todos: '[]' }) },
      { role: 'user', content: 'AUTOMATED HARNESS CHECK — execute the first pending task now.' },
      // Results that name a tool the previous turn never called cannot be attributed.
      { role: 'assistant', content: call('read_file', { path: 'a.ts' }) },
      { role: 'user', content: result('search_code', 'a.ts:1') },
      // A result with no parsable call before it stays a user turn.
      { role: 'assistant', content: 'Let me check.' },
      { role: 'user', content: result('read_file', 'A') }
    ];
    expect(toOllamaToolHistory(untouched)).toEqual(untouched);
  });

  it('replays what the loop parsed, in whatever form the model wrote it', () => {
    const fenced = toOllamaToolHistory([
      { role: 'assistant', content: 'Reading it.\n```tool_call\n{"name":"read_file","arguments":{"path":"a.ts"}}\n```' },
      { role: 'user', content: result('read_file', 'A') }
    ]);
    expect(fenced).toEqual([
      { role: 'assistant', content: 'Reading it.', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }] },
      { role: 'tool', tool_name: 'read_file', content: 'A' }
    ]);
  });

  it('does not double the error marker', () => {
    const out = toOllamaToolHistory([
      { role: 'assistant', content: call('apply_edit', { path: 'a.ts' }) },
      { role: 'user', content: result('apply_edit', 'Error: find parameter is required', true) }
    ]);
    expect(out[1]).toEqual({ role: 'tool', tool_name: 'apply_edit', content: 'Error: find parameter is required' });
  });

  it('accepts a compacted result placeholder (no newlines inside the envelope)', () => {
    const out = toOllamaToolHistory([
      { role: 'assistant', content: call('read_file', { path: 'a.ts' }) },
      { role: 'user', content: '<tool_result name="read_file">[earlier run, 40 lines elided — summary: File: a.ts]</tool_result>' }
    ]);
    expect(out[1]).toEqual({ role: 'tool', tool_name: 'read_file', content: '[earlier run, 40 lines elided — summary: File: a.ts]' });
  });

  it('keeps images that were attached to a results message', () => {
    const out = toOllamaToolHistory([
      { role: 'assistant', content: call('read_file', { path: 'a.ts' }) },
      { role: 'user', content: result('read_file', 'A'), images: ['aGVsbG8='] }
    ]);
    expect(out).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }] },
      { role: 'tool', tool_name: 'read_file', content: 'A' },
      { role: 'user', content: '', images: ['aGVsbG8='] }
    ]);
  });
});

describe('planToolHistory', () => {
  it('numbers calls across the whole conversation and ties each result to its call', () => {
    const plan = planToolHistory([
      ...TURN,
      { role: 'assistant', content: call('apply_edit', { path: 'config/features.json', find: 'false', replace: 'true' }) },
      { role: 'user', content: result('apply_edit', 'Replaced 1 occurrence') }
    ]);
    const ids = plan.flatMap((entry) => entry.kind === 'assistant' ? entry.calls.map((c) => c.id) : entry.kind === 'tool' ? [entry.result.id] : []);
    expect(ids).toEqual(['call_1', 'call_1', 'call_2', 'call_2']);
  });
});

describe('toPartsToolHistory', () => {
  const parts = (text: string) => [{ type: 'text', text }];
  const conversation = TURN.map((message) => ({ role: message.role, content: parts(message.content) }));

  it('openai: ids, JSON-string arguments, and results that answer the id', () => {
    expect(toPartsToolHistory(conversation, 'openai').slice(2)).toEqual([
      {
        role: 'assistant',
        content: 'Reading the config.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"config/features.json"}' } }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{ "darkMode": false }' }
    ]);
  });

  it('ollama (what the Bandit gateway forwards): object arguments and tool_name', () => {
    expect(toPartsToolHistory(conversation, 'ollama').slice(2)).toEqual([
      { role: 'assistant', content: 'Reading the config.', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'config/features.json' } } }] },
      { role: 'tool', tool_name: 'read_file', content: '{ "darkMode": false }' }
    ]);
  });

  it('never rewrites a message that carries an image', () => {
    const withImage = [
      { role: 'assistant', content: parts(call('read_file', { path: 'a.png' })) },
      { role: 'user', content: [...parts(result('read_file', 'A')), { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }
    ];
    expect(toPartsToolHistory(withImage, 'openai')).toEqual(withImage);
  });
});

describe('resolveToolHistoryMode', () => {
  const saved = process.env.BANDIT_TOOL_HISTORY;
  beforeEach(() => { delete process.env.BANDIT_TOOL_HISTORY; });
  afterEach(() => {
    if (saved === undefined) {delete process.env.BANDIT_TOOL_HISTORY;} else {process.env.BANDIT_TOOL_HISTORY = saved;}
    clearModelBehaviorOverrides();
  });

  it('follows the behaviour profile on direct Ollama', () => {
    for (const profile of getBuiltInModelBehaviorProfiles()) {
      const model = profile.match[0] || 'some-unknown-model';
      expect(resolveToolHistoryMode(model, 'ollama')).toBe(profile.protocol.toolHistory);
    }
  });

  it('lets a user profile put one model family back on text history', () => {
    registerModelBehaviorConfig({ profiles: { 'gemma4': { protocol: { toolHistory: 'text' } } } });
    expect(resolveToolHistoryMode('gemma4:31b', 'ollama')).toBe('text');
    expect(resolveToolHistoryMode('qwen3.6:27b', 'ollama')).toBe(getBuiltInModelBehaviorProfiles().find((p) => p.id === 'qwen3.6')!.protocol.toolHistory);
  });

  it('warns about a toolHistory value it does not know', () => {
    const parsed = registerModelBehaviorConfig({ profiles: { 'gemma4': { protocol: { toolHistory: 'xml' } } } });
    expect(parsed.warnings.join('\n')).toMatch(/gemma4\.protocol\.toolHistory must be one of: native, text/);
  });

  it('keeps the gateway and OpenAI-compatible servers on text unless forced', () => {
    expect(resolveToolHistoryMode('gemma4:31b', 'bandit')).toBe('text');
    expect(resolveToolHistoryMode('gemma4:31b', 'openai-compatible')).toBe('text');
    process.env.BANDIT_TOOL_HISTORY = 'native';
    expect(resolveToolHistoryMode('gemma4:31b', 'bandit')).toBe('native');
    expect(resolveToolHistoryMode('gemma4:31b', 'openai-compatible')).toBe('native');
  });

  it('BANDIT_TOOL_HISTORY=text forces the old behaviour for every model', () => {
    process.env.BANDIT_TOOL_HISTORY = 'text';
    for (const profile of getBuiltInModelBehaviorProfiles()) {
      expect(resolveToolHistoryMode(profile.match[0] || 'x', 'ollama')).toBe('text');
    }
  });
});

describe('providers', () => {
  const saved = process.env.BANDIT_TOOL_HISTORY;
  let sent: Array<Record<string, unknown>>;

  beforeEach(() => {
    sent = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ message: { role: 'assistant', content: 'done' }, done: true }), { status: 200 });
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (saved === undefined) {delete process.env.BANDIT_TOOL_HISTORY;} else {process.env.BANDIT_TOOL_HISTORY = saved;}
    clearModelBehaviorOverrides();
  });

  const request = (tools?: OllamaToolSchema[]): AIChatRequest => ({
    model: 'gemma4:31b',
    messages: TURN as AIChatRequest['messages'],
    ...(tools ? { tools } : {})
  });

  const ollamaMessages = async (req: AIChatRequest): Promise<Array<Record<string, unknown>>> => {
    const provider = await createProvider({ kind: 'ollama', ollamaUrl: 'http://ollama.test' });
    for await (const chunk of provider.chat(req)) {void chunk;}
    return sent[sent.length - 1].messages as Array<Record<string, unknown>>;
  };

  it('ollama + native tools: history goes out as tool_calls and tool messages', async () => {
    process.env.BANDIT_TOOL_HISTORY = 'native';
    const messages = await ollamaMessages(request(TOOLS));
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(JSON.stringify(messages)).not.toContain('<tool_call>');
    expect(JSON.stringify(messages)).not.toContain('<tool_result');
  });

  it('ollama without tools (text protocol, or the loop\'s mid-turn fallback): history stays text', async () => {
    process.env.BANDIT_TOOL_HISTORY = 'native';
    const messages = await ollamaMessages(request());
    expect(messages).toEqual(TURN);
  });

  it('ollama + native tools with the old behaviour forced: history stays text', async () => {
    process.env.BANDIT_TOOL_HISTORY = 'text';
    const messages = await ollamaMessages(request(TOOLS));
    expect(messages).toEqual(TURN);
  });

  it('ollama + native tools follows a per-family profile override', async () => {
    delete process.env.BANDIT_TOOL_HISTORY;
    registerModelBehaviorConfig({ profiles: { 'gemma4': { protocol: { toolHistory: 'text' } } } });
    expect(await ollamaMessages(request(TOOLS))).toEqual(TURN);
    clearModelBehaviorOverrides();
    registerModelBehaviorConfig({ profiles: { 'gemma4': { protocol: { toolHistory: 'native' } } } });
    expect((await ollamaMessages(request(TOOLS))).map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  });

  it('gateway and OpenAI-compatible payloads keep text history by default', () => {
    delete process.env.BANDIT_TOOL_HISTORY;
    for (const opts of [undefined, { strictOpenAI: true }]) {
      const payload = serializeBanditPayload(request(TOOLS), opts);
      expect((payload.messages as Array<{ role: string }>).map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    }
  });

  it('gateway and OpenAI-compatible payloads replay natively when forced, each in its own shape', () => {
    process.env.BANDIT_TOOL_HISTORY = 'native';
    const gateway = serializeBanditPayload(request(TOOLS)).messages as Array<Record<string, unknown>>;
    expect(gateway[2].tool_calls).toEqual([{ function: { name: 'read_file', arguments: { path: 'config/features.json' } } }]);
    expect(gateway[3]).toEqual({ role: 'tool', tool_name: 'read_file', content: '{ "darkMode": false }' });

    const openai = serializeBanditPayload(request(TOOLS), { strictOpenAI: true }).messages as Array<Record<string, unknown>>;
    expect(openai[2].tool_calls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"config/features.json"}' } }]);
    expect(openai[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{ "darkMode": false }' });
  });

  it('a request without tools is never rewritten on the gateway path either', () => {
    process.env.BANDIT_TOOL_HISTORY = 'native';
    const payload = serializeBanditPayload(request());
    expect((payload.messages as Array<{ role: string }>).map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });
});

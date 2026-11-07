import { describe, expect, it } from 'vitest';
import { buildOpenAICompatibleErrorHint, createProvider, OLLAMA_OUTPUT_TRUNCATED_SENTINEL } from '../src';

/**
 * The openai-compatible provider against the shapes vLLM, SGLang and
 * llama.cpp actually return (checked live on 2026-11-07: llama.cpp b12110,
 * vLLM 0.11 / 0.33 CPU).
 */
const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }];

function jsonFetch(body: unknown, seen: { body?: Record<string, unknown>; signal?: AbortSignal } = {}) {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.body = JSON.parse(String(init?.body));
    seen.signal = init?.signal ?? undefined;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function last(stream: AsyncIterable<{ message?: { content?: string; thinking?: string } }>) {
  let content = '';
  let thinking = '';
  for await (const chunk of stream) {
    content += chunk.message?.content ?? '';
    thinking += chunk.message?.thinking ?? '';
  }
  return { content, thinking };
}

async function provider(fetchImpl: typeof fetch) {
  return createProvider({ kind: 'openai-compatible', openaiBaseUrl: 'http://localhost:8000/v1', openaiModel: 'm', fetchImpl });
}

describe('openai-compatible provider', () => {
  it('cancels the HTTP request when the caller aborts', async () => {
    const seen: { signal?: AbortSignal } = {};
    let release!: () => void;
    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.signal = init?.signal ?? undefined;
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
      return new Response('{}');
    }) as typeof fetch;
    const caller = new AbortController();
    const p = await provider(hanging);
    const run = last(p.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools, signal: caller.signal } as never));
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.signal?.aborted).toBe(false);
    caller.abort();
    await expect(run).rejects.toThrow(/aborted/);
    expect(seen.signal?.aborted).toBe(true);
    release?.();
  });

  it('marks a reply cut off by the length limit as truncated, never as an answer or a call', async () => {
    const p = await provider(jsonFetch({
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'Starting the fix', tool_calls: [{ function: { name: 'write_file', arguments: '{"path":"a' } }] } }]
    }));
    const { content } = await last(p.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools } as never));
    expect(content).toBe(`Starting the fix\n\n${OLLAMA_OUTPUT_TRUNCATED_SENTINEL}`);
    expect(content).not.toContain('<tool_call>');
  });

  it('reads reasoning_content (vLLM, SGLang, llama.cpp) as thinking', async () => {
    const p = await provider(jsonFetch({
      choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', reasoning_content: 'look first', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"calc.py"}' } }] } }]
    }));
    const { content, thinking } = await last(p.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools } as never));
    expect(thinking).toBe('look first');
    expect(content).toBe('<tool_call>{"name":"read_file","params":{"path":"calc.py"}}</tool_call>');
  });

  it('never sends max_tokens, even with a num_predict backstop (vLLM 400s when it does not fit)', async () => {
    const reply = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] };
    const seen: { body?: Record<string, unknown> } = {};
    await last((await provider(jsonFetch(reply, seen))).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools, options: { num_predict: 32768 } } as never));
    expect(seen.body).not.toHaveProperty('max_tokens');
  });

});

describe('buildOpenAICompatibleErrorHint', () => {
  const url = 'http://localhost:8000/v1/chat/completions';
  it('names the window flags on a context overflow (llama.cpp and vLLM wording)', () => {
    expect(buildOpenAICompatibleErrorHint(400, url, '{"error":{"message":"request (5817 tokens) exceeds the available context size (4096 tokens), try increasing it","type":"exceed_context_size_error"}}')).toMatch(/--max-model-len.*-c.*--small-context/);
    expect(buildOpenAICompatibleErrorHint(400, url, "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens")).toMatch(/--max-model-len/);
  });
  it('points at /models for an unknown model id', () => {
    expect(buildOpenAICompatibleErrorHint(404, url, '{"error":{"message":"The model `nope` does not exist."}}')).toContain('http://localhost:8000/v1/models');
  });
  it('suggests /v1 when the route itself is missing', () => {
    expect(buildOpenAICompatibleErrorHint(404, 'http://localhost:8000/chat/completions', '{"detail":"Not Found"}')).toContain('/v1');
  });
  it('adds nothing for other errors', () => {
    expect(buildOpenAICompatibleErrorHint(500, url, 'boom')).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { createProvider } from '../src';

/**
 * `ProviderSettings.fetchImpl` is the seam the agent-runner uses to enforce
 * its egress policy on user-supplied endpoints. If a provider ever bypassed
 * it and called the global fetch, that policy would silently stop applying —
 * so every provider kind is checked to route through the injected fetch.
 */
function recordingFetch(body: string, contentType: string) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(body, { status: 200, headers: { 'content-type': contentType } });
  }) as typeof fetch;
  return { calls, impl };
}

async function drain(stream: AsyncIterable<{ message?: { content?: string } }>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk.message?.content ?? '';
  return out;
}

describe('ProviderSettings.fetchImpl', () => {
  it('routes ollama requests through the injected fetch', async () => {
    const { calls, impl } = recordingFetch(
      JSON.stringify({ message: { role: 'assistant', content: 'hi' }, done: true }) + '\n',
      'application/x-ndjson',
    );
    const provider = await createProvider({
      kind: 'ollama',
      ollamaUrl: 'http://user-endpoint.example:11434',
      ollamaModel: 'm',
      fetchImpl: impl,
    });

    const text = await drain(provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true }));

    expect(calls).toEqual(['http://user-endpoint.example:11434/api/chat']);
    expect(text).toBe('hi');
  });

  it('routes openai-compatible requests through the injected fetch', async () => {
    const { calls, impl } = recordingFetch(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      'text/event-stream',
    );
    const provider = await createProvider({
      kind: 'openai-compatible',
      openaiBaseUrl: 'https://compat.example/v1',
      openaiModel: 'm',
      fetchImpl: impl,
    });

    await drain(provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true }));

    expect(calls).toEqual(['https://compat.example/v1/chat/completions']);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryOpenAICompatibleModelInfo } from '../src';

function stubFetch(handler: (url: string) => { ok: boolean; status?: number; body?: unknown }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    const result = handler(String(url));
    return {
      ok: result.ok,
      status: result.status ?? (result.ok ? 200 : 500),
      json: async () => result.body ?? {}
    };
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('queryOpenAICompatibleModelInfo — GET /v1/models probe', () => {
  it('reads vLLM max_model_len for the matching model', async () => {
    stubFetch(() => ({
      ok: true,
      body: { data: [{ id: 'Qwen/Qwen2.5-Coder-32B-Instruct', max_model_len: 131072 }] }
    }));
    const info = await queryOpenAICompatibleModelInfo('qwen/qwen2.5-coder-32b-instruct', 'http://localhost:8000/v1');
    expect(info).toEqual({ exists: true, contextWindow: 131072 });
  });

  it('reads OpenRouter context_length when max_model_len is absent', async () => {
    stubFetch(() => ({
      ok: true,
      body: { data: [{ id: 'deepseek/deepseek-r1', context_length: 64000 }] }
    }));
    const info = await queryOpenAICompatibleModelInfo('deepseek/deepseek-r1', 'https://openrouter.ai/api/v1');
    expect(info).toEqual({ exists: true, contextWindow: 64000 });
  });

  it('normalizes chat-completions and /v1 suffixes to one /v1/models URL', async () => {
    const calls = stubFetch(() => ({ ok: true, body: { data: [] } }));
    await queryOpenAICompatibleModelInfo('m', 'http://localhost:1234/v1/chat/completions');
    await queryOpenAICompatibleModelInfo('m', 'http://localhost:1234/v1/');
    await queryOpenAICompatibleModelInfo('m', 'http://localhost:1234');
    expect(calls).toEqual([
      'http://localhost:1234/v1/models',
      'http://localhost:1234/v1/models',
      'http://localhost:1234/v1/models'
    ]);
  });

  it('reports exists:false when the model is not in the listing', async () => {
    stubFetch(() => ({ ok: true, body: { data: [{ id: 'other-model' }] } }));
    const info = await queryOpenAICompatibleModelInfo('my-model', 'http://localhost:1234/v1');
    expect(info).toEqual({ exists: false });
  });

  it('returns null on a non-OK response or network failure', async () => {
    stubFetch(() => ({ ok: false, status: 404 }));
    expect(await queryOpenAICompatibleModelInfo('m', 'http://localhost:1234/v1')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused'); }));
    expect(await queryOpenAICompatibleModelInfo('m', 'http://localhost:1234/v1')).toBeNull();
  });
});

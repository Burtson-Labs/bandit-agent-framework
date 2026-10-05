/**
 * The capability probe must read the context length Ollama actually reports.
 *
 * It used to read `model_info['llm.context_length']`. Ollama namespaces the key by
 * architecture (`qwen3.context_length`, `gptoss.context_length`, …), so the declared value
 * was never used, a small-tier model was registered with an 8,192-token window, and a
 * model the probe had not reached yet was loaded with 8,192 tokens against a fixed prompt
 * of about 8,100 (BanditBench 2026-10-05: the user's request was the first thing cut).
 *
 * The payloads below are `/api/show` responses captured from Ollama 0.35.1 on 2026-10-05,
 * reduced to the scalar `model_info` keys (tokenizer tables, template and licence removed).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capabilitiesFromOllamaShow,
  clearDiscoveredCapabilities,
  getModelCapabilities,
  queryOllamaModelCapabilities,
  readOllamaContextLength,
  registerModelCapabilities,
  resolveOllamaRuntimeOptions,
  type OllamaShowResponse
} from '../src/runtime/modelCapabilities';

const QWEN3_8B: OllamaShowResponse = {
  details: { family: 'qwen3', parameter_size: '8.2B' },
  capabilities: ['completion', 'tools', 'thinking'],
  model_info: {
    'general.architecture': 'qwen3',
    'general.basename': 'Qwen3',
    'general.parameter_count': 8190735360,
    'general.size_label': '8B',
    'qwen3.attention.head_count': 32,
    'qwen3.block_count': 36,
    'qwen3.context_length': 40960,
    'qwen3.embedding_length': 4096,
    'qwen3.feed_forward_length': 12288,
    'tokenizer.ggml.model': 'gpt2'
  }
};

const GPT_OSS_20B: OllamaShowResponse = {
  details: { family: 'gptoss', parameter_size: '20.9B' },
  capabilities: ['completion', 'tools', 'thinking'],
  model_info: {
    'general.architecture': 'gptoss',
    'general.parameter_count': 20914757184,
    'gptoss.attention.sliding_window': 128,
    'gptoss.block_count': 24,
    'gptoss.context_length': 131072,
    'gptoss.embedding_length': 2880,
    'gptoss.rope.scaling.factor': 32,
    'gptoss.rope.scaling.original_context_length': 4096,
    'tokenizer.ggml.model': 'gpt2'
  }
};

const GEMMA4_12B: OllamaShowResponse = {
  details: { family: 'gemma4', parameter_size: '11.9B' },
  capabilities: ['completion', 'vision', 'audio', 'tools', 'thinking'],
  model_info: {
    'gemma4.attention.sliding_window': 1024,
    'gemma4.block_count': 48,
    'gemma4.context_length': 262144,
    'gemma4.embedding_length': 3840,
    'general.architecture': 'gemma4',
    'general.parameter_count': 11907350576,
    'tokenizer.ggml.model': 'gemma4'
  }
};

const QWEN3_CODER_30B: OllamaShowResponse = {
  details: { family: 'qwen3moe', parameter_size: '30.5B' },
  capabilities: ['completion', 'tools'],
  model_info: {
    'general.architecture': 'qwen3moe',
    'general.basename': 'Qwen3-Coder',
    'general.parameter_count': 30532122624,
    'qwen3moe.block_count': 48,
    'qwen3moe.context_length': 262144,
    'qwen3moe.expert_count': 128
  }
};

const PHI4_MINI: OllamaShowResponse = {
  details: { family: 'phi3', parameter_size: '3.8B' },
  capabilities: ['completion', 'tools'],
  model_info: {
    'general.architecture': 'phi3',
    'general.basename': 'Phi-4',
    'general.parameter_count': 3836021856,
    'phi3.attention.sliding_window': 262144,
    'phi3.context_length': 131072,
    'phi3.rope.scaling.original_context_length': 4096
  }
};

const LLAMA3_8B: OllamaShowResponse = {
  details: { family: 'llama', parameter_size: '8.0B' },
  capabilities: ['completion'],
  model_info: {
    'general.architecture': 'llama',
    'general.parameter_count': 8030261248,
    'llama.block_count': 32,
    'llama.context_length': 8192,
    'llama.vocab_size': 128256
  }
};

/** System prompt plus 21 native tool schemas, measured for qwen3 on 2026-10-05. */
const FIXED_PROMPT_TOKENS = 8099;

afterEach(() => {
  clearDiscoveredCapabilities();
  vi.unstubAllGlobals();
});

describe('readOllamaContextLength', () => {
  it('reads <architecture>.context_length for each family', () => {
    expect(readOllamaContextLength(QWEN3_8B.model_info)).toBe(40960);
    expect(readOllamaContextLength(GPT_OSS_20B.model_info)).toBe(131072);
    expect(readOllamaContextLength(GEMMA4_12B.model_info)).toBe(262144);
    expect(readOllamaContextLength(QWEN3_CODER_30B.model_info)).toBe(262144);
    expect(readOllamaContextLength(PHI4_MINI.model_info)).toBe(131072);
    expect(readOllamaContextLength(LLAMA3_8B.model_info)).toBe(8192);
  });

  it('is not fooled by rope.scaling.original_context_length', () => {
    const { 'gptoss.context_length': _dropped, ...withoutDeclared } = GPT_OSS_20B.model_info as Record<string, unknown>;
    expect(readOllamaContextLength(withoutDeclared)).toBeUndefined();
  });

  it('finds the key when general.architecture is missing, and gives up cleanly otherwise', () => {
    expect(readOllamaContextLength({ 'mistral.context_length': 32768 })).toBe(32768);
    expect(readOllamaContextLength({ 'mistral.context_length': '32768' })).toBeUndefined();
    expect(readOllamaContextLength({})).toBeUndefined();
    expect(readOllamaContextLength(undefined)).toBeUndefined();
  });
});

describe('capabilitiesFromOllamaShow', () => {
  it('reports the declared window, capped at what one 32 GB card serves', () => {
    expect(capabilitiesFromOllamaShow('qwen3:8b', QWEN3_8B)).toMatchObject({ tier: 'medium', contextWindow: 32768, supportsToolCalling: true, supportsVision: false });
    expect(capabilitiesFromOllamaShow('gpt-oss:20b', GPT_OSS_20B)).toMatchObject({ tier: 'medium', contextWindow: 32768, supportsToolCalling: true });
    expect(capabilitiesFromOllamaShow('qwen3-coder:30b', QWEN3_CODER_30B)).toMatchObject({ tier: 'medium', contextWindow: 32768, supportsToolCalling: true });
    expect(capabilitiesFromOllamaShow('gemma4:12b-it-qat', GEMMA4_12B)).toMatchObject({ tier: 'medium', contextWindow: 32768, supportsVision: true });
  });

  it('gives a small model its real window instead of 8,192', () => {
    expect(capabilitiesFromOllamaShow('phi4-mini:latest', PHI4_MINI)).toMatchObject({ tier: 'small', contextWindow: 16384, supportsToolCalling: true });
  });

  it('keeps a window that really is small', () => {
    expect(capabilitiesFromOllamaShow('some-llama:8b', LLAMA3_8B)).toMatchObject({ tier: 'medium', contextWindow: 8192, supportsToolCalling: false });
  });

  it('falls back to a workable window when the server reports no context length', () => {
    const bare: OllamaShowResponse = { details: { parameter_size: '3.8B' }, capabilities: ['completion'] };
    expect(capabilitiesFromOllamaShow('old-server-model', bare).contextWindow).toBe(16384);
  });
});

describe('queryOllamaModelCapabilities', () => {
  it('asks /api/show and maps the response', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(GPT_OSS_20B), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const caps = await queryOllamaModelCapabilities('gpt-oss:20b', 'http://ollama.test/');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://ollama.test/api/show');
    expect(caps).toEqual(capabilitiesFromOllamaShow('gpt-oss:20b', GPT_OSS_20B));
  });

  it('returns null when the model is not installed or the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"model not found"}', { status: 404 })));
    expect(await queryOllamaModelCapabilities('nope:1b', 'http://ollama.test')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await queryOllamaModelCapabilities('nope:1b', 'http://ollama.test')).toBeNull();
  });
});

describe('num_ctx requested from Ollama', () => {
  const probe = (modelId: string, payload: OllamaShowResponse): number => {
    registerModelCapabilities(modelId, capabilitiesFromOllamaShow(modelId, payload));
    return resolveOllamaRuntimeOptions(modelId).num_ctx;
  };

  it('probed models without a built-in profile get their tier window: the same 24,576 the repaired benchmark ran them at', () => {
    // The eval runner's workaround (71fd4fd) registers this same probe before a run, so the
    // product fix and the benchmark resolve one value rather than stacking.
    expect(probe('qwen3:8b', QWEN3_8B)).toBe(24576);
    expect(probe('qwen3:14b', { ...QWEN3_8B, details: { family: 'qwen3', parameter_size: '14.8B' } })).toBe(24576);
    expect(probe('gpt-oss:20b', GPT_OSS_20B)).toBe(24576);
    expect(probe('qwen3-coder:30b', QWEN3_CODER_30B)).toBe(24576);
  });

  it('a probed small model no longer gets a window smaller than the prompt', () => {
    expect(probe('phi4-mini:latest', PHI4_MINI)).toBe(12288);
    expect(probe('phi4-mini:latest', PHI4_MINI)).toBeGreaterThan(FIXED_PROMPT_TOKENS);
  });

  it('never asks for more than a model declares', () => {
    expect(probe('some-llama:8b', LLAMA3_8B)).toBe(8192);
  });

  it('never asks for more than 32,768 however much the model declares', () => {
    for (const [id, payload] of [['qwen3-coder:30b', QWEN3_CODER_30B], ['gpt-oss:20b', GPT_OSS_20B], ['phi4-mini:latest', PHI4_MINI]] as const) {
      expect(probe(id, payload)).toBeLessThanOrEqual(32768);
    }
  });

  it('a model nothing is known about gets a workable window, not 8,192', () => {
    const unknown = 'never-seen-model:7b';
    expect(getModelCapabilities(unknown).contextWindow).toBe(8192); // the table's guess is unchanged
    const numCtx = resolveOllamaRuntimeOptions(unknown).num_ctx;
    expect(numCtx).toBe(16384);
    expect(numCtx - FIXED_PROMPT_TOKENS).toBeGreaterThan(8000);
  });

  it('built-in profiles are untouched', () => {
    expect(resolveOllamaRuntimeOptions('qwen3.6:27b').num_ctx).toBe(32768);
    expect(resolveOllamaRuntimeOptions('gemma4:31b').num_ctx).toBe(32768);
    expect(resolveOllamaRuntimeOptions('gemma4:12b-it-qat').num_ctx).toBe(24576);
    expect(resolveOllamaRuntimeOptions('bandit-core:4b').num_ctx).toBe(8192);
  });
});

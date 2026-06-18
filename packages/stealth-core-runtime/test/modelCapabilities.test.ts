import { describe, expect, it } from 'vitest';
import { getModelCapabilities, registerModelCapabilities, resolveDefaultMaxIterations } from '../src';

describe('getModelCapabilities — built-in profile precedence', () => {
  // Regression for v1.7.339 bandit-logic agentic stall. The Ollama auto-detector
  // (queryOllamaModelCapabilities) hard-codes supportsToolCalling: false and
  // populated the runtime cache for every model it queried via /api/show. When
  // the cache was consulted FIRST, every built-in profile (bandit-logic,
  // qwen3.6, qwen2.5-coder, gemma…) silently lost its hand-tuned
  // supportsToolCalling, the native-tools gating evaluated false, the
  // tools[] array was never sent to Ollama, and the qwen3.5 parser EOF'd on
  // the model's text-envelope output. Built-in profiles must win.

  it('returns the built-in profile for bandit-logic even when the cache has stale auto-detected entry', () => {
    registerModelCapabilities('bandit-logic:latest', {
      contextWindow: 8192,
      supportsJsonMode: true,
      supportsToolCalling: false,
      supportsVision: false,
      tier: 'small',
      label: 'bandit-logic:latest'
    });

    const caps = getModelCapabilities('bandit-logic:latest');

    expect(caps.supportsToolCalling).toBe(true);
    expect(caps.tier).toBe('large');
    expect(caps.label).toBe('Bandit Logic (Qwen 3.6 27B)');
  });

  it.each([
    ['qwen3.6:27b', true],
    ['qwen3.6:35b', true],
    ['qwen2.5-coder:32b', true],
    ['qwen2.5:7b', true],
    ['llama3.1:8b', true]
  ])('preserves supportsToolCalling=true for %s even when cache says false', (model, expected) => {
    registerModelCapabilities(model, {
      contextWindow: 8192,
      supportsJsonMode: true,
      supportsToolCalling: false,
      supportsVision: false,
      tier: 'small',
      label: model
    });

    expect(getModelCapabilities(model).supportsToolCalling).toBe(expected);
  });

  it('falls back to cache for models without a built-in profile', () => {
    registerModelCapabilities('my-unknown-model:7b', {
      contextWindow: 16384,
      supportsJsonMode: true,
      supportsToolCalling: false,
      supportsVision: false,
      tier: 'medium',
      label: 'My Unknown Model'
    });

    const caps = getModelCapabilities('my-unknown-model:7b');

    expect(caps.label).toBe('My Unknown Model');
    expect(caps.contextWindow).toBe(16384);
    expect(caps.tier).toBe('medium');
  });

  it('returns DEFAULT_CAPABILITIES for completely unknown models with no cache entry', () => {
    const caps = getModelCapabilities('truly-novel-model:99b');

    expect(caps.tier).toBe('small');
    expect(caps.contextWindow).toBe(8192);
    expect(caps.supportsToolCalling).toBe(false);
  });

  it('returns DEFAULT_CAPABILITIES for empty model id', () => {
    const caps = getModelCapabilities('');

    expect(caps.tier).toBe('small');
    expect(caps.supportsToolCalling).toBe(false);
  });
});

describe('getModelCapabilities — vendor-prefixed id normalization', () => {
  // OpenAI-compatible servers and routers (vLLM, OpenRouter, Together)
  // report HuggingFace-style ids. These must reach the same hand-tuned
  // family profiles as their Ollama-style names instead of falling to
  // worst-case defaults.

  it('matches llama3.1 caps for a Together-style vendor-prefixed id', () => {
    const caps = getModelCapabilities('meta-llama/Meta-Llama-3.1-8B-Instruct');
    expect(caps).toEqual(getModelCapabilities('llama3.1'));
  });

  it('matches qwen2.5-coder caps for an HF-style scoped id', () => {
    const caps = getModelCapabilities('Qwen/Qwen2.5-Coder-32B-Instruct');
    expect(caps).toEqual(getModelCapabilities('qwen2.5-coder'));
  });

  it('leaves plain Ollama-style ids untouched', () => {
    const caps = getModelCapabilities('qwen3.6:27b');
    expect(caps.supportsToolCalling).toBe(true);
  });

  it('still returns defaults for genuinely unknown vendor ids', () => {
    const caps = getModelCapabilities('acme/unknown-model-9b');
    expect(caps.tier).toBe('small');
    expect(caps.supportsToolCalling).toBe(false);
  });
});

describe('getModelCapabilities — Kimi family + Ollama Cloud tags', () => {
  it('base kimi-k2 (and its -cloud tag) is text-only with tools, large, 256K', () => {
    const caps = getModelCapabilities('kimi-k2:1t-cloud');
    expect(caps.supportsToolCalling).toBe(true);
    expect(caps.tier).toBe('large');
    expect(caps.contextWindow).toBe(262144);
    expect(caps.supportsVision).toBe(false);
  });

  it('kimi-k2-thinking is text-only (falls to the base kimi-k2 entry)', () => {
    expect(getModelCapabilities('kimi-k2-thinking').supportsVision).toBe(false);
    expect(getModelCapabilities('kimi-k2-thinking').supportsToolCalling).toBe(true);
  });

  it('multimodal variants (K2.5 / K2.6 / K2.7-code) report vision — NOT masked by base kimi-k2', () => {
    expect(getModelCapabilities('kimi-k2.5').supportsVision).toBe(true);
    expect(getModelCapabilities('kimi-k2.6').supportsVision).toBe(true);
    expect(getModelCapabilities('kimi-k2.7-code').supportsVision).toBe(true);
    expect(getModelCapabilities('kimi-k2.7-code').supportsToolCalling).toBe(true);
  });

  it('strips both cloud tag shapes: -cloud and :cloud', () => {
    // -cloud suffix on a tag
    expect(getModelCapabilities('kimi-k2:1t-cloud')).toEqual(getModelCapabilities('kimi-k2:1t'));
    // :cloud bare tag (kimi-k2.7-code:cloud) — and stays vision-capable
    expect(getModelCapabilities('kimi-k2.7-code:cloud').supportsVision).toBe(true);
  });
});

describe('getModelCapabilities — Apple-silicon MLX builds (-mlx) resolve to base', () => {
  it('qwen3.6:27b-mlx matches qwen3.6:27b caps', () => {
    expect(getModelCapabilities('qwen3.6:27b-mlx')).toEqual(getModelCapabilities('qwen3.6:27b'));
  });
  it('gemma4:26b-mlx matches gemma4:26b caps', () => {
    expect(getModelCapabilities('gemma4:26b-mlx')).toEqual(getModelCapabilities('gemma4:26b'));
  });
});

describe('resolveDefaultMaxIterations — per-model loop cap defaults', () => {
  it('Kimi / bandit-logic-2 get the highest cap (thorough explorers)', () => {
    expect(resolveDefaultMaxIterations('bandit-logic-2')).toBe(40);
    expect(resolveDefaultMaxIterations('kimi-k2.7-code:cloud')).toBe(40);
  });

  it('bandit-logic-2 wins over the bandit-logic pattern (order matters)', () => {
    expect(resolveDefaultMaxIterations('bandit-logic-2')).toBe(40);
    expect(resolveDefaultMaxIterations('bandit-logic')).toBe(30);
    expect(resolveDefaultMaxIterations('qwen3.6:27b')).toBe(30);
  });

  it('bandit-core is 20 but bandit-core-2 is not caught by that pattern', () => {
    expect(resolveDefaultMaxIterations('bandit-core-1')).toBe(20);
    expect(resolveDefaultMaxIterations('bandit-core-2', 'large')).toBe(20); // via tier, not the bandit-core pattern
  });

  it('falls back to tier: small is tighter, everything else 20', () => {
    expect(resolveDefaultMaxIterations('gemma4:e4b', 'small')).toBe(12);
    expect(resolveDefaultMaxIterations('gemma4:26b', 'large')).toBe(20);
    expect(resolveDefaultMaxIterations('some-unknown-model')).toBe(20);
  });
});

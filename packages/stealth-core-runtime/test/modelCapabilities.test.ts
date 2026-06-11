import { describe, expect, it } from 'vitest';
import { getModelCapabilities, registerModelCapabilities } from '../src';

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

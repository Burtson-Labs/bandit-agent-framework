import { afterEach, describe, expect, it } from 'vitest';
import {
  clearModelBehaviorOverrides,
  getModelBehaviorProfile,
  parseModelBehaviorConfig,
  registerModelBehaviorConfig,
  registerModelBehaviorOverride,
  resolveOllamaRuntimeOptions
} from '../src';

describe('model behavior profiles', () => {
  afterEach(() => {
    clearModelBehaviorOverrides();
  });

  it('selects the strongest prefix match for known agent models', () => {
    const profile = getModelBehaviorProfile('qwen3.6:27b-q4_K_M');

    expect(profile.id).toBe('qwen3.6');
    expect(profile.protocol.preferred).toBe('native-tools');
    expect(profile.protocol.fallback).toBe('text-tools');
    expect(profile.protocol.nativeToolFailureFallback).toBe(true);
    expect(profile.prompting.thinking).toBe('on');
  });

  it('uses a conservative text-tool profile for unknown models', () => {
    const profile = getModelBehaviorProfile('some-new-local-model:7b');

    expect(profile.id).toBe('default');
    expect(profile.protocol.preferred).toBe('text-tools');
    expect(profile.context.compaction).toBe('aggressive');
    expect(profile.reliability.maxParallelTools).toBe(1);
  });

  it('allows runtime overrides without mutating the built-in profile', () => {
    registerModelBehaviorOverride('qwen3.6:27b', {
      context: { safeInputTokens: 12000, compaction: 'aggressive' },
      reliability: { maxParallelTools: 1 }
    });

    const overridden = getModelBehaviorProfile('qwen3.6:27b');
    const builtIn = getModelBehaviorProfile('qwen3.6:35b');

    expect(overridden.context.safeInputTokens).toBe(12000);
    expect(overridden.context.compaction).toBe('aggressive');
    expect(overridden.reliability.maxParallelTools).toBe(1);
    expect(builtIn.context.safeInputTokens).toBe(64000);
    expect(builtIn.reliability.maxParallelTools).toBe(6);
  });

  it('feeds thinking defaults into Ollama runtime options', () => {
    expect(resolveOllamaRuntimeOptions('bandit-logic').think).toBe(true);
    expect(resolveOllamaRuntimeOptions('qwen3.6:27b').think).toBe(true);
    expect(resolveOllamaRuntimeOptions('gemma4:26b').think).toBeUndefined();
  });

  it('parses and registers schema-driven behavior overrides', () => {
    const result = registerModelBehaviorConfig({
      version: 1,
      profiles: {
        'my-local-qwen': {
          match: ['my-qwen:14b'],
          label: 'My Qwen 14B',
          protocol: { preferred: 'text-tools', fallback: null, envelope: 'xml-json', nativeToolFailureFallback: false },
          context: { safeInputTokens: 12000, outputBudgetTokens: 2048, compaction: 'early' },
          prompting: { template: 'qwen-agent', examples: 'strict', thinking: 'off' },
          reliability: {
            maxParallelTools: 1,
            retryableErrors: ['temporary overload'],
            knownFailureModes: ['custom parser drift']
          }
        }
      }
    });

    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);

    const profile = getModelBehaviorProfile('my-qwen:14b-q4');
    expect(profile.label).toBe('My Qwen 14B');
    expect(profile.protocol.preferred).toBe('text-tools');
    expect(profile.protocol.fallback).toBeUndefined();
    expect(profile.context.safeInputTokens).toBe(12000);
    expect(profile.prompting.thinking).toBe('off');
    expect(profile.reliability.knownFailureModes).toEqual(['custom parser drift']);
    expect(resolveOllamaRuntimeOptions('my-qwen:14b-q4').think).toBe(false);
  });

  it('reports invalid schema fields while keeping recoverable entries', () => {
    const result = parseModelBehaviorConfig({
      profiles: {
        broken: {
          match: [],
          protocol: { preferred: 'function-calls' },
          context: { safeInputTokens: -1 },
          reliability: { maxParallelTools: 0 }
        }
      }
    });

    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.warnings).toEqual(expect.arrayContaining([
      'broken.protocol.preferred must be one of: native-tools, text-tools',
      'broken.context.safeInputTokens must be a positive integer',
      'broken.reliability.maxParallelTools must be a positive integer'
    ]));
  });
});

describe('getModelBehaviorProfile — vendor-prefixed id normalization', () => {
  it('resolves the llama3 family profile for a vendor-prefixed id', () => {
    const profile = getModelBehaviorProfile('meta-llama/Meta-Llama-3.1-8B-Instruct');
    expect(profile.id).toBe(getModelBehaviorProfile('llama3.1').id);
    expect(profile.id).not.toBe('default');
  });

  it('resolves qwen2.5-coder profile for an HF-style scoped id', () => {
    const profile = getModelBehaviorProfile('Qwen/Qwen2.5-Coder-32B-Instruct');
    expect(profile.id).toBe(getModelBehaviorProfile('qwen2.5-coder:32b').id);
  });

  it('resolves deepseek-r1 profile for a router-scoped id', () => {
    const profile = getModelBehaviorProfile('deepseek/DeepSeek-R1');
    expect(profile.id).toBe(getModelBehaviorProfile('deepseek-r1:8b').id);
  });

  it('falls back to the default profile for unknown ids', () => {
    expect(getModelBehaviorProfile('acme/unknown-model-9b').id).toBe('default');
  });
});

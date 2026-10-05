/**
 * Behaviour profiles for qwen3 (8b/14b), which used to fall through to the default profile
 * (one tool call per reply, thinking left on). qwen3-coder and gpt-oss stay on the default
 * profile: on BanditBench a profile of their own made no difference that the benchmark
 * could see, and with the capability probe awaited they already get native tools and
 * native tool history. What each value rests on is written next to it in modelBehavior.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDiscoveredCapabilities,
  clearModelBehaviorOverrides,
  getModelBehaviorProfile,
  registerModelCapabilities,
  resolveOllamaRuntimeOptions,
  resolvePreferredToolProtocol
} from '../src';

afterEach(() => {
  clearModelBehaviorOverrides();
  clearDiscoveredCapabilities();
});

describe('qwen3 behaviour profile', () => {
  it('resolves for the qwen3 dense sizes, including the -cap aliases the benchmark uses', () => {
    expect(getModelBehaviorProfile('qwen3:8b').id).toBe('qwen3');
    expect(getModelBehaviorProfile('qwen3:8b-cap').id).toBe('qwen3');
    expect(getModelBehaviorProfile('qwen3:32b').id).toBe('qwen3');
    expect(getModelBehaviorProfile('qwen3:14b').id).toBe('qwen3-14b');
    expect(getModelBehaviorProfile('qwen3:14b-cap').id).toBe('qwen3-14b');
  });

  it('does not capture neighbouring families', () => {
    expect(getModelBehaviorProfile('qwen3.6:27b').id).toBe('qwen3.6');
    expect(getModelBehaviorProfile('qwen2.5-coder:32b').id).toBe('qwen2.5-coder');
    expect(getModelBehaviorProfile('bandit-logic:latest').id).toBe('bandit-logic');
    // No profile of their own: the default, with what the capability probe reports.
    expect(getModelBehaviorProfile('qwen3-coder:30b').id).toBe('default');
    expect(getModelBehaviorProfile('gpt-oss:20b').id).toBe('default');
    expect(getModelBehaviorProfile('qwen3-vl:8b').id).toBe('default');
    expect(getModelBehaviorProfile('qwen3.5:9b').id).toBe('default');
  });

  it('uses native tools with native tool history and a text fallback', () => {
    for (const model of ['qwen3:8b', 'qwen3:14b']) {
      expect(getModelBehaviorProfile(model).protocol).toMatchObject({
        preferred: 'native-tools',
        fallback: 'text-tools',
        nativeToolFailureFallback: true,
        toolHistory: 'native'
      });
      expect(resolvePreferredToolProtocol(model)).toBe('native-tools');
    }
  });

  it('may run up to four calls per reply', () => {
    expect(getModelBehaviorProfile('qwen3:8b').reliability.maxParallelTools).toBe(4);
    expect(getModelBehaviorProfile('qwen3:14b').reliability.maxParallelTools).toBe(4);
  });

  it('thinking: off for the 14B, the model\'s own default for the other sizes', () => {
    expect(getModelBehaviorProfile('qwen3:14b').prompting.thinking).toBe('off');
    expect(resolveOllamaRuntimeOptions('qwen3:14b').think).toBe(false);
    expect(resolveOllamaRuntimeOptions('qwen3:14b-cap').think).toBe(false);
    expect(getModelBehaviorProfile('qwen3:8b').prompting.thinking).toBe('auto');
    expect(resolveOllamaRuntimeOptions('qwen3:8b').think).toBeUndefined();
  });

  it('the 14B entry differs from the rest only in its thinking default', () => {
    const { id: _a, label: _b, match: _c, prompting: p14, ...rest14 } = getModelBehaviorProfile('qwen3:14b');
    const { id: _d, label: _e, match: _f, prompting: p8, ...rest8 } = getModelBehaviorProfile('qwen3:8b');
    expect(rest14).toEqual(rest8);
    expect({ ...p14, thinking: 'auto' }).toEqual(p8);
  });

  it('a profile does not change the window: it still comes from the capability probe', () => {
    registerModelCapabilities('qwen3:14b', { contextWindow: 32768, supportsJsonMode: true, supportsToolCalling: true, supportsVision: false, tier: 'medium' });
    expect(resolveOllamaRuntimeOptions('qwen3:14b').num_ctx).toBe(24576);
  });
});

describe('qwen3-coder and gpt-oss on the default profile', () => {
  it('get native tools and native tool history once the probe reports tool support', () => {
    for (const model of ['qwen3-coder:30b', 'gpt-oss:20b']) {
      registerModelCapabilities(model, { contextWindow: 32768, supportsJsonMode: true, supportsToolCalling: true, supportsVision: false, tier: 'medium' });
      expect(resolvePreferredToolProtocol(model)).toBe('native-tools');
      expect(getModelBehaviorProfile(model).protocol.toolHistory).toBe('native');
      // Thinking is left to the model: qwen3-coder has none, gpt-oss takes a level, not a boolean.
      expect(resolveOllamaRuntimeOptions(model).think).toBeUndefined();
    }
  });
});

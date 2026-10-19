/**
 * Per-reply tool-call cap. A model with no behavior profile falls into the
 * catch-all profile (cap 1, written for the text-tool envelope). On native
 * tools that cap dropped correct calls: qwen3.8:27b sent several reads or
 * edits per reply in 33 of 326 requests on the 2026-10-19 benchmark's
 * public tasks and had to re-request each dropped call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDiscoveredCapabilities,
  getModelBehaviorProfile,
  registerModelCapabilities,
  resolveMaxParallelTools,
  UNPROFILED_NATIVE_MAX_PARALLEL_TOOLS
} from '../src';

const nativeCaps = {
  contextWindow: 262144,
  supportsJsonMode: true,
  supportsToolCalling: true,
  supportsVision: false,
  tier: 'large' as const
};

afterEach(() => clearDiscoveredCapabilities());

describe('resolveMaxParallelTools', () => {
  it('keeps the measured cap of a profiled model', () => {
    expect(resolveMaxParallelTools('qwen3.6:27b')).toBe(getModelBehaviorProfile('qwen3.6:27b').reliability.maxParallelTools);
    expect(resolveMaxParallelTools('gemma4:26b')).toBe(2);
    expect(resolveMaxParallelTools('llama3.2:3b')).toBe(1);
  });

  it('gives an unprofiled model on native tools the native default', () => {
    registerModelCapabilities('qwen3.8:27b', nativeCaps);
    expect(getModelBehaviorProfile('qwen3.8:27b').id).toBe('default');
    expect(resolveMaxParallelTools('qwen3.8:27b')).toBe(UNPROFILED_NATIVE_MAX_PARALLEL_TOOLS);
    expect(UNPROFILED_NATIVE_MAX_PARALLEL_TOOLS).toBe(4);
  });

  it('keeps one call per reply for an unprofiled model on text tools', () => {
    registerModelCapabilities('mystery-model:7b', { ...nativeCaps, supportsToolCalling: false, tier: 'small' });
    expect(resolveMaxParallelTools('mystery-model:7b')).toBe(1);
  });

  it('follows the protocol the host actually uses when it passes one', () => {
    registerModelCapabilities('qwen3.8:27b', nativeCaps);
    // e.g. a provider that cannot send native tools
    expect(resolveMaxParallelTools('qwen3.8:27b', 'text-tools')).toBe(1);
    expect(resolveMaxParallelTools('unknown-model', 'native-tools')).toBe(4);
  });
});

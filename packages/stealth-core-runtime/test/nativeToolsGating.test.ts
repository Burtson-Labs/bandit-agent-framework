import { describe, expect, it } from 'vitest';
import {
  getModelCapabilities,
  getModelBehaviorProfile,
  registerModelCapabilities
} from '../src';

/**
 * Regression suite for the v1.7.340 bug.
 *
 * The bug: `queryOllamaModelCapabilities` hard-coded `supportsToolCalling:
 * false` for any model it queried via /api/show at boot, then wrote that
 * into `runtimeCapabilitiesCache`. `getModelCapabilities` consulted the
 * cache BEFORE `BUILT_IN_PROFILES`, so the cached entry silently masked
 * the hand-tuned profile. For bandit-logic and every other model with a
 * built-in profile, `supportsToolCalling: true` became `false`, the
 * `nativeTools` gate at `extension.ts:3981` evaluated false, `tools[]`
 * was never sent on `/api/chat`, the model emitted `<think>...</think>`
 * then halted, ollama's qwen3.5 parser EOF'd waiting for tool markup, and
 * the text-envelope fallback ran into the same parser and failed too.
 *
 * The fix lives in two places:
 *   1. modelCapabilities.ts — built-in profiles win over the cache.
 *   2. modelCapabilities.ts — queryOllamaModelCapabilities now reads
 *      Ollama's `capabilities[]` array instead of hard-coding false.
 *
 * These tests verify the COMBINED gating chain that the extension and
 * CLI actually evaluate at runtime. The cache-only path is covered by
 * modelCapabilities.test.ts; this file asserts the cross-module
 * invariant that gives every known tool-calling model native tool
 * forwarding even after auto-detection has polluted the cache.
 */

/** Mirror of the `nativeTools` expression in the two hosts
 * (apps/bandit-cli/src/cli.ts and apps/bandit-stealth/src/provider/
 * BanditStealthViewProvider.ts). Kept in sync verbatim so the test fails
 * the moment the gating drifts in either direction. */
function gateNativeTools(modelId: string, providerKind: 'ollama' | 'bandit' | 'openai-compatible'): boolean {
  const caps = getModelCapabilities(modelId);
  const behavior = getModelBehaviorProfile(modelId);
  return caps.supportsToolCalling
    && behavior.protocol.preferred === 'native-tools'
    && (providerKind === 'ollama' || providerKind === 'bandit' || providerKind === 'openai-compatible');
}

describe('nativeTools gating — every tool-calling model with a built-in profile must resolve native-tools on ollama AND bandit providers', () => {
  // Models where BOTH the capability profile advertises tool support AND
  // the behavior profile prefers `native-tools`. Some models advertise
  // `supportsToolCalling: true` at the capability layer but their behavior
  // profile tactically prefers `text-tools` (e.g. Gemma-derived bandit-core
  // variants — capability is real per the modern Ollama chat template, but
  // the training distribution makes the model more reliable at emitting
  // the legacy `<tool_call>{...}</tool_call>` XML envelope than the
  // native function-call schema). Those are intentionally NOT in this
  // list. Add only when both layers agree native-tools is the right
  // primary path. The test will fail loudly if any of them stop
  // gating correctly — that's what caught the v1.7.339 cache regression.
  const NATIVE_TOOLS_MODELS = [
    'bandit-logic',
    'bandit-logic:latest',
    'qwen3.6:27b',
    'qwen3.6:35b',
    'qwen2.5-coder:32b',
    'qwen2.5-coder:14b',
    // gemma3-derived models ≥26B (gemma4:26b/31b, gemma3:27b; bandit-core ≥12B)
    // expose native tool calling in Ollama (`Capabilities: tools`); the gemma4
    // profile was flipped to native-tools to use it.
    'gemma3:27b',
    'gemma4:26b',
    'gemma4:31b'
  ];

  it.each(NATIVE_TOOLS_MODELS)('resolves nativeTools=true for %s on ollama', (modelId) => {
    expect(gateNativeTools(modelId, 'ollama')).toBe(true);
  });

  it.each(NATIVE_TOOLS_MODELS)('resolves nativeTools=true for %s on bandit (cloud)', (modelId) => {
    expect(gateNativeTools(modelId, 'bandit')).toBe(true);
  });

  it.each(NATIVE_TOOLS_MODELS)('still resolves nativeTools=true for %s when auto-detector has polluted the cache', (modelId) => {
    // Reproduce the exact pollution shape `queryOllamaModelCapabilities`
    // wrote into the cache pre-fix: hard-coded supportsToolCalling: false,
    // tier guessed from parameter count, contextWindow defaulted.
    registerModelCapabilities(modelId, {
      contextWindow: 8192,
      supportsJsonMode: true,
      supportsToolCalling: false,
      supportsVision: false,
      tier: 'small',
      label: modelId
    });

    expect(gateNativeTools(modelId, 'ollama')).toBe(true);
    expect(gateNativeTools(modelId, 'bandit')).toBe(true);
  });
});

describe('nativeTools gating — text-tools models must NOT route through native-tools regardless of provider', () => {
  // Small gemma sizes (4b/12b, e2b/e4b) and llama3 base stay on text-tools —
  // too small to rely on the native envelope / llama3 base is text-only. The
  // larger gemma3-derived sizes (≥26B) DO advertise native tools and live in
  // NATIVE_TOOLS_MODELS above. These must NEVER flip to native just because
  // providerKind is 'ollama'.
  const TEXT_TOOLS_MODELS = [
    'gemma3:4b',
    'gemma3:12b',
    'gemma4:e2b',
    'gemma4:e4b',
    'llama3',
    'llama3:latest'
  ];

  it.each(TEXT_TOOLS_MODELS)('resolves nativeTools=false for %s on ollama (text-tools path)', (modelId) => {
    expect(gateNativeTools(modelId, 'ollama')).toBe(false);
  });
});

describe('nativeTools gating — openai-compatible providers gate by capability, same as ollama', () => {
  // Historically hard-excluded while the tool serialization shape was
  // unverified. That verification is done: buildNativeToolsSchema emits
  // the OpenAI {type:'function',...} shape, serializeBanditPayload
  // forwards `tools` (strictOpenAI strips Ollama-only body fields), and
  // extractTextFromBanditResponse translates tool_calls with both
  // string- and object-encoded arguments. The gate now treats
  // openai-compatible like ollama: capability + behavior decide.
  it('returns true for qwen2.5-coder:32b on openai-compatible (caps + behavior allow)', () => {
    expect(gateNativeTools('qwen2.5-coder:32b', 'openai-compatible')).toBe(true);
  });

  it('returns true for a vendor-prefixed HF-style id on openai-compatible', () => {
    expect(gateNativeTools('Qwen/Qwen2.5-Coder-32B-Instruct', 'openai-compatible')).toBe(true);
  });

  it('still returns false for text-tools models on openai-compatible', () => {
    expect(gateNativeTools('gemma4:e4b', 'openai-compatible')).toBe(false);
  });

  it('still returns false for unknown models on openai-compatible (conservative default)', () => {
    expect(gateNativeTools('acme/unknown-model-9b', 'openai-compatible')).toBe(false);
  });
});

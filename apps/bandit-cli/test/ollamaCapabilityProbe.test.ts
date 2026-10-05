/**
 * A turn must not choose its context window before the /api/show probe has answered.
 *
 * Before: the REPL fired the probe and forgot it, and one-shot mode never ran it, so a
 * model without a built-in profile could start a turn on the unknown-model fallback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDiscoveredCapabilities, getModelCapabilities, resolveOllamaRuntimeOptions } from '@burtson-labs/stealth-core-runtime';
import { __resetOllamaProbesForTests, probeOllamaModel } from '../src/agent/ollamaCapabilityProbe';

const SHOW_QWEN3_8B = {
  details: { family: 'qwen3', parameter_size: '8.2B' },
  capabilities: ['completion', 'tools', 'thinking'],
  model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }
};

const respondAfter = (ms: number, body: unknown, status = 200) =>
  vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return new Response(JSON.stringify(body), { status });
  });

afterEach(() => {
  vi.unstubAllGlobals();
  clearDiscoveredCapabilities();
  __resetOllamaProbesForTests();
});

describe('probeOllamaModel', () => {
  it('a turn that waits for the probe sees the probed window and tool channel', async () => {
    vi.stubGlobal('fetch', respondAfter(30, SHOW_QWEN3_8B));
    const pending = probeOllamaModel('qwen3:8b', 'http://ollama.test');
    // Not landed yet: this is what a turn that did not wait would have used.
    expect(getModelCapabilities('qwen3:8b').supportsToolCalling).toBe(false);
    await pending;
    expect(getModelCapabilities('qwen3:8b')).toMatchObject({ tier: 'medium', supportsToolCalling: true });
    expect(resolveOllamaRuntimeOptions('qwen3:8b').num_ctx).toBe(24576);
  });

  it('asks the server once per model, however many turns wait on it', async () => {
    const fetchMock = respondAfter(5, SHOW_QWEN3_8B);
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([
      probeOllamaModel('qwen3:8b', 'http://ollama.test'),
      probeOllamaModel('qwen3:8b', 'http://ollama.test/'),
      probeOllamaModel('QWEN3:8b', 'http://ollama.test')
    ]);
    await probeOllamaModel('qwen3:8b', 'http://ollama.test');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a failed probe never throws, leaves the fallback window, and is retried on the next turn', async () => {
    const failing = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    vi.stubGlobal('fetch', failing);
    await expect(probeOllamaModel('qwen3:8b', 'http://ollama.test')).resolves.toBeUndefined();
    expect(resolveOllamaRuntimeOptions('qwen3:8b').num_ctx).toBe(16384);

    const working = respondAfter(1, SHOW_QWEN3_8B);
    vi.stubGlobal('fetch', working);
    await probeOllamaModel('qwen3:8b', 'http://ollama.test');
    expect(working).toHaveBeenCalledTimes(1);
    expect(resolveOllamaRuntimeOptions('qwen3:8b').num_ctx).toBe(24576);
  });

  it('a model that is not installed resolves without registering anything', async () => {
    vi.stubGlobal('fetch', respondAfter(1, { error: 'model not found' }, 404));
    await probeOllamaModel('nope:1b', 'http://ollama.test');
    expect(getModelCapabilities('nope:1b').supportsToolCalling).toBe(false);
  });
});

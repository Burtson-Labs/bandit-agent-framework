/**
 * models.dev is a third-party host. It is consulted only for a public
 * OpenAI-compatible endpoint, never for one on this machine or the local
 * network, and never when the user opted out or turned on offline mode.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelsDevAllowed, queryModelsDevCapabilities } from '../src/runtime/modelsDevCatalog';

describe('modelsDevAllowed', () => {
  it('skips loopback and local-network model servers', () => {
    for (const url of [
      'http://127.0.0.1:1234/v1',
      'http://localhost:8000/v1',
      'http://[::1]:8080/v1',
      'http://192.168.1.51:8000/v1',
      'http://10.20.30.40/v1',
      'http://172.20.0.2:8000/v1',
      'http://gpu-node:8000/v1',
      'http://vllm.cluster.internal/v1',
      'http://llm.local/v1'
    ]) {
      expect(modelsDevAllowed(url, { env: {} }), url).toBe(false);
    }
  });

  it('allows public endpoints by default', () => {
    for (const url of ['https://api.openai.com/v1', 'https://openrouter.ai/api/v1', 'https://api.groq.com/openai/v1']) {
      expect(modelsDevAllowed(url, { env: {} }), url).toBe(true);
    }
  });

  it('honours BANDIT_NO_MODELS_DEV, BANDIT_OFFLINE and the host setting', () => {
    const url = 'https://api.openai.com/v1';
    expect(modelsDevAllowed(url, { env: { BANDIT_NO_MODELS_DEV: '1' } })).toBe(false);
    expect(modelsDevAllowed(url, { env: { BANDIT_OFFLINE: '1' } })).toBe(false);
    expect(modelsDevAllowed(url, { env: {}, disabled: true })).toBe(false);
  });
});

describe('queryModelsDevCapabilities', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('makes no request for a local server', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await queryModelsDevCapabilities('qwen3', 'http://127.0.0.1:11555/v1')).toBeNull();
    expect(await queryModelsDevCapabilities('gpt-4o', 'https://api.openai.com/v1', { disabled: true })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

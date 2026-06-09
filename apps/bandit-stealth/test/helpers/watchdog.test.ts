import { describe, expect, it } from 'vitest';
import { createNoTokenWatchdogError, resolveNoTokenWatchdog } from '../../src/helpers/watchdog';

describe('no-token watchdog helper', () => {
  it('uses env override before config or auto sizing', () => {
    const resolved = resolveNoTokenWatchdog({
      promptChars: 100_000,
      inflightPeers: 3,
      envValue: '90000',
      configValue: 120_000
    });

    expect(resolved).toMatchObject({ ms: 90_000, source: 'env' });
  });

  it('uses config override when env is unset', () => {
    const resolved = resolveNoTokenWatchdog({
      promptChars: 100_000,
      inflightPeers: 3,
      envValue: '',
      configValue: 150_000
    });

    expect(resolved).toMatchObject({ ms: 150_000, source: 'config' });
  });

  it('auto-sizes with a 120s floor, prompt scale, peer headroom, and 300s cap', () => {
    expect(resolveNoTokenWatchdog({ promptChars: 1_000, inflightPeers: 0 }).ms).toBe(120_000);
    expect(resolveNoTokenWatchdog({ promptChars: 1_000, inflightPeers: 2 }).ms).toBe(170_000);
    expect(resolveNoTokenWatchdog({ promptChars: 80_000, inflightPeers: 0 }).ms).toBe(160_000);
    expect(resolveNoTokenWatchdog({ promptChars: 250_000, inflightPeers: 2 }).ms).toBe(300_000);
  });

  it('tags watchdog errors for the shared loop retry path', () => {
    const err = createNoTokenWatchdogError({
      elapsedMs: 120_000,
      model: 'bandit-logic',
      think: true,
      messages: 3,
      promptChars: 42_000,
      chunksReceived: 0,
      thinkingChunks: 0,
      contentChunks: 0,
      firstChunkMs: null,
      firstThinkingMs: null,
      firstContentMs: null,
      peersAtStart: 0,
      inflightNow: 1,
      callId: 'chat-test',
      verbose: true
    });

    expect(err.code).toBe('WATCHDOG');
    expect(err.message).toContain('Bandit will retry');
    expect(err.message).toContain('model=bandit-logic');
  });
});

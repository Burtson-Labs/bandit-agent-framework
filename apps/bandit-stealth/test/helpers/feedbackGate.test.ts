import { describe, it, expect } from 'vitest';
import { canSendFeedback } from '../../src/helpers/endpoints';

describe('canSendFeedback', () => {
  it('sends a rating only for a signed-in Bandit user with feedback on', () => {
    expect(canSendFeedback({ enabled: true, providerKind: 'bandit', apiKey: 'bai_test' })).toBe(true);
    expect(canSendFeedback({ enabled: undefined, providerKind: 'bandit', apiKey: 'bai_test' })).toBe(true);
  });

  it('never sends for Ollama or another provider, even with a Bandit key stored', () => {
    for (const providerKind of ['ollama', 'openai', 'anthropic', 'custom']) {
      expect(canSendFeedback({ enabled: true, providerKind, apiKey: 'bai_test' })).toBe(false);
    }
  });

  it('never sends when feedback is off or there is no key', () => {
    expect(canSendFeedback({ enabled: false, providerKind: 'bandit', apiKey: 'bai_test' })).toBe(false);
    expect(canSendFeedback({ enabled: true, providerKind: 'bandit', apiKey: '  ' })).toBe(false);
    expect(canSendFeedback({ enabled: true, providerKind: 'bandit', apiKey: undefined })).toBe(false);
  });
});

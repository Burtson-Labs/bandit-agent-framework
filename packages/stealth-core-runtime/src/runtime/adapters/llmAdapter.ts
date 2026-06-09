import type { ProviderChatOptions, ProviderClient } from '@burtson-labs/agent-core';
import type { ILlmAdapter } from '../../internalTypes';

export function createLlmAdapter(provider: ProviderClient): ILlmAdapter {
  return {
    provider,
    stream(prompt: string, options?: ProviderChatOptions): AsyncIterable<string> {
      return provider.chat(prompt, options);
    }
  };
}

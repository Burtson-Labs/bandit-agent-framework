import type { StealthEmbeddingClient, StealthEmbeddingClientOptions } from '../internalTypes';
import { StealthEmbeddingClient as BanditEmbeddingClient } from '../embeddingClient';
import { OllamaEmbeddingClient } from '../ollamaEmbeddingClient';

export type EmbeddingsProvider = 'bandit' | 'ollama' | 'none';

export interface EmbeddingClientResolverDeps {
  getConfiguration(): { get<T>(section: string, defaultValue: T): T };
  getWorkspaceRoot(): string;
  fetchApiKey(): Promise<string | undefined>;
}

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

export function createEmbeddingClientResolver(deps: EmbeddingClientResolverDeps) {
  // Bandit path state
  let banditClient: StealthEmbeddingClient | undefined;
  let banditClientOptions: StealthEmbeddingClientOptions | undefined;

  // Ollama path state
  let ollamaClient: OllamaEmbeddingClient | undefined;
  let ollamaBaseUrl: string | undefined;
  let ollamaEmbedModel: string | undefined;

  async function getClient(): Promise<StealthEmbeddingClient | OllamaEmbeddingClient | undefined> {
    const configuration = deps.getConfiguration();
    const provider = configuration.get<EmbeddingsProvider>('embeddings.provider', 'ollama');

    if (provider === 'none') {
      return undefined;
    }

    if (provider === 'ollama') {
      const baseUrl =
        configuration.get<string>('ollamaBaseUrl', '') ||
        configuration.get<string>('ollamaUrl', DEFAULT_OLLAMA_URL) ||
        DEFAULT_OLLAMA_URL;
      const model = configuration.get<string>('embeddings.ollamaModel', DEFAULT_EMBED_MODEL) || DEFAULT_EMBED_MODEL;

      // Reuse existing client if config unchanged
      if (ollamaClient && ollamaBaseUrl === baseUrl && ollamaEmbedModel === model) {
        return ollamaClient;
      }

      ollamaClient = new OllamaEmbeddingClient({ baseUrl, model });
      ollamaBaseUrl = baseUrl;
      ollamaEmbedModel = model;
      return ollamaClient;
    }

    // provider === 'bandit'
    const baseUrl =
      configuration.get<string>('embeddingsUrl', 'https://api.burtson.ai/api/stealth/embeddings') ??
      'https://api.burtson.ai/api/stealth/embeddings';
    const apiKey = await deps.fetchApiKey();
    if (!apiKey) {
      return undefined;
    }
    const workspaceRoot = deps.getWorkspaceRoot();
    const options: StealthEmbeddingClientOptions = { baseUrl, apiKey, workspaceRoot };

    if (banditClient && banditClientOptions && banditClient.matches(options)) {
      return banditClient;
    }
    banditClient = new BanditEmbeddingClient(options);
    banditClientOptions = options;
    return banditClient;
  }

  return { getClient };
}

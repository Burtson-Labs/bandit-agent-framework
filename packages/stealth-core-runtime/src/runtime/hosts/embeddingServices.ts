import { createConnectorBus } from '../adapters/connectorBus';
import { createEmbeddingClientResolver } from '../embeddingClientResolver';
import { createEmbeddingManager } from '../embeddingManager';
import { OllamaEmbeddingClient } from '../../ollamaEmbeddingClient';
import type { IConnectorBus } from '../types';

interface HostConfiguration {
  get<T>(key: string, defaultValue: T): T;
}

export interface EmbeddingServicesDeps {
  telemetryHub: { postEmbedding(event: string, payload: Record<string, unknown>): Promise<void> };
  workspace: { normalizeRelativePath(value: string): string | undefined };
  setContextValue(key: string, value: unknown): void;
  getConfiguration(): HostConfiguration;
  getWorkspaceRoot(): string;
  fetchApiKey(): Promise<string | undefined>;
}

export function createEmbeddingServices(deps: EmbeddingServicesDeps): {
  connectorBus: IConnectorBus;
  embeddingManager: ReturnType<typeof createEmbeddingManager>;
  embeddingClientResolver: ReturnType<typeof createEmbeddingClientResolver>;
} {
  const connectorBus = createConnectorBus();
  const embeddingClientResolver = createEmbeddingClientResolver({
    getConfiguration: () => deps.getConfiguration(),
    getWorkspaceRoot: () => deps.getWorkspaceRoot(),
    fetchApiKey: () => deps.fetchApiKey()
  });
  const embeddingManager = createEmbeddingManager({
    connectorBus,
    normalizeRelativePath: (value) => deps.workspace.normalizeRelativePath(value),
    setContextValue: (key, value) => deps.setContextValue(key, value),
    emitTelemetry: (event, payload) => deps.telemetryHub.postEmbedding(event, payload),
    // embeddingManager only supports the bandit StealthEmbeddingClient.
    // OllamaEmbeddingClient is resolved separately by ContextBuilder for ask-mode context.
    getEmbeddingClient: async () => {
      const client = await embeddingClientResolver.getClient();
      return client instanceof OllamaEmbeddingClient ? undefined : client;
    }
  });
  connectorBus.register('embeddings', (action, payload) => embeddingManager.handleConnector(action, payload));
  return {
    connectorBus,
    embeddingManager,
    embeddingClientResolver
  };
}

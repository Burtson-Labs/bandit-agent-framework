import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const embeddingManagerModule = require(
  '@burtson-labs/stealth-core-runtime/dist/runtime/embeddingManager.js'
);
const embeddingClientResolverModule = require(
  '@burtson-labs/stealth-core-runtime/dist/runtime/embeddingClientResolver.js'
);
const { createEmbeddingServices } = require('@burtson-labs/stealth-core-runtime');

const handleConnectorMock = vi.fn();
const createEmbeddingManagerMock = vi.fn(() => ({
  handleConnector: handleConnectorMock
}));
const createEmbeddingClientResolverMock = vi.fn(() => ({
  getClient: vi.fn()
}));

vi.spyOn(embeddingManagerModule, 'createEmbeddingManager').mockImplementation(createEmbeddingManagerMock);
vi.spyOn(embeddingClientResolverModule, 'createEmbeddingClientResolver').mockImplementation(
  createEmbeddingClientResolverMock
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createEmbeddingServices', () => {
  it('routes connector calls through the connector bus', async () => {
    const telemetryHub = { postEmbedding: vi.fn() };
    const workspace = { normalizeRelativePath: vi.fn((value: string) => value) };
    const configuration = { get: vi.fn() } as any;

    const services = createEmbeddingServices({
      telemetryHub,
      workspace,
      setContextValue: vi.fn(),
      getConfiguration: () => configuration,
      getWorkspaceRoot: () => '/tmp',
      fetchApiKey: vi.fn()
    });

    expect(createEmbeddingManagerMock).toHaveBeenCalled();
    expect(createEmbeddingClientResolverMock).toHaveBeenCalled();

    await services.connectorBus.call('embeddings', 'search', { query: 'foo' });
    expect(handleConnectorMock).toHaveBeenCalledWith('search', { query: 'foo' });
  });
});

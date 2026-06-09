import { describe, expect, it, vi } from 'vitest';
import { createEmbeddingManager, type EmbeddingSearchHit, type IConnectorBus } from '@burtson-labs/stealth-core-runtime';

function createConnectorBus(response: unknown): IConnectorBus & { call: ReturnType<typeof vi.fn> } {
  return {
    call: vi.fn().mockResolvedValue(response)
  };
}

function createDeps(options?: {
  connectorResponse?: unknown;
  normalize?: (value: string) => string | undefined;
}) {
  const connectorBus = createConnectorBus(options?.connectorResponse ?? { ok: true, hits: [] });
  const setContextValue = vi.fn();
  const emitTelemetry = vi.fn().mockResolvedValue(undefined);
  const client = {
    upsertDocument: vi.fn().mockResolvedValue(undefined),
    searchDocuments: vi.fn().mockResolvedValue([{ path: 'src/App.tsx', score: 0.91 } satisfies EmbeddingSearchHit])
  };
  const getEmbeddingClient = vi.fn().mockResolvedValue(client);

  const manager = createEmbeddingManager({
    connectorBus,
    normalizeRelativePath: options?.normalize ?? ((value) => value.replace(/^\.\//, '')),
    setContextValue,
    emitTelemetry,
    getEmbeddingClient
  });

  return { manager, connectorBus, setContextValue, emitTelemetry, getEmbeddingClient, client };
}

describe('embeddingManager', () => {
  it('searchEmbeddingCandidates stores context and emits telemetry on success', async () => {
    const hits: EmbeddingSearchHit[] = [
      { path: 'src/index.tsx', score: 0.95 },
      { path: 'src/App.tsx', score: 0.92 }
    ];
    const { manager, connectorBus, setContextValue, emitTelemetry } = createDeps({
      connectorResponse: { ok: true, hits }
    });

    const result = await manager.searchEmbeddingCandidates('homepage update');

    expect(result).toEqual(hits);
    expect(connectorBus.call).toHaveBeenCalledWith('embeddings', 'search', {
      query: 'homepage update',
      limit: 8
    });
    expect(setContextValue).toHaveBeenCalledWith(
      'project.embeddingCandidates',
      hits.map((hit) => ({ path: hit.path, score: hit.score }))
    );
    expect(emitTelemetry).toHaveBeenCalledWith(
      'search',
      expect.objectContaining({ ok: true, count: hits.length })
    );
  });

  it('scheduleEmbeddingUpsert deduplicates pending writes and emits upsert telemetry', async () => {
    const { manager, connectorBus, emitTelemetry } = createDeps({
      connectorResponse: { ok: true }
    });
    const content = 'A'.repeat(200);

    manager.scheduleEmbeddingUpsert('./src/new-file.ts', content);
    manager.scheduleEmbeddingUpsert('./src/new-file.ts', content);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connectorBus.call).toHaveBeenCalledTimes(1);

    manager.scheduleEmbeddingUpsert('./src/new-file.ts', content);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connectorBus.call).toHaveBeenCalledTimes(2);
    expect(emitTelemetry).toHaveBeenCalledWith(
      'upsert',
      expect.objectContaining({ ok: true, path: 'src/new-file.ts' })
    );
  });

  it('mergeInsightWithEmbeddings deduplicates normalized paths', () => {
    const { manager } = createDeps();
    const insight = { title: 'goal', intent: 'feature', files: ['src/App.tsx'] } satisfies Partial<{
      title: string;
      intent: string;
      files: string[];
    }>;
    const hits: EmbeddingSearchHit[] = [
      { path: './src/App.tsx', score: 0.9 },
      { path: './src/components/Hero.tsx', score: 0.87 }
    ];

    const merged = manager.mergeInsightWithEmbeddings(insight as never, hits);

    expect(merged?.files).toEqual(['src/App.tsx', 'src/components/Hero.tsx']);
  });

  it('handleConnector delegates to the embedding client for search requests', async () => {
    const { manager, client } = createDeps();

    const response = await manager.handleConnector('search', { query: 'docs', limit: 4 });

    expect(response.ok).toBe(true);
    expect(client?.searchDocuments).toHaveBeenCalledWith('docs', 4);
  });
});

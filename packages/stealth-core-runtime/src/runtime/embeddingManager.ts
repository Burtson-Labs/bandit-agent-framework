import * as path from 'path';
import type { InferredGoal } from '../internalTypes';
import type { EmbeddingSearchHit, StealthEmbeddingClient } from '../internalTypes';
import type { IConnectorBus } from '../internalTypes';

const MIN_EMBEDDING_TEXT = 120;
const MAX_EMBEDDING_TEXT = 12000;

export interface EmbeddingManagerDeps {
  connectorBus: IConnectorBus;
  normalizeRelativePath(value: string): string | undefined;
  setContextValue(key: string, value: unknown): void;
  emitTelemetry(event: string, payload: Record<string, unknown>): Promise<void>;
  getEmbeddingClient(): Promise<StealthEmbeddingClient | undefined>;
}

export interface EmbeddingManager {
  handleConnector(
    action: string,
    payload: unknown
  ): Promise<{ ok: boolean; hits?: EmbeddingSearchHit[]; reason?: string }>;
  searchEmbeddingCandidates(goal: string): Promise<EmbeddingSearchHit[]>;
  mergeInsightWithEmbeddings(
    insight: InferredGoal | undefined,
    hits: EmbeddingSearchHit[]
  ): InferredGoal | undefined;
  scheduleEmbeddingUpsert(relativePath: string, content: string): void;
}

export function createEmbeddingManager(deps: EmbeddingManagerDeps): EmbeddingManager {
  const pendingWrites = new Map<string, Promise<void>>();

  async function handleConnector(
    action: string,
    payload: unknown
  ): Promise<{ ok: boolean; hits?: EmbeddingSearchHit[]; reason?: string }> {
    const client = await deps.getEmbeddingClient();
    if (!client) {
      return { ok: false, reason: 'client_unavailable' };
    }
    switch (action) {
      case 'upsert': {
        if (!payload || typeof payload !== 'object') {
          return { ok: false, reason: 'invalid_payload' };
        }
        const { path: relativePath, content, language } = payload as {
          path?: unknown;
          content?: unknown;
          language?: unknown;
        };
        if (typeof relativePath !== 'string' || typeof content !== 'string') {
          return { ok: false, reason: 'invalid_payload' };
        }
        await client.upsertDocument({
          path: relativePath,
          content,
          language: typeof language === 'string' ? language : undefined
        });
        return { ok: true };
      }
      case 'search': {
        if (!payload || typeof payload !== 'object') {
          return { ok: false, reason: 'invalid_payload' };
        }
        const { query, limit } = payload as { query?: unknown; limit?: unknown };
        if (typeof query !== 'string') {
          return { ok: false, reason: 'invalid_payload' };
        }
        const hits = await client.searchDocuments(query, typeof limit === 'number' ? limit : 8);
        return { ok: true, hits };
      }
      default:
        throw new Error(`Unsupported embeddings connector action: ${action}`);
    }
  }

  async function searchEmbeddingCandidates(goal: string): Promise<EmbeddingSearchHit[]> {
    try {
      const started = Date.now();
      const result = await deps.connectorBus.call<{ ok: boolean; hits?: EmbeddingSearchHit[]; reason?: string }>(
        'embeddings',
        'search',
        { query: goal, limit: 8 }
      );
      if (!result || !result.ok || !Array.isArray(result.hits)) {
        await deps.emitTelemetry('search', {
          ok: false,
          reason: result?.reason ?? 'connector_error',
          topHits: []
        });
        return [];
      }
      const hits = result.hits;
      const topHits = hits.slice(0, 3).map((hit) => ({
        path: hit.path,
        score: typeof hit.score === 'number' ? Number(hit.score.toFixed(4)) : undefined
      }));
      await deps.emitTelemetry('search', {
        ok: true,
        count: hits.length,
        latencyMs: Date.now() - started,
        topHits
      });
      if (hits.length > 0) {
        deps.setContextValue(
          'project.embeddingCandidates',
          hits.map((hit) => ({
            path: hit.path,
            score: hit.score
          }))
        );
      }
      return hits;
    } catch (error) {
      console.warn('Embedding search failed', error);
      await deps.emitTelemetry('search', {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        topHits: []
      });
      return [];
    }
  }

  function mergeInsightWithEmbeddings(
    insight: InferredGoal | undefined,
    hits: EmbeddingSearchHit[]
  ): InferredGoal | undefined {
    if (!hits.length) {
      return insight;
    }
    const hitPaths = hits
      .map((hit) => deps.normalizeRelativePath(hit.path) ?? hit.path)
      .filter((pathValue): pathValue is string => Boolean(pathValue));
    if (!hitPaths.length) {
      return insight;
    }
    const combined = dedupeFileList([...(insight?.files ?? []), ...hitPaths]);
    if (insight) {
      return { ...insight, files: combined };
    }
    return {
      title: 'Bandit agent goal',
      intent: 'feature',
      files: combined,
      rationale: 'Embedding search identified related files.'
    };
  }

  function scheduleEmbeddingUpsert(relativePath: string, content: string): void {
    const normalized = deps.normalizeRelativePath(relativePath) ?? relativePath;
    if (!normalized) {
      return;
    }
    if (!content || content.includes('\0')) {
      return;
    }
    const trimmed = content.trim();
    if (trimmed.length < MIN_EMBEDDING_TEXT) {
      return;
    }
    const snippet = trimmed.length > MAX_EMBEDDING_TEXT ? trimmed.slice(0, MAX_EMBEDDING_TEXT) : trimmed;
    if (pendingWrites.has(normalized)) {
      return;
    }
    const task = performEmbeddingUpsert(normalized, snippet)
      .catch((error) => console.warn(`Embedding upsert failed for ${normalized}`, error))
      .finally(() => pendingWrites.delete(normalized));
    pendingWrites.set(normalized, task);
    void task;
  }

  async function performEmbeddingUpsert(relativePath: string, content: string): Promise<void> {
    const started = Date.now();
    try {
      const result = await deps.connectorBus.call<{ ok: boolean; reason?: string }>('embeddings', 'upsert', {
        path: relativePath,
        content,
        language: detectLanguageFromPath(relativePath)
      });
      if (!result || !result.ok) {
        await deps.emitTelemetry('upsert', {
          ok: false,
          path: relativePath,
          reason: result?.reason ?? 'connector_error'
        });
        return;
      }
      await deps.emitTelemetry('upsert', {
        ok: true,
        path: relativePath,
        latencyMs: Date.now() - started
      });
    } catch (error) {
      await deps.emitTelemetry('upsert', {
        ok: false,
        path: relativePath,
        reason: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  function detectLanguageFromPath(relativePath: string): string | undefined {
    const ext = path.extname(relativePath).replace('.', '').toLowerCase();
    return ext || undefined;
  }

  function dedupeFileList(files: string[]): string[] {
    const seen = new Set<string>();
    const results: string[] = [];
    for (const file of files) {
      if (typeof file !== 'string') {
        continue;
      }
      const normalized = (deps.normalizeRelativePath(file) ?? file).trim();
      if (!normalized) {
        continue;
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(normalized);
    }
    return results;
  }

  return {
    handleConnector,
    searchEmbeddingCandidates,
    mergeInsightWithEmbeddings,
    scheduleEmbeddingUpsert
  };
}

/**
 * Local embeddings via Ollama using nomic-embed-text.
 *
 * Used as the in-process fallback when:
 * - GatewayApi Qdrant search is unavailable or the repo is not indexed
 * - Working offline
 * - Files only exist locally (new branches, uncommitted changes)
 *
 * Does NOT require a persistent Qdrant instance locally.
 * Embeddings are stored in memory and cleared per session.
 */

export interface OllamaEmbeddingClientOptions {
  baseUrl: string;
  model?: string;
}

export interface OllamaEmbeddingHit {
  path: string;
  score: number;
  content?: string;
}

interface StoredChunk {
  path: string;
  content: string;
  vector: number[];
}

const DEFAULT_MODEL = 'nomic-embed-text';
const BATCH_SIZE = 20;

export class OllamaEmbeddingClient {
  private readonly baseUrl: string;
  private readonly model: string;
  /** In-memory vector store — cleared per session, never persisted. */
  private readonly store: StoredChunk[] = [];

  constructor(options: OllamaEmbeddingClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model || DEFAULT_MODEL;
  }

  /** Embed a single text string and return its vector. */
  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text })
    });
    if (!response.ok) {
      throw new Error(`Ollama embeddings failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as { embedding?: number[] };
    if (!Array.isArray(data.embedding)) {
      throw new Error('Ollama embeddings response missing embedding array.');
    }
    return data.embedding;
  }

  /**
   * Upsert a file into the in-memory store.
   * Chunks large files into ~1000-char segments.
   */
  async upsertFile(path: string, content: string): Promise<void> {
    // Remove any existing chunks for this path
    const existing = this.store.findIndex(c => c.path === path);
    if (existing !== -1) {this.store.splice(existing, 1);}

    const chunks = chunkText(content, 1000);
    const batches = batch(chunks, BATCH_SIZE);

    for (const batchItems of batches) {
      await Promise.all(
        batchItems.map(async (chunk) => {
          try {
            const vector = await this.embed(chunk);
            this.store.push({ path, content: chunk, vector });
          } catch (err) {
            console.warn(`[ollamaEmbedding] Failed to embed chunk of ${path}:`, err);
          }
        })
      );
    }
  }

  /**
   * Semantic search over in-memory store.
   * Returns top-K chunks by cosine similarity.
   */
  async search(query: string, topK = 8): Promise<OllamaEmbeddingHit[]> {
    if (this.store.length === 0) {return [];}

    const queryVector = await this.embed(query);
    const scored = this.store.map(chunk => ({
      path: chunk.path,
      content: chunk.content,
      score: cosineSimilarity(queryVector, chunk.vector)
    }));

    scored.sort((a, b) => b.score - a.score);

    // Deduplicate by path, keeping best score per file
    const seen = new Map<string, OllamaEmbeddingHit>();
    for (const item of scored) {
      if (!seen.has(item.path)) {
        seen.set(item.path, { path: item.path, score: item.score, content: item.content });
      }
      if (seen.size >= topK) {break;}
    }

    return Array.from(seen.values());
  }

  /** Remove all stored chunks for a given file path. */
  evict(path: string): void {
    let i = this.store.length;
    while (i--) {
      if (this.store[i].path === path) {this.store.splice(i, 1);}
    }
  }

  /** Clear all in-memory embeddings. */
  clear(): void {
    this.store.length = 0;
  }

  get storedFileCount(): number {
    return new Set(this.store.map(c => c.path)).size;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {return 0;}
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {return [text];}
  const chunks: string[] = [];
  // Prefer splitting on newlines
  const lines = text.split('\n');
  let current = '';
  for (const line of lines) {
    if ((current + line).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += line + '\n';
  }
  if (current.trim()) {chunks.push(current.trim());}
  return chunks;
}

function batch<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

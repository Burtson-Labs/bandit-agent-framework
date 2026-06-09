const hashString = (value: string): string => {
  // Simple FNV-1a hash for deterministic IDs; avoids Node crypto in browser.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  // Ensure unsigned and render as hex.
  const hex = (hash >>> 0).toString(16);
  return hex.padStart(16, '0');
};

export interface EmbeddingDocument {
  path: string;
  content: string;
  language?: string;
  metadata?: Record<string, unknown>;
}

export interface EmbeddingSearchHit {
  id?: string;
  path: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface StealthEmbeddingClientOptions {
  baseUrl: string;
  apiKey: string;
  workspaceRoot: string;
}

const DEFAULT_BASE_URL = 'https://api.burtson.ai/api/stealth/embeddings';
const MAX_TEXT_LENGTH = 8000;

export class StealthEmbeddingClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly workspaceRoot: string;

  constructor(options: StealthEmbeddingClientOptions) {
    this.baseUrl = StealthEmbeddingClient.normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.workspaceRoot = options.workspaceRoot;
  }

  public matches(options: StealthEmbeddingClientOptions): boolean {
    return this.baseUrl === StealthEmbeddingClient.normalizeBaseUrl(options.baseUrl)
      && this.apiKey === options.apiKey
      && this.workspaceRoot === options.workspaceRoot;
  }

  public async upsertDocument(document: EmbeddingDocument): Promise<void> {
    const text = this.prepareText(document.content);
    if (!text) {
      return;
    }

    const metadata = {
      path: document.path,
      workspace: this.workspaceRoot,
      language: document.language,
      ...(document.metadata ?? {})
    };

    await this.post('/upsert', {
      id: this.buildVectorId(document.path),
      text,
      metadata
    });
  }

  public async searchDocuments(query: string, limit = 6): Promise<EmbeddingSearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const payload = {
      query: trimmed,
      limit
    };

    const response = await this.post('/search', payload);
    if (!Array.isArray(response)) {
      return [];
    }

    return response
      .map((entry) => this.mapSearchEntry(entry))
      .filter((hit): hit is EmbeddingSearchHit => Boolean(hit && hit.path));
  }

  private mapSearchEntry(entry: unknown): EmbeddingSearchHit | undefined {
    if (!entry || typeof entry !== 'object') {
      return undefined;
    }

    const payload = (entry as { payload?: Record<string, unknown> }).payload;
    const id = (entry as { id?: string }).id;
    const score = (entry as { score?: number }).score;
    const metadata = payload ?? {};
    const pathValue = this.extractPathFromMetadata(metadata);
    if (!pathValue) {
      return undefined;
    }
    return {
      id,
      score,
      path: pathValue,
      metadata
    };
  }

  private extractPathFromMetadata(metadata: Record<string, unknown>): string | undefined {
    const candidates = [
      metadata.path,
      metadata.file,
      metadata.filePath,
      metadata.filepath,
      metadata.source
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    return undefined;
  }

  private async post(endpoint: string, body: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await StealthEmbeddingClient.safeReadText(response);
      throw new Error(`Embedding request failed: ${response.status} ${response.statusText}${detail ? ` – ${detail}` : ''}`);
    }

    const text = await response.text();
    if (!text) {
      return undefined;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      console.warn('Failed to parse embedding response JSON', error);
      return undefined;
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private buildVectorId(pathValue: string): string {
    return hashString(`${this.workspaceRoot}:${pathValue}`);
  }

  private prepareText(content: string): string {
    if (!content) {
      return '';
    }
    const normalized = content.replace(/\r\n/g, '\n').trim();
    if (normalized.length <= MAX_TEXT_LENGTH) {
      return normalized;
    }
    return normalized.slice(0, MAX_TEXT_LENGTH);
  }

  private static async safeReadText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }

  private static normalizeBaseUrl(url: string | undefined): string {
    const fallback = DEFAULT_BASE_URL;
    if (!url) {
      return fallback;
    }
    const trimmed = url.trim();
    if (!trimmed) {
      return fallback;
    }
    return trimmed.replace(/\/$/, '');
  }
}

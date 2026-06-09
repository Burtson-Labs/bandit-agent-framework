/**
 * Gateway Semantic Search Adapter (Tier 1 context source).
 *
 * Queries the Qdrant vector index via GatewayApi.
 * Used when the current repo is indexed and GatewayApi is reachable.
 * Falls back to local OllamaEmbeddingClient when unavailable.
 *
 * Gateway endpoint: GET /api/stealth/github/search
 */

export interface GatewaySearchChunk {
  path: string;
  startLine?: number;
  endLine?: number;
  content: string;
  score: number;
}

export interface GatewayFileSummary {
  path: string;
  summary: string;
}

export interface GatewaySearchResult {
  chunks: GatewaySearchChunk[];
  fileSummaries: GatewayFileSummary[];
}

export interface GatewaySearchOptions {
  /** GatewayApi base URL — e.g. https://api.burtson.ai */
  gatewayUrl: string;
  /** Bearer token for auth. */
  apiKey: string;
  /** Workspace ID to scope results. */
  workspaceId: string;
}

export class GatewaySearchAdapter {
  private readonly gatewayUrl: string;
  private readonly apiKey: string;
  private readonly workspaceId: string;

  constructor(options: GatewaySearchOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.workspaceId = options.workspaceId;
  }

  /**
   * Semantic search via GatewayApi Qdrant index.
   * Returns top-K chunks + pre-computed file/folder summaries.
   */
  async search(
    query: string,
    topK = 8,
    fileGlob?: string
  ): Promise<GatewaySearchResult> {
    const params = new URLSearchParams({
      q: query,
      workspaceId: this.workspaceId,
      topK: String(topK)
    });
    if (fileGlob) {params.set('fileGlob', fileGlob);}

    const url = `${this.gatewayUrl}/api/stealth/github/search?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const detail = await safeText(response);
      throw new GatewaySearchError(
        `Gateway search failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`,
        response.status
      );
    }

    const data = await response.json() as Partial<GatewaySearchResult>;
    return {
      chunks: Array.isArray(data.chunks) ? data.chunks : [],
      fileSummaries: Array.isArray(data.fileSummaries) ? data.fileSummaries : []
    };
  }

  /**
   * Check if a specific repo is indexed in GatewayApi.
   * Returns the indexing status or null on error.
   */
  async getIndexStatus(repoId: string): Promise<{ ready: boolean; status: string } | null> {
    try {
      const url = `${this.gatewayUrl}/api/stealth/github/repo-index/${encodeURIComponent(repoId)}`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      if (!response.ok) {return null;}
      const data = await response.json() as Record<string, unknown>;
      const status = typeof data.indexingStatus === 'string' ? data.indexingStatus : 'unknown';
      return { ready: status === 'ready' || status === 'idle', status };
    } catch {
      return null;
    }
  }

  /**
   * Trigger repo indexing via GatewayApi.
   */
  async triggerIndex(repoId: string): Promise<boolean> {
    try {
      const url = `${this.gatewayUrl}/api/stealth/github/repos/${encodeURIComponent(repoId)}/index`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List workspaces accessible to the current user.
   * Used by the "Link workspace to Gateway" command.
   */
  async listWorkspaces(): Promise<Array<{ id: string; name: string; repoFullName?: string }>> {
    try {
      const url = `${this.gatewayUrl}/api/stealth/workspaces`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      if (!response.ok) {return [];}
      const data = await response.json() as unknown;
      if (!Array.isArray(data)) {return [];}
      return data.map((w: Record<string, unknown>) => ({
        id: String(w.id ?? ''),
        name: String(w.name ?? w.id ?? ''),
        repoFullName: typeof w.fullName === 'string' ? w.fullName : undefined
      }));
    } catch {
      return [];
    }
  }
}

export class GatewaySearchError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'GatewaySearchError';
  }
}

async function safeText(response: Response): Promise<string> {
  try { return await response.text(); } catch { return ''; }
}

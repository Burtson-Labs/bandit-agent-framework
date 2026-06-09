/**
 * Semantic search skill — auto-activated when users ask about code concepts,
 * architecture, or need to find code by meaning rather than literal text.
 *
 * Uses Ollama's nomic-embed-text model for local embeddings. Indexes workspace
 * files on first search and caches vectors in memory for the session.
 *
 * Requires Ollama running locally with nomic-embed-text installed:
 *   ollama pull nomic-embed-text
 */

import type { SkillManifest } from '../skill-types';
import type { AgentTool, ToolResult, ToolExecutionContext } from '../tool-types';

/** In-memory vector store shared across tool calls within a session. */
interface StoredChunk {
  path: string;
  content: string;
  vector: number[];
}

let store: StoredChunk[] = [];
let indexedPaths = new Set<string>();
let ollamaBaseUrl = 'http://localhost:11434';

async function embed(text: string): Promise<number[]> {
  const response = await fetch(`${ollamaBaseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    throw new Error(`Embedding failed: ${response.status}`);
  }
  const data = await response.json() as { embedding?: number[] };
  if (!Array.isArray(data.embedding)) {
    throw new Error('Embedding response missing vector');
  }
  return data.embedding;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {return 0;}
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function chunkText(text: string, maxChars = 800): string[] {
  if (text.length <= maxChars) {return [text];}
  const chunks: string[] = [];
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

async function indexFile(path: string, content: string): Promise<void> {
  if (indexedPaths.has(path)) {return;}
  const chunks = chunkText(content);
  for (const chunk of chunks) {
    try {
      const vector = await embed(chunk);
      store.push({ path, content: chunk, vector });
    } catch {
      // Skip failed chunks silently
    }
  }
  indexedPaths.add(path);
}

const semanticSearchTool: AgentTool = {
  name: 'semantic_search',
  description: 'Search the codebase by meaning, not just text. Finds code related to a concept even when the exact words differ. Automatically indexes workspace files on first use. Use this when search_code (regex) misses what you need.',
  parameters: [
    { name: 'query', description: 'Natural language description of what you are looking for (e.g. "authentication middleware", "database connection pooling", "error boundary component")', required: true },
    { name: 'file_glob', description: 'Optional glob to restrict which files are searched (e.g. "src/**/*.ts"). Defaults to all .ts/.tsx/.js/.jsx/.py files.' },
    { name: 'top_k', description: 'Number of results to return (default: 6)' }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const query = params.query?.trim();
    if (!query) {return { output: 'Error: query parameter is required', isError: true };}

    const topK = Math.min(parseInt(params.top_k ?? '6', 10) || 6, 15);
    const glob = params.file_glob ?? '**/*.{ts,tsx,js,jsx,py}';

    // If the store is empty, index workspace files first
    if (store.length === 0) {
      try {
        const files = await ctx.listFiles(glob);
        const toIndex = files.slice(0, 50); // Cap at 50 files for speed

        for (const file of toIndex) {
          try {
            const absPath =
              file.startsWith('/') ||
              file.startsWith('~') ||
              /^[A-Za-z]:[\\/]/.test(file) ||
              file.startsWith('\\\\')
                ? file
                : `${ctx.workspaceRoot}/${file}`;
            const content = await ctx.readFile(absPath);
            if (content.length > 0 && content.length < 50000) {
              await indexFile(file, content);
            }
          } catch {
            // Skip unreadable files
          }
        }

        if (store.length === 0) {
          return { output: 'No files could be indexed. Is nomic-embed-text installed? Run: ollama pull nomic-embed-text', isError: true };
        }
      } catch (err) {
        return {
          output: `Embedding search failed: ${err instanceof Error ? err.message : String(err)}. Ensure Ollama is running with nomic-embed-text.`,
          isError: true
        };
      }
    }

    // Search
    try {
      const queryVector = await embed(query);
      const scored = store.map(chunk => ({
        path: chunk.path,
        content: chunk.content,
        score: cosineSimilarity(queryVector, chunk.vector)
      }));

      scored.sort((a, b) => b.score - a.score);

      // Deduplicate by path, keeping best score per file
      const seen = new Map<string, { path: string; score: number; content: string }>();
      for (const item of scored) {
        if (!seen.has(item.path)) {
          seen.set(item.path, item);
        }
        if (seen.size >= topK) {break;}
      }

      const results = Array.from(seen.values());
      if (results.length === 0) {
        return { output: `No relevant results found for: "${query}"` };
      }

      const output = results.map((r, i) => {
        const preview = r.content.slice(0, 500);
        return `### ${i + 1}. ${r.path} (score: ${r.score.toFixed(3)})\n\`\`\`\n${preview}${r.content.length > 500 ? '\n...' : ''}\n\`\`\``;
      }).join('\n\n');

      return { output: `Found ${results.length} relevant files for "${query}":\n\n${output}` };
    } catch (err) {
      return {
        output: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true
      };
    }
  }
};

const indexWorkspaceTool: AgentTool = {
  name: 'index_workspace',
  description: 'Index workspace files for semantic search. Run this before semantic_search if you want to search more files or specific directories.',
  parameters: [
    { name: 'glob', description: 'Glob pattern of files to index (default: "**/*.{ts,tsx,js,jsx,py}")' },
    { name: 'max_files', description: 'Maximum number of files to index (default: 50)' }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const glob = params.glob ?? '**/*.{ts,tsx,js,jsx,py}';
    const maxFiles = Math.min(parseInt(params.max_files ?? '50', 10) || 50, 100);

    try {
      const files = await ctx.listFiles(glob);
      const toIndex = files.slice(0, maxFiles);
      let indexed = 0;
      let skipped = 0;

      for (const file of toIndex) {
        if (indexedPaths.has(file)) {
          skipped++;
          continue;
        }
        try {
          const absPath =
              file.startsWith('/') ||
              file.startsWith('~') ||
              /^[A-Za-z]:[\\/]/.test(file) ||
              file.startsWith('\\\\')
                ? file
                : `${ctx.workspaceRoot}/${file}`;
          const content = await ctx.readFile(absPath);
          if (content.length > 0 && content.length < 50000) {
            await indexFile(file, content);
            indexed++;
          }
        } catch {
          // Skip unreadable files
        }
      }

      return {
        output: `Indexed ${indexed} files (${skipped} already indexed, ${store.length} total chunks). Semantic search is ready.`
      };
    } catch (err) {
      return {
        output: `Indexing failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true
      };
    }
  }
};

export const semanticSearchSkill: SkillManifest = {
  id: 'search/semantic',
  name: 'Semantic Search',
  version: '1.0.0',
  description: 'Search codebase by meaning using local Ollama embeddings (nomic-embed-text). Finds conceptually related code.',
  instructions: 'Use semantic_search when you need to find code by concept (e.g. "authentication logic", "data validation") rather than exact text. Use search_code for literal/regex matches. The index is built automatically on first search.',
  activation: 'auto',
  triggerPatterns: [
    /\bfind.*related\b/i,
    /\bwhere.*handle/i,
    /\bhow.*implement/i,
    /\bwhat.*does\b/i,
    /\bunderstand\b/i,
    /\barchitecture\b/i,
    /\bexplain.*code\b/i,
    /\bsemantic/i
  ],
  tools: [semanticSearchTool, indexWorkspaceTool]
};

/**
 * Configure the Ollama base URL for the embedding client.
 * Call this before the skill is used if Ollama is not on localhost.
 */
export function configureSemanticSearchOllamaUrl(url: string): void {
  ollamaBaseUrl = url.replace(/\/+$/, '');
}

/**
 * Reset the in-memory index (e.g. on workspace change).
 */
export function resetSemanticIndex(): void {
  store = [];
  indexedPaths = new Set();
}

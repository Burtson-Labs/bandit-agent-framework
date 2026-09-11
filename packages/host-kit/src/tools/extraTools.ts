/**
 * Extra tools layered onto the core ToolRegistry for the CLI host:
 * - todo_write: in-agent todo tracking, persisted in-memory for the session
 * - web_fetch: GET a URL and return a trimmed text body
 * - web_search: query a search API (Tavily), return ranked snippets
 */

import type { AgentTool, ToolResult, ToolExecutionContext } from '@burtson-labs/agent-core';
import { appendMemory } from '../memory';
import { runGuardedWebFetch, type LookupAllFn, type PinnedTransport } from './ssrfGuard';

// Back-compat re-export: hosts and tests import the classifier from here.
export { isPrivateHost } from './ssrfGuard';

interface TodoItem {
  id: number;
  status: 'pending' | 'in_progress' | 'done';
  content: string;
}

/**
 * Models don't agree on status vocabulary — some emit `"done"`, others
 * `"complete"`, `"completed"`, `"in-progress"`, `"inprogress"`, etc.
 * Normalize to the three statuses the store actually stores so the UI
 * (which only knows `done` / `in_progress` / `pending`) reliably ticks
 * items off. Without this, a model saying `"complete"` leaves items
 * visually stuck on `○` forever despite the plan advancing.
 */
function normalizeStatus(raw: unknown): TodoItem['status'] {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[-\s]/g, '_') : '';
  if (s === 'done' || s === 'complete' || s === 'completed' || s === 'finished') return 'done';
  if (s === 'in_progress' || s === 'inprogress' || s === 'active' || s === 'working' || s === 'running') return 'in_progress';
  return 'pending';
}

export class TodoStore {
  private items: TodoItem[] = [];
  private nextId = 1;

  snapshot(): TodoItem[] {
    return [...this.items];
  }

  render(): string {
    if (this.items.length === 0) return '(no todos)';
    return this.items
      .map(t => {
        const mark = t.status === 'done' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
        return `${mark} ${t.id}. ${t.content}`;
      })
      .join('\n');
  }

  /**
   * Accepts a JSON array of { content, status? } to replace the list, or a
   * single string 'content' for append. Simple to be forgiving of small models.
   */
  upsert(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return 'No todo payload provided.';
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        // Small models (Qwen 2.5 Coder on S3Api
        // turn) sometimes pass a bare string array — ["Read X", "Edit Y"]
        // — instead of the documented [{content, status}] shape. Treat
        // each string as a pending todo with its content equal to the
        // string. Previous code did String(undefined ?? '') here and
        // rendered N empty bullets in the Plan block.
        //
        // Mark 2026-05-26: when the tool was declared with `type: string`,
        // the agent-core parser stringified each nested {content,status}
        // object on the way in. The array branch then saw a list of
        // JSON-SHAPED STRINGS like '{"content":"Install TypeScript",
        // "status":"done"}' and the string branch below set content
        // to the whole JSON dump — Plan rendered raw JSON instead of
        // a clean checklist. We now detect JSON-object-shaped strings
        // and re-parse them so the legacy path (and any provider that
        // still stringifies nested values) recovers the right shape.
        this.items = parsed.map((entry, i) => {
          if (typeof entry === 'string') {
            const candidate = entry.trim();
            if (candidate.startsWith('{') && candidate.endsWith('}')) {
              try {
                const obj = JSON.parse(candidate);
                if (obj && typeof obj === 'object' && typeof obj.content === 'string') {
                  return {
                    id: i + 1,
                    status: normalizeStatus(obj.status),
                    content: obj.content,
                  };
                }
              } catch {
                /* fall through to bare-string treatment */
              }
            }
            return { id: i + 1, status: 'pending' as const, content: entry };
          }
          return {
            id: i + 1,
            status: normalizeStatus(entry?.status),
            content: String(entry?.content ?? '')
          };
        });
        this.nextId = this.items.length + 1;
        return `Todo list updated (${this.items.length} items).`;
      }
      if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string') {
        this.items.push({ id: this.nextId++, status: normalizeStatus(parsed.status), content: parsed.content });
        return `Added todo #${this.items.length}.`;
      }
    } catch {
      // Fall through: treat as plain text append.
    }
    this.items.push({ id: this.nextId++, status: 'pending', content: trimmed });
    return `Added todo #${this.items.length}.`;
  }

  /**
   * A short progress summary the tool returns so the model reads a
   * clear "update succeeded, here's what's left" signal instead of
   * interpreting the echoed list as a reset. The trailing nudge is
   * deliberately blunt — bandit-core-1 and similar small models have
   * been observed to claim completion without invoking the write
   * tool, and this helper is the most direct place to remind the
   * model of the expectation between tool calls.
   */
  summary(): string {
    const done = this.items.filter(t => t.status === 'done').length;
    const inProgress = this.items.filter(t => t.status === 'in_progress').length;
    const pending = this.items.filter(t => t.status === 'pending');
    if (this.items.length === 0) return '';
    const nextPending = pending[0];
    const pieces = [
      `${done} of ${this.items.length} complete`,
      inProgress > 0 ? `${inProgress} in progress` : null,
      nextPending ? `next: "${nextPending.content}"` : null
    ].filter(Boolean);
    const status = pieces.join(' · ');
    if (done === this.items.length) {
      return `\n\n${status}. Before finalizing, verify the work is actually complete — a todo marked "done" is not proof the underlying change was made.`;
    }
    return `\n\n${status}. Continue the task — DO NOT claim completion in your response until the underlying work (write_file / apply_edit / replace_range / run_command) has actually executed.`;
  }
}

export function buildTodoWriteTool(store: TodoStore): AgentTool {
  return {
    name: 'todo_write',
    description: 'Track progress on the current task. Pass an array of {content, status} objects to replace the list, or a plain string to append one item. Call this whenever you change plans or finish a step.',
    parameters: [
      {
        name: 'items',
        description: 'Array of {content, status} objects, where status is one of "pending" | "in_progress" | "done". Send a real array — do NOT pre-stringify the objects.',
        required: true,
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'The todo item text shown to the user.' },
              status: {
                type: 'string',
                description: 'One of "pending" | "in_progress" | "done".',
                enum: ['pending', 'in_progress', 'done'],
              },
            },
            required: ['content'],
          },
        },
      }
    ],
    async execute(params: Record<string, string>, _ctx: ToolExecutionContext): Promise<ToolResult> {
      // params.items may arrive as a real array (native-tools providers
      // honouring the schema), a JSON string (text-tool-loop tool_call
      // parser), or undefined. The interface types params as
      // Record<string,string> but the agent runtime delivers richer
      // shapes when the param schema declares them — cast and normalize.
      // Normalize to a JSON string so the existing store.upsert()
      // text-based parsing keeps working unchanged; if a richer-shaped
      // array arrives, JSON.stringify round-trips it cleanly.
      const raw = (params as Record<string, unknown>).items;
      const serialized = typeof raw === 'string'
        ? raw
        : raw === undefined || raw === null
          ? ''
          : JSON.stringify(raw);
      const header = store.upsert(serialized);
      const summary = store.summary();
      return { output: `${header}\n\n${store.render()}${summary}`, isError: false };
    }
  };
}

/**
 * `remember` tool — persists a single fact to the workspace's BANDIT.md
 * so it survives across sessions. Use case: the user says "remember
 * that all my repos live in ~/Documents/GitHub" and wants the next
 * Bandit session to know that without being re-told.
 *
 * Why a dedicated tool instead of asking the model to apply_edit
 * BANDIT.md directly: small models (gemma4:e4b, qwen 4B) hallucinated
 * the existing file contents when invited to edit it, and even on
 * larger models the apply_edit dance for "append a bullet" was
 * comically inefficient (4-5 turns minimum). This is one tool call
 * with a single string parameter — same shape as todo_write.
 *
 * on the CLI: user said "you should add to your
 * memory where my repos are", model used `todo_write` thinking it was
 * the persistence mechanism, nothing actually landed on disk and the
 * next session knew nothing.
 */
export function buildRememberTool(): AgentTool {
  return {
    name: 'remember',
    description: 'Persist a single fact to project memory (BANDIT.md at the workspace root) so it survives across sessions. Use this when the user says "remember X", "always do Y", "note that I", or otherwise asks for cross-session persistence — NOT for transient task tracking (use `todo_write` for that). One bullet per call. Examples: "All repos live in ~/Documents/GitHub", "Prefer pnpm over npm", "Local Ollama at http://localhost:11434".',
    parameters: [
      { name: 'fact', description: 'The single fact to remember. Will be appended as a bullet under the "## Notes" heading in BANDIT.md (file is created with a minimal scaffold if missing).', required: true }
    ],
    async execute(params: Record<string, string>, ctx: ToolExecutionContext): Promise<ToolResult> {
      const fact = (params.fact ?? '').trim();
      if (!fact) return { output: 'Error: fact parameter is required and must be a non-empty string.', isError: true };
      try {
        const abs = await appendMemory(ctx.workspaceRoot, fact);
        return { output: `Saved to project memory: "${fact}"\n\nPersisted to ${abs}. The next Bandit session in this workspace will load this automatically.` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Could not write to BANDIT.md: ${msg}`, isError: true };
      }
    }
  };
}

/**
 * web_fetch — HTTP GET with a hardened SSRF guard (see ./ssrfGuard.ts
 * for the full threat model: DNS-rebinding pinning, per-hop redirect
 * re-validation, numeric/IPv6-mapped encoding normalization).
 *
 * Set BANDIT_ALLOW_PRIVATE_WEB_FETCH=1 to opt out of the private-range
 * blocking — appropriate when the user is intentionally pointing the
 * agent at internal docs.
 */
export interface WebFetchToolOptions {
  /** Test seam: override DNS resolution (hostname → all A/AAAA records). */
  lookup?: LookupAllFn;
  /** Test seam: override the pinned-connection transport. */
  transport?: PinnedTransport;
}

export function buildWebFetchTool(options: WebFetchToolOptions = {}): AgentTool {
  return {
    name: 'web_fetch',
    description: 'HTTP GET a URL and return a trimmed plaintext body (up to ~16 KB). Use for docs, RFCs, release notes. No JS execution, no auth.',
    parameters: [
      { name: 'url', description: 'Absolute http(s) URL', required: true }
    ],
    async execute(params: Record<string, string>, _ctx: ToolExecutionContext): Promise<ToolResult> {
      const raw = params.url?.trim();
      if (!raw) return { output: 'Missing url parameter.', isError: true };
      return runGuardedWebFetch(raw, {
        allowPrivate: process.env.BANDIT_ALLOW_PRIVATE_WEB_FETCH === '1',
        lookup: options.lookup,
        transport: options.transport
      });
    }
  };
}

export interface WebSearchToolOptions {
  /** Tavily API key. Falls back to env var TAVILY_API_KEY when omitted.
   * When neither is set, the tool returns a configuration error
   * (model can fall back to web_fetch with a known URL). */
  apiKey?: string;
  /** Override the search endpoint. Default: https://api.tavily.com/search */
  endpoint?: string;
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilyResponse {
  query?: string;
  answer?: string;
  results?: TavilyResult[];
}

/**
 * Build a `web_search` tool backed by Tavily (purpose-built for LLM
 * agents — returns ranked snippets, not raw HTML). When TAVILY_API_KEY
 * is unset the tool returns a clear configuration error so the model
 * can fall back to other tools (web_fetch with a known URL, ask the
 * user, etc.) instead of hallucinating results.
 *
 * Why Tavily over scraping or Google CSE:
 * - Generous free tier (1k req/mo at time of writing)
 * - Single API call returns ranked snippets ready for the model
 * - No CAPTCHA / rate-limit roulette like search-result scraping
 * - Optional `answer` field gives the model an LLM-summarized answer
 * directly when one fits the query
 */
export function buildWebSearchTool(options: WebSearchToolOptions = {}): AgentTool {
  const endpoint = options.endpoint ?? 'https://api.tavily.com/search';
  return {
    name: 'web_search',
    description: 'Search the web and return ranked snippets. Use for: looking up library APIs, finding documentation, checking what a CLI flag does, researching error messages. Each result has a title, URL, and a short content snippet — call `web_fetch` on the URL when you need the full page. Requires a Tavily API key (configure via the host or set TAVILY_API_KEY).',
    parameters: [
      { name: 'query', description: 'The search query — natural language works ("how to configure typescript paths"), keywords work too ("typescript paths config").', required: true },
      { name: 'num_results', description: 'Number of results to return. Default 5, max 10.', required: false }
    ],
    async execute(params: Record<string, string>, _ctx: ToolExecutionContext): Promise<ToolResult> {
      const query = params.query?.trim();
      if (!query) {
        return { output: 'Missing query parameter.', isError: true };
      }

      const apiKey = options.apiKey?.trim() || process.env.TAVILY_API_KEY?.trim();
      if (!apiKey) {
        return {
          output: 'web_search is not configured. Set the TAVILY_API_KEY environment variable (free tier: https://tavily.com), or use `web_fetch` with a known URL instead.',
          isError: true
        };
      }

      const requestedCount = Number.parseInt(params.num_results ?? '', 10);
      const maxResults = Number.isFinite(requestedCount) && requestedCount > 0
        ? Math.min(requestedCount, 10)
        : 5;

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            search_depth: 'basic',
            include_answer: true,
            max_results: maxResults
          }),
          signal: AbortSignal.timeout(15_000)
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          return {
            output: `Search failed: HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 240)}` : ''}`,
            isError: true
          };
        }

        const data = (await res.json()) as TavilyResponse;
        const results = Array.isArray(data.results) ? data.results : [];

        if (results.length === 0) {
          return {
            output: `No results for "${query}".${data.answer ? `\n\nDirect answer: ${data.answer}` : ''}`,
            isError: false
          };
        }

        const blocks: string[] = [];
        if (data.answer) {
          blocks.push(`Direct answer: ${data.answer}`);
          blocks.push('');
        }
        blocks.push(`Results for "${query}":`);
        results.slice(0, maxResults).forEach((r, idx) => {
          const title = r.title?.trim() || '(untitled)';
          const url = r.url?.trim() || '';
          const snippet = (r.content ?? '').trim();
          const trimmedSnippet = snippet.length > 600 ? snippet.slice(0, 600) + '…' : snippet;
          blocks.push('');
          blocks.push(`${idx + 1}. ${title}`);
          if (url) blocks.push(`   ${url}`);
          if (trimmedSnippet) blocks.push(`   ${trimmedSnippet}`);
        });

        return { output: blocks.join('\n'), isError: false };
      } catch (err) {
        return {
          output: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true
        };
      }
    }
  };
}

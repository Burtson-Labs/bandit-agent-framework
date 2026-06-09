/**
 * ContextBuilder — two-tier context assembly for the Bandit agent.
 *
 * Priority order:
 * 1. Gateway Qdrant search (Tier 1) — full-repo awareness via indexed embeddings
 * 2. Local nomic-embed-text (Tier 2) — in-memory fallback for offline/unindexed files
 * 3. Pinned files — current open file, git-modified files, always included
 *
 * Results are deduplicated by file path and capped to the model's context budget.
 */

import type { GatewaySearchAdapter } from '../gatewaySearchAdapter';
import type { OllamaEmbeddingClient } from '../ollamaEmbeddingClient';
import { getModelCapabilities, getContextFileLimit, getContextTokenBudget } from './modelCapabilities';

export interface ContextFile {
  path: string;
  content: string;
  /** Where the context came from, for status bar display and debugging. */
  source: 'pinned' | 'gateway' | 'local';
  score?: number;
}

export interface BuildContextOptions {
  /** Active model ID — used to look up tier and context budget. */
  modelId?: string;
  /** Currently open file in the editor. Always included if provided. */
  currentFilePath?: string;
  currentFileContent?: string;
  /** Additional always-included files (git-modified, package.json, etc.). */
  pinnedFiles?: Array<{ path: string; content: string }>;
  /** Gateway workspace ID. Required for Tier 1 search. */
  workspaceId?: string;
}

export interface BuiltContext {
  files: ContextFile[];
  /** Markdown-formatted context block ready to inject into a system prompt. */
  formatted: string;
  /** Highest-priority source that contributed results. */
  source: 'gateway' | 'local' | 'pinned-only' | 'none';
  /** Rough token estimate (chars / 4). */
  tokenEstimate: number;
}

export class ContextBuilder {
  constructor(
    private readonly gateway: GatewaySearchAdapter | undefined,
    private readonly localEmbeddings: OllamaEmbeddingClient | undefined
  ) {}

  async build(query: string, options: BuildContextOptions = {}): Promise<BuiltContext> {
    const caps = getModelCapabilities(options.modelId ?? '');
    const fileLimit = getContextFileLimit(caps.tier);
    const tokenBudget = getContextTokenBudget(caps);

    const seen = new Set<string>();
    const files: ContextFile[] = [];

    // ── Tier 1: Gateway Qdrant (semantic search over indexed repo) ────────────
    if (this.gateway && options.workspaceId) {
      try {
        const result = await this.gateway.search(query, fileLimit);
        for (const chunk of result.chunks) {
          if (seen.has(chunk.path)) {continue;}
          seen.add(chunk.path);
          files.push({
            path: chunk.path,
            content: chunk.content,
            source: 'gateway',
            score: chunk.score
          });
        }
      } catch {
        // Gateway unavailable — fall through to local embeddings.
      }
    }

    // ── Tier 2: Local in-memory embeddings (unindexed / offline files) ────────
    if (this.localEmbeddings && files.length < fileLimit) {
      try {
        const remaining = fileLimit - files.length;
        const hits = await this.localEmbeddings.search(query, remaining);
        for (const hit of hits) {
          if (seen.has(hit.path)) {continue;}
          seen.add(hit.path);
          files.push({
            path: hit.path,
            content: hit.content ?? '',
            source: 'local',
            score: hit.score
          });
        }
      } catch {
        // Local embeddings unavailable.
      }
    }

    // ── Tier 3: Pinned files (always included, prepended) ─────────────────────
    // Current open file goes first so the model always has immediate context.
    if (options.currentFilePath && options.currentFileContent) {
      if (!seen.has(options.currentFilePath)) {
        seen.add(options.currentFilePath);
        files.unshift({
          path: options.currentFilePath,
          content: options.currentFileContent,
          source: 'pinned'
        });
      }
    }

    for (const pinned of options.pinnedFiles ?? []) {
      if (!pinned.content.trim() || seen.has(pinned.path)) {continue;}
      seen.add(pinned.path);
      files.push({ path: pinned.path, content: pinned.content, source: 'pinned' });
    }

    const source: BuiltContext['source'] = files.some(f => f.source === 'gateway')
      ? 'gateway'
      : files.some(f => f.source === 'local')
        ? 'local'
        : files.length > 0
          ? 'pinned-only'
          : 'none';

    const formatted = this.formatForPrompt(files, tokenBudget);
    const tokenEstimate = Math.ceil(formatted.length / 4);

    return { files, formatted, source, tokenEstimate };
  }

  private formatForPrompt(files: ContextFile[], tokenBudget: number): string {
    if (!files.length) {return '';}

    const parts: string[] = ['### Relevant codebase context:'];
    let totalChars = parts[0].length;
    const charBudget = tokenBudget * 4;

    // Per-file character cap: distribute budget evenly so a single large file
    // cannot crowd out all others. Floor at 800 chars to keep tiny files useful.
    const nonEmptyCount = files.filter(f => f.content.trim()).length || 1;
    const perFileCapChars = Math.max(Math.floor(charBudget / nonEmptyCount), 800);

    for (const file of files) {
      const trimmed = file.content.trim();
      if (!trimmed) {continue;}
      const capped =
        trimmed.length > perFileCapChars
          ? trimmed.slice(0, perFileCapChars) + '\n… (truncated)'
          : trimmed;
      const block = `\n\n**${file.path}**\n\`\`\`\n${capped}\n\`\`\``;
      if (totalChars + block.length > charBudget) {break;}
      parts.push(block);
      totalChars += block.length;
    }

    return parts.length > 1 ? parts.join('') : '';
  }
}

/**
 * Slim context — replacement for the heavy ContextBuilder pipeline. The
 * heavy version (above) ran embeddings (Qdrant tier 1, nomic-embed-text
 * tier 2) on every turn, dumped full file *contents* into the system
 * prompt, and added 500 ms–2 s of latency per turn. Auto-context shipped
 * default-off because of that cost (earlier made the gate actually
 * fire).
 *
 * The slim version keeps what auto-context actually delivers — open-
 * editor awareness + recently-edited file signal — and drops the rest.
 * It injects ~5–15 lines of paths and statuses (no file contents, no
 * embeddings, no network), so even with the setting ON the cost is
 * essentially free: a `git status` on the workspace plus a token bump
 * in the noise (~50–150 tokens).
 *
 * The agent now uses its own tools (`read_file`, `grep`, `list_dir`) to
 * actually look at the files it cares about, instead of being handed a
 * pre-cooked excerpt that may or may not be the right one.
 *
 * Returns the same `BuiltContext` shape as the heavy builder so callers
 * (status bar, system prompt assembler) don't need conditional code.
 */
export interface SlimContextOptions {
  /** Absolute path of the file currently open in the editor, if any. */
  currentFilePath?: string;
  /** Recently modified files (git status), with optional status code (M/A/D/?). */
  gitModifiedFiles?: Array<{ path: string; status?: string }>;
  /** Cap on git-modified entries. Default: 10 — beyond that the list
   * becomes noise and the agent should grep / list_dir instead. */
  maxGitFiles?: number;
}

export function buildSlimContext(options: SlimContextOptions): BuiltContext {
  const maxGit = options.maxGitFiles ?? 10;
  const gitFiles = (options.gitModifiedFiles ?? []).slice(0, maxGit);

  const files: ContextFile[] = [];
  if (options.currentFilePath) {
    files.push({ path: options.currentFilePath, content: '', source: 'pinned' });
  }
  for (const f of gitFiles) {
    if (f.path === options.currentFilePath) {continue;}
    files.push({ path: f.path, content: '', source: 'pinned' });
  }

  if (files.length === 0) {
    return { files: [], formatted: '', source: 'none', tokenEstimate: 0 };
  }

  const lines: string[] = ['### Workspace context:'];
  if (options.currentFilePath) {
    lines.push(`- Open in editor: ${options.currentFilePath}`);
  }
  if (gitFiles.length > 0) {
    const list = gitFiles
      .map((f) => (f.status ? `${f.path} (${f.status})` : f.path))
      .join(', ');
    lines.push(`- Recently edited (git): ${list}`);
  }
  lines.push('');
  lines.push('Use `read_file` / `grep` / `list_dir` on these paths if relevant. The list is metadata only — file contents are NOT included.');
  const formatted = lines.join('\n');

  return {
    files,
    formatted,
    source: 'pinned-only',
    tokenEstimate: Math.ceil(formatted.length / 4)
  };
}

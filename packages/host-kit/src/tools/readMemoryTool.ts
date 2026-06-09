/**
 * `read_memory` — load a single topic file from `.bandit/memory/<name>.md`
 * (preferred) or the legacy `memory/<name>.md` on demand. Paired with
 * `loadMemoryIndex` (the MEMORY.md index injected into the system prompt
 * every turn). The agent decides whether a topic is relevant by reading the
 * index's hook, then calls this tool to pull the full file into context.
 *
 * Rejects path traversal (`..`, absolute paths). On miss, the error
 * lists the available slugs so the model can self-correct.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentTool, ToolResult, ToolExecutionContext } from '@burtson-labs/agent-core';
import {
  loadMemoryIndex,
  MAX_MEMORY_FILE_BYTES,
  BANDIT_MEMORY_DIR
} from '../memoryIndex';

export function buildReadMemoryTool(): AgentTool {
  return {
    name: 'read_memory',
    description:
      'Read a single topic memory file by slug. Use this when the memory index (shown in the system prompt) lists a topic whose hook matches the current task. The slug is the part after "memory/" in [Title](memory/<slug>.md) — without the .md suffix. Returns the full file content (capped at 32 KB).',
    parameters: [
      {
        name: 'name',
        description:
          'Memory file slug (no `memory/` prefix, no `.md` suffix). Example: "auth-conventions" loads .bandit/memory/auth-conventions.md (or the legacy memory/auth-conventions.md).',
        required: true
      }
    ],
    async execute(params: Record<string, string>, ctx: ToolExecutionContext): Promise<ToolResult> {
      const requested = (params.name ?? '').trim();
      if (!requested) {
        return { output: 'Error: name parameter is required.', isError: true };
      }
      // Reject path traversal and absolute paths up front — slug must be a
      // plain filename, not a path. The MEMORY.md format only ever yields
      // simple filenames (the parser enforces this on the index side),
      // and any model passing a `..` here is either confused or hostile.
      if (
        requested.includes('/') ||
        requested.includes('\\') ||
        requested.includes('..') ||
        path.isAbsolute(requested)
      ) {
        return {
          output: `Error: name must be a plain slug like "auth-conventions", not a path. Got: "${requested}"`,
          isError: true
        };
      }
      const slug = requested.replace(/\.md$/i, '');
      const index = await loadMemoryIndex(ctx.workspaceRoot);
      const entry = index.entries.find((e) => e.name === slug);
      if (!entry) {
        const available = index.entries.map((e) => e.name);
        if (available.length === 0) {
          const banditIndexPath = path.resolve(ctx.workspaceRoot, BANDIT_MEMORY_DIR, 'MEMORY.md');
          const rootIndexPath = path.resolve(ctx.workspaceRoot, 'MEMORY.md');
          return {
            output: `No memory index found. MEMORY.md is missing from both ${banditIndexPath} and ${rootIndexPath}.`,
            isError: true
          };
        }
        return {
          output: `Memory slug "${slug}" not found. Available: ${available.join(', ')}`,
          isError: true
        };
      }
      try {
        const raw = await fs.promises.readFile(entry.absPath);
        const truncated = raw.byteLength > MAX_MEMORY_FILE_BYTES;
        const text = raw.subarray(0, MAX_MEMORY_FILE_BYTES).toString('utf-8');
        const body = truncated ? `${text}\n… (truncated — file exceeds ${MAX_MEMORY_FILE_BYTES} bytes)` : text;
        return {
          output: `<!-- source: ${entry.relPath} -->\n${body}`,
          isError: false
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          output: `Could not read ${entry.relPath}: ${msg}`,
          isError: true
        };
      }
    }
  };
}

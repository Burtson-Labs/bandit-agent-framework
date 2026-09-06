/**
 * `get_artifact` — fetch a published artifact you own back INTO the workspace so you can
 * revise it, then republish with update_artifact (same URL). The read side of "make a
 * revision". Cloud-only.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentTool, ToolResult, ToolExecutionContext } from '@burtson-labs/agent-core';
import { getArtifact } from '../artifacts';

export function buildGetArtifactTool(opts: {
  token: string;
  s3ApiBaseUrl: string;
  authBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): AgentTool {
  return {
    name: 'get_artifact',
    description:
      'Fetch a published artifact you own back into the workspace so you can REVISE it. Pass its URL ' +
      '(from publish_artifact or list_artifacts). Writes the current content to a file under ' +
      '.bandit/artifacts/ and returns the path — edit that file, then call update_artifact with the SAME ' +
      'URL to publish the revision (the link stays the same). Cloud feature.',
    parameters: [
      { name: 'url', description: 'The artifact URL (or key) to fetch. Must be one you own.', required: true }
    ],
    async execute(params: Record<string, string>, ctx: ToolExecutionContext): Promise<ToolResult> {
      const target = (params.url ?? '').trim();
      if (!target) return { output: 'Error: the `url` parameter is required (the artifact URL or key to fetch).', isError: true };
      try {
        const fetched = await getArtifact({
          s3ApiBaseUrl: opts.s3ApiBaseUrl,
          authBaseUrl: opts.authBaseUrl,
          token: opts.token,
          keyOrUrl: target,
          fetchImpl: opts.fetchImpl
        });
        const root = (ctx as ToolExecutionContext & { workspaceRoot?: string }).workspaceRoot ?? process.cwd();
        const baseName = fetched.key.split('/').pop() || 'artifact';
        const outDir = path.join(root, '.bandit', 'artifacts');
        await fs.promises.mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, baseName);
        await fs.promises.writeFile(outPath, fetched.content, 'utf8');
        const rel = path.relative(root, outPath);
        const preview = fetched.content.slice(0, 400);
        return {
          output:
            `Fetched the artifact (${fetched.contentType}, ${fetched.content.length} chars) into "${rel}". ` +
            `Edit that file to make your revision, then call update_artifact with url "${target}" to publish it (same link).\n\n` +
            `--- current content (first 400 chars) ---\n${preview}${fetched.content.length > 400 ? '\n…(truncated — read the file for the full content)' : ''}`
        };
      } catch (err) {
        return { output: `Error fetching artifact: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  };
}

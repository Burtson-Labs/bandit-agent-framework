/**
 * `get_artifact` — fetch a published artifact you own from the cloud so the agent can
 * REVISE it. Returns the current content INLINE (straight from the API) — deliberately
 * does NOT write it to disk: Bandit's edit tools reject editing a pre-existing unread
 * file, which would force a redundant read_file and make it look like the content came
 * from the filesystem instead of the API. The model revises the returned content, writes
 * the new version to a fresh file, and calls update_artifact. Cloud-only.
 */
import type { AgentTool, ToolResult } from '@burtson-labs/agent-core';
import { getArtifact } from '../artifacts';

const MAX_INLINE = 150_000;

export function buildGetArtifactTool(opts: {
  token: string;
  s3ApiBaseUrl: string;
  authBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): AgentTool {
  return {
    name: 'get_artifact',
    description:
      'Fetch a published artifact you own from the cloud so you can REVISE it. Pass its URL (the dashboard ' +
      'link Bandit gave you, or from list_artifacts). Returns the CURRENT content inline, straight from the ' +
      'API — revise it, write the updated version to a NEW file, then call update_artifact with the SAME URL ' +
      'to publish the revision (the link stays the same). Cloud feature.',
    parameters: [
      { name: 'url', description: 'The artifact URL (or key) to fetch. Must be one you own.', required: true }
    ],
    async execute(params: Record<string, string>): Promise<ToolResult> {
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
        const full = fetched.content.length <= MAX_INLINE;
        const shown = full ? fetched.content : fetched.content.slice(0, MAX_INLINE);
        const name = fetched.key.split('/').pop() || 'artifact';
        return {
          output:
            `Here is the CURRENT published content of the artifact (${fetched.contentType}, ${fetched.content.length} chars), ` +
            `fetched from the API${full ? '' : ` — showing the first ${MAX_INLINE} chars`}. ` +
            `To revise it: make your changes to this content, write the updated version to a new file (e.g. "${name}"), ` +
            `then call update_artifact with url "${target}" and that file path — the link stays the same.\n\n` +
            `--- current content ---\n${shown}`
        };
      } catch (err) {
        return { output: `Error fetching artifact: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  };
}

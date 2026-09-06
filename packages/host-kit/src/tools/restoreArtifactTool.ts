/**
 * `restore_artifact` — bring an archived artifact back from cold storage so it can
 * be viewed/served again. Archived artifacts return a 409 when accessed; the agent
 * (or a user via this tool) restores on demand. Explicit + one-time, so a slow cold
 * tier is fine. Cloud-only.
 */
import type { AgentTool, ToolResult } from '@burtson-labs/agent-core';
import { restoreArtifact } from '../artifacts';

export function buildRestoreArtifactTool(opts: {
  token: string;
  s3ApiBaseUrl: string;
  authBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): AgentTool {
  return {
    name: 'restore_artifact',
    description:
      'Restore an ARCHIVED artifact from cold storage back to fast storage so it can be opened/shared again. ' +
      'Use when list_artifacts shows an artifact as archived, or opening one fails because it is archived. ' +
      'Pass the artifact URL (or key). Cloud feature.',
    parameters: [
      { name: 'url', description: 'The artifact URL (from list_artifacts) or its key. Must be one you own.', required: true }
    ],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      const target = (params.url ?? '').trim();
      if (!target) return { output: 'Error: the `url` parameter is required (the artifact URL or key to restore).', isError: true };
      try {
        await restoreArtifact({
          s3ApiBaseUrl: opts.s3ApiBaseUrl,
          authBaseUrl: opts.authBaseUrl,
          token: opts.token,
          keyOrUrl: target,
          fetchImpl: opts.fetchImpl
        });
        return { output: 'Restored the artifact from cold storage — it is back on fast storage and can be opened/shared again.' };
      } catch (err) {
        return { output: `Error restoring artifact: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  };
}

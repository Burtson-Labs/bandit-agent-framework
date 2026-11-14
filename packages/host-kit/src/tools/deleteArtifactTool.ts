/**
 * `delete_artifact` — let the AGENT delete one item from the user's Bandit Stash
 * (so "clean up that draft I saved" works in a turn). Deleting an item also
 * revokes its external share links. Destructive + permanent, so the
 * host's permission layer should gate it like any other side-effecting action;
 * the tool itself requires an explicit URL and never bulk-deletes.
 *
 * Thin wrapper over deleteArtifact. Cloud-only.
 */
import type { AgentTool, ToolResult } from '@burtson-labs/agent-core';
import { deleteArtifact } from '../artifacts';

export function buildDeleteArtifactTool(opts: {
  token: string;
  s3ApiBaseUrl: string;
  authBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): AgentTool {
  return {
    name: 'delete_artifact',
    description:
      'Permanently delete ONE item from the user\'s Bandit Stash (cloud) by its URL (or key), which also revokes any ' +
      'external share links for it. Use only when the user clearly asks to delete/remove a specific Stash item — get the ' +
      'URL from list_artifacts first. There is no undo and no bulk delete. Cloud feature.',
    parameters: [
      {
        name: 'url',
        description: 'The Stash item URL (from list_artifacts / publish_artifact) or its object key. Must be in the user\'s own Stash.',
        required: true
      }
    ],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      const target = (params.url ?? '').trim();
      if (!target) return { output: 'Error: the `url` parameter is required (the Stash item URL or key to delete).', isError: true };
      try {
        await deleteArtifact({
          s3ApiBaseUrl: opts.s3ApiBaseUrl,
          authBaseUrl: opts.authBaseUrl,
          token: opts.token,
          keyOrUrl: target,
          fetchImpl: opts.fetchImpl
        });
        return { output: `Deleted the item from Bandit Stash (and revoked any external links for it).` };
      } catch (err) {
        return { output: `Error deleting the Stash item: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  };
}

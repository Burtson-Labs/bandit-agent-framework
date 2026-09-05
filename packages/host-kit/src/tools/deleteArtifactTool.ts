/**
 * `delete_artifact` — let the AGENT delete one of the user's published Bandit
 * Artifacts (so "clean up that draft I published" works in a turn). Deleting an
 * artifact also revokes its external share links. Destructive + permanent, so the
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
      'Permanently delete ONE of the user\'s published Bandit Artifacts by its URL (or key), which also revokes any ' +
      'external share links for it. Use only when the user clearly asks to delete/remove a specific artifact — get the ' +
      'URL from list_artifacts first. There is no undo and no bulk delete. Cloud feature.',
    parameters: [
      {
        name: 'url',
        description: 'The artifact URL (from list_artifacts / publish_artifact) or its object key. Must be one you own.',
        required: true
      }
    ],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      const target = (params.url ?? '').trim();
      if (!target) return { output: 'Error: the `url` parameter is required (the artifact URL or key to delete).', isError: true };
      try {
        await deleteArtifact({
          s3ApiBaseUrl: opts.s3ApiBaseUrl,
          authBaseUrl: opts.authBaseUrl,
          token: opts.token,
          keyOrUrl: target,
          fetchImpl: opts.fetchImpl
        });
        return { output: `Deleted the artifact (and revoked any external links for it).` };
      } catch (err) {
        return { output: `Error deleting artifact: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  };
}

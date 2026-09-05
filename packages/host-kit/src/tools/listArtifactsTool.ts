/**
 * `list_artifacts` — let the AGENT see the user's published Bandit Artifacts
 * (their private ones + their team's shared ones), so "what have I published?"
 * or "find the report I shared" works in a turn, and so delete/share tools have
 * a URL to act on.
 *
 * Thin wrapper over listArtifacts. Cloud-only: registered only when a cloud token
 * is present, so local-only runs stay offline.
 */
import type { AgentTool, ToolResult } from '@burtson-labs/agent-core';
import { listArtifacts } from '../artifacts';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function buildListArtifactsTool(opts: {
  token: string;
  s3ApiBaseUrl: string;
  authBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): AgentTool {
  return {
    name: 'list_artifacts',
    description:
      'List the user\'s published Bandit Artifacts (their private ones and their team\'s shared ones), newest first, ' +
      'with each artifact\'s name, scope, size, and URL. Use this to answer "what have I published?" or to find an ' +
      'artifact\'s URL before sharing or deleting it. Cloud feature.',
    parameters: [
      {
        name: 'scope',
        description: 'Optional filter: "private" (only yours), "team" (your team\'s shared), or omit for both.',
        required: false
      }
    ],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      try {
        const items = await listArtifacts({
          s3ApiBaseUrl: opts.s3ApiBaseUrl,
          authBaseUrl: opts.authBaseUrl,
          token: opts.token,
          fetchImpl: opts.fetchImpl
        });
        const filter = (params.scope ?? '').trim().toLowerCase();
        const shown = filter === 'private'
          ? items.filter((a) => a.scope !== 'team')
          : filter === 'team'
            ? items.filter((a) => a.scope === 'team')
            : items;
        if (shown.length === 0) return { output: 'No artifacts found. Publish one with publish_artifact.' };
        const lines = shown.map((a) => {
          const name = a.key.split('/').pop() ?? a.key;
          const when = (a.lastModified || '').replace('T', ' ').slice(0, 16);
          return `- ${name} [${a.scope === 'team' ? 'team' : 'private'}] ${humanSize(a.size)} ${when} — ${a.url}`;
        });
        return { output: `${shown.length} artifact(s):\n${lines.join('\n')}` };
      } catch (err) {
        return { output: `Error listing artifacts: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  };
}

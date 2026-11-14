/**
 * `list_artifacts` — let the AGENT see the items in the user's Bandit Stash
 * (their private ones + their team's shared ones), so "what's in my Stash?"
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
      'List the items in the user\'s Bandit Stash (cloud; their private items and their team\'s shared ones), newest first, ' +
      'with each item\'s name, scope, size, and URL. Use this to answer "what\'s in my Stash?" / "what have I published?" or to find an ' +
      'item\'s URL before sharing or deleting it. Not git stash list. Cloud feature.',
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
        if (shown.length === 0) return { output: 'The Bandit Stash is empty. Save a file to it with publish_artifact.' };
        const lines = shown.map((a) => {
          const name = a.key.split('/').pop() ?? a.key;
          const when = (a.lastModified || '').replace('T', ' ').slice(0, 16);
          return `- ${name} [${a.scope === 'team' ? 'team' : 'private'}] ${humanSize(a.size)} ${when} — ${a.url}`;
        });
        return { output: `${shown.length} item(s) in Bandit Stash:\n${lines.join('\n')}` };
      } catch (err) {
        return { output: `Error listing Bandit Stash: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  };
}

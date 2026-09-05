/**
 * `publish_artifact` — let the AGENT publish a workspace file as a shareable
 * Bandit Artifact during a turn (so "make a README and publish it" works in one
 * go, instead of the user having to run the /artifact slash command by hand).
 *
 * Thin wrapper over publishArtifact (posts straight to S3Api). Cloud-only: the
 * host only registers this tool when a cloud token is present, so local-only
 * runs never see it and stay fully offline.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentTool, ToolResult, ToolExecutionContext } from '@burtson-labs/agent-core';
import { publishArtifact, guessContentType } from '../artifacts';

export function buildPublishArtifactTool(opts: { token: string; s3ApiBaseUrl: string; authBaseUrl?: string }): AgentTool {
  return {
    name: 'publish_artifact',
    description:
      'Publish a file from the workspace as a shareable Bandit Artifact and return a public URL anyone can open. ' +
      'Use this when the user asks to "publish", "share", or "make an artifact" of a file — write the file first, then call this with its path. Cloud feature.',
    parameters: [
      {
        name: 'path',
        description: 'Workspace-relative (or absolute) path to the file to publish, e.g. "README.md".',
        required: true
      },
      {
        name: 'scope',
        description: 'Visibility: "private" (default, only the user) or "team" (shared with their team). The link works for anyone either way.',
        required: false
      }
    ],
    async execute(params: Record<string, string>, ctx: ToolExecutionContext): Promise<ToolResult> {
      const rel = (params.path ?? '').trim();
      if (!rel) return { output: 'Error: the `path` parameter is required.', isError: true };

      const root = (ctx as ToolExecutionContext & { workspaceRoot?: string }).workspaceRoot ?? process.cwd();
      const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
      let bytes: Buffer;
      try {
        bytes = await fs.promises.readFile(abs);
      } catch {
        return { output: `Error: can't read "${rel}". Write the file first, then publish it.`, isError: true };
      }

      try {
        const scope = (params.scope ?? '').trim().toLowerCase() === 'team' ? 'team' : undefined;
        const artifact = await publishArtifact({
          s3ApiBaseUrl: opts.s3ApiBaseUrl,
          authBaseUrl: opts.authBaseUrl,
          token: opts.token,
          scope,
          content: new Uint8Array(bytes),
          filename: path.basename(abs),
          contentType: guessContentType(path.basename(abs))
        });
        return { output: `Published "${path.basename(abs)}"${scope === 'team' ? ' (shared with your team)' : ''} — shareable link: ${artifact.url}` };
      } catch (err) {
        return { output: `Error publishing artifact: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  };
}

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
import { publishArtifact, guessContentType, artifactKeyFromUrl } from '../artifacts';

export function buildPublishArtifactTool(opts: {
  token: string;
  s3ApiBaseUrl: string;
  authBaseUrl?: string;
  /** Stealth dashboard base (e.g. https://stealth.banditailabs.com). When set, the tool returns a
   *  dashboard deep-link to VIEW the artifact instead of the raw owner-only S3 URL (which 401s in a browser). */
  webBaseUrl?: string;
}): AgentTool {
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
        // The raw S3 URL is owner-only (401 in a browser), so hand the user a dashboard deep-link to
        // VIEW it (the dashboard signs them in and renders it). Keep the raw URL in the output only so
        // the model can chain to share_artifact when the user wants an external link.
        const name = path.basename(abs);
        const key = artifactKeyFromUrl(artifact.url);
        const dashUrl = opts.webBaseUrl
          ? `${opts.webBaseUrl.replace(/\/$/, '')}/artifacts?a=${encodeURIComponent(key)}`
          : null;
        const viewLine = dashUrl
          ? ` The user can open and manage it here (signs them in if needed): ${dashUrl}`
          : '';
        return {
          output:
            `Published "${name}"${scope === 'team' ? ' to the team' : ' (private)'}.` + viewLine +
            ` To create an external link anyone can open without signing in, call share_artifact with url "${artifact.url}".`
        };
      } catch (err) {
        return { output: `Error publishing artifact: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  };
}

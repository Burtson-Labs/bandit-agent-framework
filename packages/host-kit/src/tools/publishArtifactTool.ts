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
import { inlineHtmlImages } from '../imageInline';
import { derivePreviewMeta } from '../previewMeta';

/** Shared wording for the link-preview parameters (publish_artifact + update_artifact). */
export const ARTIFACT_TITLE_PARAM_DESCRIPTION =
  'Short human title for the page, at most 90 characters, no file extension (e.g. "Q3 latency review"). ' +
  'Shown as the headline when the link is pasted into Slack, Teams, iMessage and similar apps.';
export const ARTIFACT_DESCRIPTION_PARAM_DESCRIPTION =
  'One plain sentence, at most 200 characters, saying what the page shows (e.g. "p95 API latency by ' +
  'region for July to September, with the three slowest endpoints."). Shown under the title in link previews.';

export function buildPublishArtifactTool(opts: {
  token: string;
  s3ApiBaseUrl: string;
  authBaseUrl?: string;
  /** Stealth dashboard base (e.g. https://stealth.banditailabs.com). When set, the tool returns a
   *  dashboard deep-link to VIEW the artifact instead of the raw owner-only S3 URL (which 401s in a browser). */
  webBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): AgentTool {
  return {
    name: 'publish_artifact',
    description:
      'Publish a file from the workspace as a shareable Bandit Artifact and return a public URL anyone can open. ' +
      'Use this when the user asks to "publish", "share", or "make an artifact" of a file — write the file first, then call this with its path. ' +
      'Always pass `title` and `description`: they are what people see when the link is pasted into Slack, Teams, iMessage or email. ' +
      'Describe the content plainly; no marketing language. Cloud feature.',
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
      },
      { name: 'title', description: ARTIFACT_TITLE_PARAM_DESCRIPTION, required: false },
      { name: 'description', description: ARTIFACT_DESCRIPTION_PARAM_DESCRIPTION, required: false }
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
        const contentType = guessContentType(path.basename(abs));
        // For an HTML artifact, inline every <img> (local paths, the user's pastes, remote URLs) as
        // data URIs so it renders standalone — the whole point of "put an image in the artifact".
        let content = new Uint8Array(bytes);
        let inlineNote = '';
        if (contentType === 'text/html') {
          const r = await inlineHtmlImages(bytes.toString('utf8'), { baseDir: path.dirname(abs) });
          content = new Uint8Array(Buffer.from(r.html, 'utf8'));
          if (r.inlined) inlineNote = ` Inlined ${r.inlined} image(s).`;
          if (r.skipped) inlineNote += ` (${r.skipped} image(s) couldn't be inlined — unreachable, not an image, or too large.)`;
        }
        // Link-preview text: the model's values win; anything missing is derived from the
        // content (HTML <title>/<h1>, markdown heading/first paragraph). S3Api falls back too.
        const derived = derivePreviewMeta(content, contentType, path.basename(abs));
        const title = (params.title ?? '').trim() || derived.title;
        const description = (params.description ?? '').trim() || derived.description;
        const artifact = await publishArtifact({
          s3ApiBaseUrl: opts.s3ApiBaseUrl,
          authBaseUrl: opts.authBaseUrl,
          token: opts.token,
          scope,
          content,
          filename: path.basename(abs),
          contentType,
          title,
          description,
          fetchImpl: opts.fetchImpl
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
            `Published "${name}"${scope === 'team' ? ' to the team' : ' (private)'}` +
            `${title ? ` with the link-preview title "${title}"` : ''}.` + inlineNote + viewLine +
            ` To create an external link anyone can open without signing in, call share_artifact with url "${artifact.url}".`
        };
      } catch (err) {
        return { output: `Error publishing artifact: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  };
}

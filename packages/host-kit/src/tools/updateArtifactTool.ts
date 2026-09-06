/**
 * `update_artifact` — overwrite an artifact you already published IN PLACE (same URL) with
 * a revised workspace file. The write side of "make a revision". HTML gets the same image
 * inlining as publish so the revision stays self-contained. Cloud-only.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentTool, ToolResult, ToolExecutionContext } from '@burtson-labs/agent-core';
import { updateArtifact, guessContentType } from '../artifacts';
import { inlineHtmlImages } from '../imageInline';

export function buildUpdateArtifactTool(opts: {
  token: string;
  s3ApiBaseUrl: string;
  authBaseUrl?: string;
  /** Stealth dashboard base — when set, the tool returns a dashboard deep-link to view the update. */
  webBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): AgentTool {
  return {
    name: 'update_artifact',
    description:
      'Publish a REVISION of an artifact you already published, in place — same URL, updated content. ' +
      'Use for "revise/update the artifact": edit the file (e.g. the one get_artifact fetched), then call ' +
      'this with the artifact URL and the file path. The link does not change. Cloud feature.',
    parameters: [
      { name: 'url', description: 'The existing artifact URL (or key) to overwrite. Must be one you own.', required: true },
      { name: 'path', description: 'Workspace-relative (or absolute) path to the file with the revised content.', required: true }
    ],
    async execute(params: Record<string, string>, ctx: ToolExecutionContext): Promise<ToolResult> {
      const url = (params.url ?? '').trim();
      const rel = (params.path ?? '').trim();
      if (!url) return { output: 'Error: the `url` parameter is required (the artifact to update).', isError: true };
      if (!rel) return { output: 'Error: the `path` parameter is required (the file with the revised content).', isError: true };

      const root = (ctx as ToolExecutionContext & { workspaceRoot?: string }).workspaceRoot ?? process.cwd();
      const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
      let bytes: Buffer;
      try {
        bytes = await fs.promises.readFile(abs);
      } catch {
        return { output: `Error: can't read "${rel}". Write the revised file first, then update.`, isError: true };
      }

      try {
        const filename = path.basename(abs);
        const contentType = guessContentType(filename);
        // Mirror publish: inline every <img> for HTML so the revision stays self-contained.
        let content: string | Uint8Array = new Uint8Array(bytes);
        let inlineNote = '';
        if (contentType === 'text/html') {
          const r = await inlineHtmlImages(bytes.toString('utf8'), { baseDir: path.dirname(abs) });
          content = r.html;
          if (r.inlined) inlineNote = ` Inlined ${r.inlined} image(s).`;
          if (r.skipped) inlineNote += ` (${r.skipped} image(s) couldn't be inlined.)`;
        }
        const artifact = await updateArtifact({
          s3ApiBaseUrl: opts.s3ApiBaseUrl,
          authBaseUrl: opts.authBaseUrl,
          token: opts.token,
          keyOrUrl: url,
          content,
          filename,
          contentType,
          fetchImpl: opts.fetchImpl
        });
        const dashUrl = opts.webBaseUrl
          ? `${opts.webBaseUrl.replace(/\/$/, '')}/artifacts?a=${encodeURIComponent(artifact.key)}`
          : null;
        const viewLine = dashUrl ? ` View the updated artifact here: ${dashUrl}` : '';
        return { output: `Updated the artifact in place — same link, new content.${inlineNote}${viewLine}` };
      } catch (err) {
        return { output: `Error updating artifact: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  };
}

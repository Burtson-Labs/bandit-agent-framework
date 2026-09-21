/**
 * `get_artifact` — fetch a published artifact you own from the cloud so the agent can
 * REVISE it. Returns the current content INLINE (straight from the API) — deliberately
 * does NOT write it to disk: Bandit's edit tools reject editing a pre-existing unread
 * file, which would force a redundant read_file and make it look like the content came
 * from the filesystem instead of the API. The model revises the returned content, writes
 * the new version to a fresh file, and calls update_artifact. Cloud-only.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentTool, ToolResult, ToolExecutionContext } from '@burtson-labs/agent-core';
import { getArtifact } from '../artifacts';

/** PDFs, images and anything the API did not label as text: bytes, not a
 *  document the model can patch. */
export function isBinaryArtifact(contentType: string | undefined, name: string): boolean {
  const type = (contentType ?? '').toLowerCase();
  if (/^(application\/pdf|image\/|audio\/|video\/|application\/zip|application\/octet-stream)/.test(type)) {return true;}
  return /\.(pdf|png|jpe?g|gif|webp|zip|docx|pptx|xlsx)$/i.test(name);
}

// Inline cap ~6K tokens. 1.7.440 inlined up to 150K chars, and that giant tool
// result made the NEXT model call look like a cold start (huge prefill; on
// Ollama-backed models a bigger context can even force a model reload) — the
// "warming up… didn't answer in 120s" failure. Most artifacts fit well under
// this; larger ones take the on-disk path below.
const MAX_INLINE = 24_000;

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
    async execute(params: Record<string, string>, ctx: ToolExecutionContext): Promise<ToolResult> {
      const target = (params.url ?? '').trim();
      if (!target) {return { output: 'Error: the `url` parameter is required (the artifact URL or key to fetch).', isError: true };}
      try {
        const fetched = await getArtifact({
          s3ApiBaseUrl: opts.s3ApiBaseUrl,
          authBaseUrl: opts.authBaseUrl,
          token: opts.token,
          keyOrUrl: target,
          fetchImpl: opts.fetchImpl
        });
        const name = fetched.key.split('/').pop() || 'artifact';
        const binary = isBinaryArtifact(fetched.contentType, name);
        if (binary) {
          // A PDF or an image cannot be revised in place, and "make it look
          // like the original" is a design question that lives in the
          // HTML the PDF was rendered from — never in the PDF's bytes.
          const root = (ctx as ToolExecutionContext & { workspaceRoot?: string }).workspaceRoot ?? process.cwd();
          const outDir = path.join(root, '.bandit', 'artifacts');
          await fs.promises.mkdir(outDir, { recursive: true });
          const outPath = path.join(outDir, name);
          await fs.promises.writeFile(outPath, fetched.content, 'latin1');
          const rel = path.relative(root, outPath);
          return {
            output:
              `This artifact is BINARY (${fetched.contentType}, ${fetched.content.length} bytes) — saved a copy to "${rel}". ` +
              `It cannot be edited with apply_edit/replace_range. To revise it, regenerate it from its SOURCE and call update_artifact with url "${target}" and the new file:\n` +
              `- A PDF: find or rebuild the HTML it was rendered from (look next to it: .html/.md with the same name, a generate_* script, or a previous artifact whose HTML you can fetch with get_artifact), edit THAT, then render_pdf → preview_pdf → update_artifact.\n` +
              `- To make it look like ANOTHER artifact or document: fetch that reference's HTML with get_artifact (or read its source file) and reuse its <head>, CSS and page structure wholesale, replacing only the content. Do not rebuild from plain text — that discards the design the user is asking for.\n` +
              `- preview_pdf(path="${rel}") renders page images and reports text/ink per page, so you can compare the current artifact with your rebuild before publishing.`
          };
        }
        if (fetched.content.length <= MAX_INLINE) {
          // Common case: content comes back inline, straight from the API — revise
          // from this result and write the new version to a fresh file.
          return {
            output:
              `Here is the CURRENT published content of the artifact (${fetched.contentType}, ${fetched.content.length} chars), ` +
              `fetched from the API. To revise it: make your changes to this content, write the updated version to a new ` +
              `file (e.g. "${name}"), then call update_artifact with url "${target}" and that file path — the link stays the same.\n\n` +
              `--- current content ---\n${fetched.content}`
          };
        }
        // Large artifact: inlining it would flood the model's context (slow prefill /
        // context blowout reads as a fake "cold start"). Save it to disk and have the
        // model work on the FILE with targeted reads/edits instead of a full rewrite.
        const root = (ctx as ToolExecutionContext & { workspaceRoot?: string }).workspaceRoot ?? process.cwd();
        const outDir = path.join(root, '.bandit', 'artifacts');
        await fs.promises.mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, name);
        await fs.promises.writeFile(outPath, fetched.content, 'utf8');
        const rel = path.relative(root, outPath);
        return {
          output:
            `This artifact is large (${fetched.contentType}, ${fetched.content.length} chars) — too big to inline. ` +
            `Saved the CURRENT published content to "${rel}". For CONTENT changes revise it with TARGETED edits: read_file it, apply ` +
            `apply_edit/replace_range changes (do not rewrite the whole file), then call update_artifact with ` +
            `url "${target}" and path "${rel}" — the link stays the same. For a DESIGN change ("make it look like X"): fetch X with get_artifact ` +
            `(or read its source), keep X's <head>, CSS and structure wholesale, and move this artifact's content into it.\n\n` +
            `--- first ${Math.min(2000, fetched.content.length)} chars for orientation ---\n${fetched.content.slice(0, 2000)}`
        };
      } catch (err) {
        return { output: `Error fetching artifact: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  };
}

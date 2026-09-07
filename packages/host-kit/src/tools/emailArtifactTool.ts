/**
 * `email_artifact` — create an external share link for a published artifact and email
 * it to a recipient. The delivery half of the nightly morning brief: the agent
 * publishes the brief, then mails the link. Wraps emailShareLink (share + Postmark).
 * Cloud-only.
 */
import type { AgentTool, ToolResult } from '@burtson-labs/agent-core';
import { emailShareLink } from '../artifacts';

export function buildEmailArtifactTool(opts: {
  token: string;
  s3ApiBaseUrl: string;
  authBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): AgentTool {
  return {
    name: 'email_artifact',
    description:
      'Email a share link for a published artifact to a recipient. Pass the artifact URL (from ' +
      'publish_artifact) and the recipient email. Creates an external, expiring share link and ' +
      'sends it via email. Use AFTER publish_artifact when the user wants the result delivered. Cloud feature.',
    parameters: [
      { name: 'url', description: 'The artifact URL (or key) to share. Must be one you own.', required: true },
      { name: 'to', description: 'Recipient email address.', required: true }
    ],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      const url = (params.url ?? '').trim();
      const to = (params.to ?? '').trim();
      if (!url) return { output: 'Error: `url` is required (the artifact to share).', isError: true };
      if (!to || !to.includes('@')) return { output: 'Error: `to` must be a valid email address.', isError: true };
      try {
        const r = await emailShareLink({
          s3ApiBaseUrl: opts.s3ApiBaseUrl,
          authBaseUrl: opts.authBaseUrl,
          token: opts.token,
          keyOrUrl: url,
          to,
          fetchImpl: opts.fetchImpl
        });
        return {
          output: r.emailed
            ? `Emailed the share link to ${to}. Link: ${r.url}`
            : `Share link created (${r.url}) but email delivery is not configured/failed — give the user the link directly.`
        };
      } catch (err) {
        return { output: `Error emailing artifact: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  };
}

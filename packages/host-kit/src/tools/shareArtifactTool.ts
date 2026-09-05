/**
 * `share_artifact` — let the AGENT mint an EXTERNAL share link for an artifact
 * it already published (so "publish this report and give me a link I can send a
 * client" works in one turn). The link is a revocable, auto-expiring URL that
 * anyone can open — no Bandit account needed.
 *
 * Thin wrapper over createShareLink (S3Api's token endpoint). Cloud-only: the
 * host only registers this tool when a cloud token is present. External exposure
 * is deliberate, so hosts should gate this like any other outward-facing action
 * (the permission layer treats it as a network/side-effecting call).
 */
import type { AgentTool, ToolResult } from '@burtson-labs/agent-core';
import { createShareLink } from '../artifacts';

/** Parse "7d" / "12h" / "30m" / raw minutes → minutes. Undefined if absent/bad. */
function parseExpiryMinutes(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /^(\d+)\s*(d|h|m)?$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? 'm').toLowerCase();
  return unit === 'd' ? n * 24 * 60 : unit === 'h' ? n * 60 : n;
}

export function buildShareArtifactTool(opts: {
  token: string;
  s3ApiBaseUrl: string;
  authBaseUrl?: string;
  /** Test seam — injected fetch. Production leaves it unset (global fetch). */
  fetchImpl?: typeof fetch;
}): AgentTool {
  return {
    name: 'share_artifact',
    description:
      'Create an EXTERNAL share link for an artifact you already published — a URL anyone can open without a Bandit account. ' +
      'Use when the user asks to "share externally", "send this to someone outside", or "make a link for a client". ' +
      'Pass the artifact URL returned by publish_artifact (or its key). The link auto-expires and can be revoked later. Cloud feature.',
    parameters: [
      {
        name: 'url',
        description: 'The artifact URL from publish_artifact (or its object key). This must be an artifact you own.',
        required: true
      },
      {
        name: 'expires',
        description: 'Optional lifetime like "1d", "7d" (default), or "30d" (max). Prefer the shortest window that fits.',
        required: false
      }
    ],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      const target = (params.url ?? '').trim();
      if (!target) return { output: 'Error: the `url` parameter is required (the artifact URL or key).', isError: true };

      try {
        const link = await createShareLink({
          s3ApiBaseUrl: opts.s3ApiBaseUrl,
          authBaseUrl: opts.authBaseUrl,
          token: opts.token,
          keyOrUrl: target,
          expiryMinutes: parseExpiryMinutes(params.expires),
          fetchImpl: opts.fetchImpl
        });
        const when = (link.expiresAt || '').replace('T', ' ').slice(0, 16);
        return {
          output:
            `External share link${when ? ` (expires ${when} UTC)` : ''} — anyone with it can view:\n${link.url}\n` +
            `Revoke it later with this token: ${link.token}`
        };
      } catch (err) {
        return { output: `Error creating share link: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  };
}

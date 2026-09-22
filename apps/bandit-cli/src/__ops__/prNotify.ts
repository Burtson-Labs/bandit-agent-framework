/**
 * Self-improve PR notification — deterministic, no model.
 *
 * The weekly self-improve job opened its PR and then said nothing: the URL went
 * to stdout and died with the pod, so the only way to learn a proposal existed
 * was to go looking on GitHub. A loop nobody is told about is a loop nobody
 * reviews.
 *
 * Renders a small HTML summary of what was proposed, publishes it through the
 * same artifact pipeline the nightly brief uses, and mails the link — with the
 * PR URL as the first thing in the email.
 *
 * Deliberately deterministic: no agent, no prompt. The one job of this script is
 * to not be the reason the notification is missing.
 *
 * Flags:
 *   --pr <url>           the pull request to announce (required)
 *   --proposals <path>   proposals.json, for the summary body
 *   --to <email>         recipient; repeatable (default mark@burtson.ai)
 *   --out <path>         where the HTML is written before publishing
 *   --dry-run            render and report; no network calls
 */

import * as fs from 'fs';
import { publishArtifact, emailShareLink } from '@burtson-labs/host-kit';
import { loadConfigFiles, resolveConfig } from '../config';

interface Proposal {
  kind?: string;
  title?: string;
  rationale?: string;
  files?: Array<{ path?: string }>;
}

export interface PrNotifyArgs {
  pr: string;
  proposals?: string;
  to: string[];
  out: string;
  dryRun: boolean;
}

export function parsePrNotifyArgs(argv: string[]): PrNotifyArgs {
  const args: PrNotifyArgs = {
    pr: '',
    to: [],
    out: '/tmp/self-improve-pr.html',
    dryRun: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') args.pr = argv[++i] ?? '';
    else if (a === '--proposals') args.proposals = argv[++i];
    else if (a === '--to') args.to.push(argv[++i] ?? '');
    else if (a === '--out') args.out = argv[++i] ?? args.out;
    else if (a === '--dry-run') args.dryRun = true;
  }
  if (args.to.length === 0) args.to = ['mark@burtson.ai'];
  args.to = args.to.filter(Boolean);
  return args;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readProposals(filePath: string | undefined): Proposal[] {
  if (!filePath) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function renderPrHtml(prUrl: string, proposals: Proposal[]): string {
  const rows = proposals.map(p => {
    const files = (p.files ?? []).map(f => esc(f.path ?? '')).filter(Boolean);
    return (
      `<div style="margin:0 0 20px;padding:16px;background:#f6f8fa;border-left:3px solid #d0d7de;">` +
      `<div style="font-weight:600;margin-bottom:6px;">${esc(p.title ?? 'Untitled proposal')}` +
      `<span style="font-weight:400;color:#57606a;"> · ${esc(p.kind ?? 'proposal')}</span></div>` +
      (files.length > 0
        ? `<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#57606a;margin-bottom:8px;">${files.join('<br>')}</div>`
        : '') +
      `<div style="font-size:13px;color:#24292f;white-space:pre-wrap;">${esc(p.rationale ?? '')}</div>` +
      `</div>`
    );
  }).join('');

  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;color:#24292f;">` +
    `<h1 style="font-size:18px;margin:0 0 8px;">Bandit self-improve has proposals to review</h1>` +
    `<p style="margin:0 0 20px;font-size:15px;"><a href="${esc(prUrl)}" style="color:#0969da;">${esc(prUrl)}</a></p>` +
    (proposals.length > 0
      ? `<h2 style="font-size:14px;color:#57606a;margin:0 0 12px;">${proposals.length} proposal(s)</h2>${rows}`
      : `<p style="font-size:14px;color:#57606a;">No proposal detail was available to summarize.</p>`) +
    `<p style="font-size:12px;color:#57606a;margin-top:24px;">Proposals are machine-generated from the eval run and are not self-merging — review before merging.</p>` +
    `</div>`
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parsePrNotifyArgs(argv);
  if (!args.pr) {
    process.stderr.write('pr-notify: --pr is required\n');
    process.exit(2);
  }

  const proposals = readProposals(args.proposals);
  const html = renderPrHtml(args.pr, proposals);
  fs.writeFileSync(args.out, html, 'utf8');
  process.stdout.write(`pr-notify: wrote ${args.out} (${proposals.length} proposal(s))\n`);

  if (args.dryRun) {
    process.stdout.write(`pr-notify: dry run — would email ${args.to.join(', ')}\n`);
    return;
  }

  // Base URLs and token resolve exactly as the nightly brief does.
  const fileConfig = await loadConfigFiles(process.cwd());
  const resolved = resolveConfig(fileConfig, {});
  const token = resolved.apiKey ?? '';
  const urls = fileConfig as { s3?: { baseUrl?: string }; auth?: { baseUrl?: string } };
  const s3ApiBaseUrl = (urls.s3?.baseUrl ?? process.env.BANDIT_S3_URL ?? 'https://s3.burtson.ai').replace(/\/$/, '');
  const authBaseUrl = (urls.auth?.baseUrl ?? process.env.BANDIT_AUTH_URL ?? 'https://auth.burtson.ai').replace(/\/$/, '');

  if (!token) {
    process.stderr.write('pr-notify: BANDIT_API_KEY (or bandit.apiKey) is required to publish and email.\n');
    process.exit(1);
  }

  const published = await publishArtifact({
    s3ApiBaseUrl,
    authBaseUrl,
    token,
    content: html,
    filename: 'self-improve-pr.html',
    contentType: 'text/html; charset=utf-8'
  });

  if (!published?.url) {
    process.stderr.write('pr-notify: publish returned no URL — nothing to email\n');
    process.exit(1);
  }
  process.stdout.write(`pr-notify: published ${published.url}\n`);

  // One email per recipient, each independent: a single bad address must not
  // swallow the other's notification.
  const emailed: string[] = [];
  for (const to of args.to) {
    try {
      const result = await emailShareLink({
        s3ApiBaseUrl,
        authBaseUrl,
        token,
        keyOrUrl: published.url,
        to,
        message: `Bandit self-improve: proposals to review at ${args.pr}`
      });
      if (result?.emailed) {
        emailed.push(to);
        process.stdout.write(`pr-notify: emailed ${to}\n`);
      } else {
        process.stderr.write(`pr-notify: share link created but mail was not sent to ${to}\n`);
      }
    } catch (err) {
      process.stderr.write(`pr-notify: email to ${to} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  if (emailed.length === 0) {
    process.stderr.write('pr-notify: no email delivered\n');
    process.exit(1);
  }
}

/**
 * Nightly-brief FALLBACK — the deterministic email of last resort.
 *
 * The nightly bench normally asks the agent to write its own morning brief.
 * When the model is unavailable (cold start, rate limit, gateway blip) that
 * step produces nothing, and the result was that Mark got NO email at all on
 * exactly the nights something was wrong. This script closes that hole: it
 * reads the bench's own output files, renders a summary with no model in the
 * loop, publishes it, and mails the link to every recipient.
 *
 * It deliberately does the least possible work that can still fail: file
 * reads, one pure render, one upload, one email per recipient. Each recipient
 * is mailed independently so one bad address can't swallow the other's email.
 *
 * Flags (see brief.ts, the executable entry):
 *   --eval-json <path>   `eval --json-out` output (fixture pass/fail + reasons)
 *   --bench-json <path>  THIS run's `benchmark --baseline` output
 *   --baseline <path>    the frozen baseline to diff against
 *   --to <email>         recipient; repeatable. Defaults to the team pair.
 *   --out <path>         where the HTML is written before publishing
 *   --dry-run            render + report what WOULD be sent; no network calls
 */

import * as fs from 'fs';
import * as path from 'path';
import { publishArtifact, emailShareLink } from '@burtson-labs/host-kit';
import { loadConfigFiles, resolveConfig } from '../config';
import { compareToBaseline, type Baseline, type BaselineComparison } from './baselineCompare';
import { renderBriefHtml, summarizeBrief, type BriefInput } from './briefHtml';
import type { EvalJson } from './evalJson';

/** Who hears about the nightly by default. */
export const DEFAULT_RECIPIENTS = ['mark@burtson.ai', 'brett@burtson.com'];

export interface BriefArgs {
  evalJson?: string;
  benchJson?: string;
  baseline?: string;
  out: string;
  to: string[];
  dryRun: boolean;
}

export function parseBriefArgs(argv: string[]): BriefArgs {
  const args: BriefArgs = { out: '.bandit/nightly-brief.html', to: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--eval-json') args.evalJson = argv[++i];
    else if (a === '--bench-json') args.benchJson = argv[++i];
    else if (a === '--baseline') args.baseline = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--to') {
      const value = argv[++i];
      if (value) args.to.push(value);
    } else if (a === '--dry-run') args.dryRun = true;
  }
  if (args.to.length === 0) args.to = [...DEFAULT_RECIPIENTS];
  return args;
}

/** Injectable network seams — the tests stub both, `--dry-run` skips both. */
export interface BriefDeps {
  publish: (opts: {
    s3ApiBaseUrl: string;
    authBaseUrl: string;
    token: string;
    content: string;
    filename: string;
    contentType: string;
  }) => Promise<{ url: string }>;
  email: (opts: {
    s3ApiBaseUrl: string;
    authBaseUrl: string;
    token: string;
    keyOrUrl: string;
    to: string;
    message: string;
  }) => Promise<{ url: string; emailed: boolean }>;
  log?: (line: string) => void;
}

export interface BriefResult {
  html: string;
  subject: string;
  /** Absolute/shareable URL, or null on a dry run or publish failure. */
  url: string | null;
  /** Recipients the server accepted a send for. */
  emailed: string[];
  /** Recipients the send failed or was declined for. */
  failed: string[];
  notes: string[];
  dryRun: boolean;
}

/**
 * Read + JSON.parse, returning null instead of throwing. A missing or corrupt
 * input must degrade the brief, never cancel it — a half-empty email still
 * tells Mark the bench ran and something is off.
 */
function readJson<T>(filePath: string | undefined, label: string, notes: string[]): T | null {
  if (!filePath) return null;
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    notes.push(`${label} not found at ${filePath} — omitted from this brief.`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8')) as T;
  } catch (err) {
    notes.push(`${label} at ${filePath} could not be parsed (${err instanceof Error ? err.message : String(err)}).`);
    return null;
  }
}

/** Build the brief's inputs from disk. Exported for tests. */
export function collectBriefInput(args: BriefArgs): BriefInput {
  const notes: string[] = [];
  const evalJson = readJson<EvalJson>(args.evalJson, 'eval JSON report', notes);
  const current = readJson<Baseline>(args.benchJson, 'benchmark result', notes);
  const frozen = readJson<Baseline>(args.baseline, 'frozen baseline', notes);

  let comparison: BaselineComparison | null = null;
  if (current && frozen) {
    try {
      comparison = compareToBaseline(frozen, current);
    } catch (err) {
      notes.push(`baseline comparison failed (${err instanceof Error ? err.message : String(err)}).`);
    }
  } else if (current || frozen) {
    notes.push('baseline comparison skipped — it needs both this run\'s benchmark output and the frozen baseline.');
  }

  if (!evalJson) {
    notes.push('No eval results were available, so fixture pass/fail counts are missing from this brief.');
  }

  return { evalJson, comparison, notes };
}

export async function runBrief(args: BriefArgs, deps: BriefDeps, env: {
  token: string;
  s3ApiBaseUrl: string;
  authBaseUrl: string;
}): Promise<BriefResult> {
  const log = deps.log ?? (() => undefined);
  const input = collectBriefInput(args);
  const notes = [...(input.notes ?? [])];
  const summary = summarizeBrief(input);
  const html = renderBriefHtml({ ...input, notes });

  const outPath = path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  log(`brief html: ${outPath}`);

  if (args.dryRun) {
    log(`[dry-run] would publish ${path.basename(outPath)} and email ${args.to.join(', ')}`);
    return { html, subject: summary.subject, url: null, emailed: [], failed: [], notes, dryRun: true };
  }

  const filename = `banditbench-${(args.evalJson ? summary.verdict : 'brief')}-${new Date()
    .toISOString()
    .slice(0, 10)}.html`;

  let url: string;
  try {
    const artifact = await deps.publish({
      s3ApiBaseUrl: env.s3ApiBaseUrl,
      authBaseUrl: env.authBaseUrl,
      token: env.token,
      content: html,
      filename,
      contentType: 'text/html'
    });
    url = artifact.url;
    log(`published: ${url}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notes.push(`publish failed: ${message}`);
    log(`publish failed: ${message}`);
    return { html, subject: summary.subject, url: null, emailed: [], failed: [...args.to], notes, dryRun: false };
  }

  // One send per recipient — emailShareLink takes a single address, and an
  // independent call per person means one failure can't cost the other their
  // email.
  const emailed: string[] = [];
  const failed: string[] = [];
  for (const to of args.to) {
    try {
      const result = await deps.email({
        s3ApiBaseUrl: env.s3ApiBaseUrl,
        authBaseUrl: env.authBaseUrl,
        token: env.token,
        keyOrUrl: url,
        to,
        message: summary.subject
      });
      if (result.emailed) {
        emailed.push(to);
        log(`emailed ${to}`);
      } else {
        failed.push(to);
        log(`share link created but mail was not sent to ${to} (mail may be unconfigured): ${result.url}`);
      }
    } catch (err) {
      failed.push(to);
      const message = err instanceof Error ? err.message : String(err);
      notes.push(`email to ${to} failed: ${message}`);
      log(`email to ${to} failed: ${message}`);
    }
  }

  return { html, subject: summary.subject, url, emailed, failed, notes, dryRun: false };
}

export async function main(): Promise<void> {
  const args = parseBriefArgs(process.argv.slice(2));
  const log = (line: string) => process.stdout.write(`${line}\n`);

  const fileConfig = await loadConfigFiles(process.cwd());
  const resolved = resolveConfig(fileConfig, {});
  const token = resolved.apiKey;

  // Base URLs resolve exactly the way the CLI's /artifact command does.
  const s3 = fileConfig as { s3?: { baseUrl?: string }; auth?: { baseUrl?: string } };
  const s3ApiBaseUrl = (s3.s3?.baseUrl ?? process.env.BANDIT_S3_URL ?? 'https://s3.burtson.ai').replace(/\/$/, '');
  const authBaseUrl = (s3.auth?.baseUrl ?? process.env.BANDIT_AUTH_URL ?? 'https://auth.burtson.ai').replace(/\/$/, '');

  if (!args.dryRun && !token) {
    process.stderr.write('bandit brief: BANDIT_API_KEY (or bandit.apiKey in ~/.bandit/config.json) is required to publish and email.\n');
    process.exit(1);
  }

  const result = await runBrief(args, {
    publish: (opts) => publishArtifact(opts),
    email: (opts) => emailShareLink(opts),
    log
  }, { token: token ?? '', s3ApiBaseUrl, authBaseUrl });

  log(`\n${result.subject}`);
  if (result.dryRun) {
    process.exit(0);
  }

  // Exit non-zero only when NOBODY was reached — the caller logs it, and the
  // job's own exit code stays the bench verdict regardless.
  if (result.emailed.length === 0) {
    process.stderr.write(`bandit brief: no email was delivered (failed: ${result.failed.join(', ') || 'none'}).\n`);
    process.exit(1);
  }
  process.exit(0);
}

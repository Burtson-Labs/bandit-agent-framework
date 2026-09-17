/**
 * Deterministic publish + email of a file an agent produced.
 *
 * Exists because letting the agent publish and mail its own output makes every
 * content rule advisory: by the time a job can inspect what was written, the
 * mail has already left. Here the agent only writes a file; this step decides
 * whether it may leave the machine.
 *
 * `--forbid` is the point of the exercise. Patterns are checked against the file
 * BEFORE anything is published, and a match aborts with a non-zero exit — the
 * content is never uploaded and never mailed. That is a guarantee rather than an
 * instruction a model may or may not follow.
 *
 * Flags:
 *   --file <path>        the file to publish (required)
 *   --to <email>         recipient; repeatable (required)
 *   --subject <text>     email subject / artifact name
 *   --forbid <pattern>   case-insensitive regex that must NOT appear; repeatable
 *   --dry-run            run every check and report; no network calls
 */

import * as fs from 'fs';
import * as path from 'path';
import { publishArtifact, emailShareLink } from '@burtson-labs/host-kit';
import { loadConfigFiles, resolveConfig } from '../config';

export interface PublishEmailArgs {
  file: string;
  to: string[];
  subject: string;
  forbid: string[];
  dryRun: boolean;
}

export function parsePublishEmailArgs(argv: string[]): PublishEmailArgs {
  const args: PublishEmailArgs = { file: '', to: [], subject: '', forbid: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i] ?? '';
    else if (a === '--to') args.to.push(argv[++i] ?? '');
    else if (a === '--subject') args.subject = argv[++i] ?? '';
    else if (a === '--forbid') args.forbid.push(argv[++i] ?? '');
    else if (a === '--dry-run') args.dryRun = true;
  }
  args.to = args.to.filter(Boolean);
  args.forbid = args.forbid.filter(Boolean);
  return args;
}

export interface ForbiddenHit {
  pattern: string;
  /** The matched text, trimmed — enough to identify it without dumping the file. */
  sample: string;
}

/**
 * Every forbidden pattern that appears in `content`. Returns all hits rather
 * than the first: an operator fixing a denylist violation should see the whole
 * problem, not discover it one run at a time.
 */
export function findForbidden(content: string, patterns: string[]): ForbiddenHit[] {
  const hits: ForbiddenHit[] = [];
  for (const pattern of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      // An unparseable pattern must not silently disable the check.
      hits.push({ pattern, sample: '<invalid regex — treated as a violation>' });
      continue;
    }
    const m = re.exec(content);
    if (m) hits.push({ pattern, sample: m[0].slice(0, 80) });
  }
  return hits;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parsePublishEmailArgs(argv);
  if (!args.file || args.to.length === 0) {
    process.stderr.write('publish-email: --file and at least one --to are required\n');
    process.exit(2);
  }

  let content: string;
  try {
    content = fs.readFileSync(args.file, 'utf8');
  } catch (err) {
    process.stderr.write(`publish-email: cannot read ${args.file}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
    return;
  }

  if (!content.trim()) {
    process.stderr.write(`publish-email: ${args.file} is empty — nothing to send\n`);
    process.exit(1);
  }

  // Content gate FIRST. Nothing below this line runs on a violation.
  const hits = findForbidden(content, args.forbid);
  if (hits.length > 0) {
    process.stderr.write(
      `publish-email: REFUSING to publish ${args.file} — it matches ${hits.length} forbidden pattern(s):\n`);
    for (const h of hits) {
      process.stderr.write(`  - /${h.pattern}/i matched: ${JSON.stringify(h.sample)}\n`);
    }
    process.stderr.write('publish-email: nothing was published and no email was sent.\n');
    process.exit(1);
  }
  if (args.forbid.length > 0) {
    process.stdout.write(`publish-email: content cleared ${args.forbid.length} denylist pattern(s)\n`);
  }

  if (args.dryRun) {
    process.stdout.write(`publish-email: dry run — would send ${args.file} to ${args.to.join(', ')}\n`);
    return;
  }

  const fileConfig = await loadConfigFiles(process.cwd());
  const resolved = resolveConfig(fileConfig, {});
  const token = resolved.apiKey ?? '';
  const urls = fileConfig as { s3?: { baseUrl?: string }; auth?: { baseUrl?: string } };
  const s3ApiBaseUrl = (urls.s3?.baseUrl ?? process.env.BANDIT_S3_URL ?? 'https://s3.burtson.ai').replace(/\/$/, '');
  const authBaseUrl = (urls.auth?.baseUrl ?? process.env.BANDIT_AUTH_URL ?? 'https://auth.burtson.ai').replace(/\/$/, '');

  if (!token) {
    process.stderr.write('publish-email: BANDIT_API_KEY (or bandit.apiKey) is required.\n');
    process.exit(1);
  }

  const published = await publishArtifact({
    s3ApiBaseUrl,
    authBaseUrl,
    token,
    content,
    filename: path.basename(args.file),
    contentType: 'text/html; charset=utf-8'
  });

  if (!published?.url) {
    process.stderr.write('publish-email: publish returned no URL — nothing to email\n');
    process.exit(1);
  }
  process.stdout.write(`publish-email: published ${published.url}\n`);

  const emailed: string[] = [];
  for (const to of args.to) {
    try {
      const result = await emailShareLink({
        s3ApiBaseUrl,
        authBaseUrl,
        token,
        keyOrUrl: published.url,
        to,
        message: args.subject || 'Shared from Bandit'
      });
      if (result?.emailed) {
        emailed.push(to);
        process.stdout.write(`publish-email: emailed ${to}\n`);
      } else {
        process.stderr.write(`publish-email: share link created but mail was not sent to ${to}\n`);
      }
    } catch (err) {
      process.stderr.write(`publish-email: email to ${to} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  if (emailed.length === 0) {
    process.stderr.write('publish-email: no email delivered\n');
    process.exit(1);
  }
}

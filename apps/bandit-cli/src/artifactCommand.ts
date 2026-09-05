/**
 * `bandit artifact` — manage shareable Bandit Artifacts. Cloud-only (needs a
 * Bandit `bai_` cloud key, which the host-kit client exchanges for a gateway JWT
 * before calling S3Api); local-only users get a clear message instead of a
 * broken call, keeping the offline path offline.
 *
 *   bandit artifact <path>        publish a file, print the shareable link
 *   bandit artifact ls            list your artifacts
 *   bandit artifact rm <url|key>  delete one
 *   bandit artifact clear [--yes] delete all of yours (prompts unless --yes)
 *
 * Thin wrapper over host-kit (publishArtifact / listArtifacts / deleteArtifact /
 * clearArtifacts), which own the S3Api calls + the bai_→JWT exchange.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'node:readline';
import {
  publishArtifact,
  listArtifacts,
  deleteArtifact,
  clearArtifacts,
  guessContentType
} from '@burtson-labs/host-kit';
import { c, glyph, linkify } from './ansi';
import { renderPublishedLink } from './linkShare';
import { loadConfigFiles, resolveConfig } from './config';

/** S3Api base — config `s3.baseUrl`, else BANDIT_S3_URL, else the prod host. */
function resolveS3ApiBaseUrl(fileConfig: { s3?: { baseUrl?: string } }): string {
  return (fileConfig.s3?.baseUrl ?? process.env.BANDIT_S3_URL ?? 'https://s3.burtson.ai').replace(/\/$/, '');
}

/** AuthApi base (for the bai_→JWT exchange) — config `auth.baseUrl`, else env, else prod. */
function resolveAuthBaseUrl(fileConfig: { auth?: { baseUrl?: string } }): string {
  return (fileConfig.auth?.baseUrl ?? process.env.BANDIT_AUTH_URL ?? 'https://auth.burtson.ai').replace(/\/$/, '');
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // non-interactive: require --yes
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => rl.question(question, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function runArtifactCommand(argv: string[], cwd: string): Promise<void> {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const sub = (positional[0] ?? '').toLowerCase();

  const fileConfig = await loadConfigFiles(cwd);
  const resolved = resolveConfig(fileConfig, {});
  if (!resolved.apiKey) {
    process.stdout.write(
      c.yellow(`  ${glyph.warn} Artifacts are a Bandit cloud feature — no API key found.\n`) +
      c.dim('     Sign in / set your key, then retry. (Local-only stays fully offline.)\n')
    );
    return;
  }
  const base = {
    s3ApiBaseUrl: resolveS3ApiBaseUrl(fileConfig as { s3?: { baseUrl?: string } }),
    authBaseUrl: resolveAuthBaseUrl(fileConfig as { auth?: { baseUrl?: string } }),
    token: resolved.apiKey
  };
  // --team shares with the team's space; default is private (only you).
  const team = argv.includes('--team');

  // ── list ────────────────────────────────────────────────────────────────
  if (sub === 'ls' || sub === 'list') {
    try {
      const items = await listArtifacts(base);
      if (items.length === 0) {
        process.stdout.write(c.dim('  no artifacts yet — `bandit artifact <file>` publishes one.\n'));
        return;
      }
      process.stdout.write(c.bold(`  your artifacts (${items.length}):\n`));
      for (const it of items) {
        const when = (it.lastModified || '').replace('T', ' ').slice(0, 16);
        const tag = it.scope === 'team' ? c.cyan('team   ') : c.dim('private');
        process.stdout.write(
          `  ${tag}  ${c.dim(humanSize(it.size).padStart(8))}  ${c.dim(when)}  ${linkify(it.url)}\n`
        );
      }
    } catch (err) {
      process.stdout.write(c.red(`  ${glyph.cross} ${err instanceof Error ? err.message : String(err)}\n`));
    }
    return;
  }

  // ── rm <url|key> ──────────────────────────────────────────────────────────
  if (sub === 'rm' || sub === 'delete') {
    const target = positional[1];
    if (!target) {
      process.stdout.write('usage: bandit artifact rm <url|key>\n');
      return;
    }
    try {
      await deleteArtifact({ ...base, keyOrUrl: target });
      process.stdout.write(c.green(`  ${glyph.check} deleted\n`));
    } catch (err) {
      process.stdout.write(c.red(`  ${glyph.cross} ${err instanceof Error ? err.message : String(err)}\n`));
    }
    return;
  }

  // ── clear [--team] [--yes] ────────────────────────────────────────────────
  if (sub === 'clear') {
    const skipPrompt = argv.includes('--yes') || argv.includes('-y');
    if (!skipPrompt) {
      let count = 0;
      try {
        const items = await listArtifacts(base);
        count = items.filter((a) => (team ? a.scope === 'team' : a.scope !== 'team')).length;
      } catch { /* fall through to prompt */ }
      const what = team
        ? `ALL ${count} of your TEAM's shared artifacts (this affects your teammates)`
        : `ALL ${count} of your private artifacts`;
      const ok = await confirm(c.yellow(`  Delete ${what}? This can't be undone. [y/N] `));
      if (!ok) {
        process.stdout.write(c.dim('  cancelled (use --yes to skip this prompt).\n'));
        return;
      }
    }
    try {
      const deleted = await clearArtifacts({ ...base, scope: team ? 'team' : undefined });
      process.stdout.write(c.green(`  ${glyph.check} cleared ${deleted} ${team ? 'team ' : ''}artifact${deleted === 1 ? '' : 's'}\n`));
    } catch (err) {
      process.stdout.write(c.red(`  ${glyph.cross} ${err instanceof Error ? err.message : String(err)}\n`));
    }
    return;
  }

  // ── default: publish a file ───────────────────────────────────────────────
  const target = positional[0];
  if (!target) {
    process.stdout.write(
      'usage:\n' +
      '  bandit artifact <path> [--team]      publish a file (private by default; --team shares with your team)\n' +
      '  bandit artifact ls                   list your + your team\'s artifacts\n' +
      '  bandit artifact rm <url|key>         delete one\n' +
      '  bandit artifact clear [--team] [--yes]  delete all your private (or --team) artifacts\n'
    );
    return;
  }

  const abs = path.isAbsolute(target) ? target : path.join(cwd, target);
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(abs);
  } catch {
    process.stdout.write(c.red(`  ${glyph.cross} can't read ${target}\n`));
    return;
  }
  const filename = path.basename(abs);

  process.stdout.write(c.dim(`  ${glyph.spark} publishing ${filename} (${humanSize(bytes.byteLength)})…\n`));
  try {
    const artifact = await publishArtifact({
      ...base,
      scope: team ? 'team' : undefined,
      content: new Uint8Array(bytes),
      filename,
      contentType: guessContentType(filename),
    });
    const label = team ? 'published to your team — shareable link' : 'published (private) — shareable link';
    process.stdout.write('  ' + renderPublishedLink(artifact.url, { label }) + '\n');
  } catch (err) {
    process.stdout.write(c.red(`  ${glyph.cross} ${err instanceof Error ? err.message : String(err)}\n`));
  }
}

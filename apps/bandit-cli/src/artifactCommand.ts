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
  createShareLink,
  emailShareLink,
  revokeShareLink,
  listShareLinks,
  setArtifactScope,
  restoreArtifact,
  archiveArtifact,
  artifactKeyFromUrl,
  inlineHtmlImages,
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

/** Stealth dashboard base (where the manage/share UI lives) — config `dashboard.baseUrl`, else env, else prod. */
function resolveDashboardUrl(fileConfig: { dashboard?: { baseUrl?: string } }): string {
  return (fileConfig.dashboard?.baseUrl ?? process.env.BANDIT_DASHBOARD_URL ?? 'https://stealth.banditailabs.com').replace(/\/$/, '');
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Parse a duration like "7d" / "12h" / "30m" / raw minutes → minutes. Null if absent/bad. */
function parseDurationMinutes(argv: string[]): number | undefined {
  const i = argv.findIndex((a) => a === '--expires' || a === '--expiry');
  const raw = i >= 0 ? argv[i + 1] : undefined;
  if (!raw) return undefined;
  const m = /^(\d+)\s*(d|h|m)?$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? 'm').toLowerCase();
  return unit === 'd' ? n * 24 * 60 : unit === 'h' ? n * 60 : n;
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

  // ── share <url|key> [--expires 7d] ────────────────────────────────────────
  if (sub === 'share') {
    const target = positional[1];
    if (!target) {
      process.stdout.write('usage: bandit artifact share <url|key> [--expires 7d]\n');
      return;
    }
    try {
      const link = await createShareLink({ ...base, keyOrUrl: target, expiryMinutes: parseDurationMinutes(argv) });
      const when = (link.expiresAt || '').replace('T', ' ').slice(0, 16);
      process.stdout.write(
        c.green(`  ${glyph.check} external share link${when ? ` (expires ${when} UTC)` : ''} — anyone with it can view:\n`) +
        `  ${c.cyan(link.url)}\n` +
        c.dim(`  revoke anytime: bandit artifact unshare ${link.token}\n`)
      );
    } catch (err) {
      process.stdout.write(c.red(`  ${glyph.cross} ${err instanceof Error ? err.message : String(err)}\n`));
    }
    return;
  }

  // ── email <url|key> <recipient> [--expires 7d] [--message "..."] ──────────
  if (sub === 'email') {
    const target = positional[1];
    const to = positional[2];
    if (!target || !to) {
      process.stdout.write('usage: bandit artifact email <url|key> <recipient> [--expires 7d] [--message "note"]\n');
      return;
    }
    const mi = argv.findIndex((a) => a === '--message' || a === '-m');
    const message = mi >= 0 ? argv[mi + 1] : undefined;
    try {
      const link = await emailShareLink({ ...base, keyOrUrl: target, to, expiryMinutes: parseDurationMinutes(argv), message });
      const when = (link.expiresAt || '').replace('T', ' ').slice(0, 16);
      if (link.emailed) {
        process.stdout.write(
          c.green(`  ${glyph.check} emailed ${to} an external link${when ? ` (expires ${when} UTC)` : ''}:\n`) +
          `  ${c.cyan(link.url)}\n` +
          c.dim(`  revoke anytime: bandit artifact unshare ${link.token}\n`)
        );
      } else {
        // Link is valid; only delivery was best-effort (mail not configured yet).
        process.stdout.write(
          c.yellow(`  ${glyph.warn} link created but the email didn't send (mail not configured). Share it directly:\n`) +
          `  ${c.cyan(link.url)}\n` +
          c.dim(`  revoke anytime: bandit artifact unshare ${link.token}\n`)
        );
      }
    } catch (err) {
      process.stdout.write(c.red(`  ${glyph.cross} ${err instanceof Error ? err.message : String(err)}\n`));
    }
    return;
  }

  // ── unshare <token> ───────────────────────────────────────────────────────
  if (sub === 'unshare' || sub === 'revoke') {
    const shareToken = positional[1];
    if (!shareToken) {
      process.stdout.write('usage: bandit artifact unshare <token>\n');
      return;
    }
    try {
      await revokeShareLink({ ...base, shareToken });
      process.stdout.write(c.green(`  ${glyph.check} share link revoked\n`));
    } catch (err) {
      process.stdout.write(c.red(`  ${glyph.cross} ${err instanceof Error ? err.message : String(err)}\n`));
    }
    return;
  }

  // ── shares <url|key> ──────────────────────────────────────────────────────
  if (sub === 'shares') {
    const target = positional[1];
    if (!target) {
      process.stdout.write('usage: bandit artifact shares <url|key>\n');
      return;
    }
    try {
      const links = await listShareLinks({ ...base, keyOrUrl: target });
      if (links.length === 0) {
        process.stdout.write(c.dim('  no active external share links for that artifact.\n'));
        return;
      }
      process.stdout.write(c.bold(`  active share links (${links.length}):\n`));
      for (const l of links) {
        const when = (l.expiresAt || '').replace('T', ' ').slice(0, 16);
        process.stdout.write(`  ${c.dim(`expires ${when}`)}  ${c.dim(`${l.views} views`)}  ${c.cyan(l.url)}\n`);
      }
    } catch (err) {
      process.stdout.write(c.red(`  ${glyph.cross} ${err instanceof Error ? err.message : String(err)}\n`));
    }
    return;
  }

  // ── scope <url|key> <private|team> ────────────────────────────────────────
  if (sub === 'scope') {
    const target = positional[1];
    const next = (positional[2] ?? '').toLowerCase();
    if (!target || (next !== 'private' && next !== 'team')) {
      process.stdout.write('usage: bandit artifact scope <url|key> <private|team>\n');
      return;
    }
    try {
      const moved = await setArtifactScope({ ...base, keyOrUrl: target, scope: next });
      process.stdout.write(
        c.green(`  ${glyph.check} now ${next === 'team' ? 'shared with your team' : 'private (only you)'}\n`) +
        c.dim(`  ${moved.url}\n`)
      );
    } catch (err) {
      process.stdout.write(c.red(`  ${glyph.cross} ${err instanceof Error ? err.message : String(err)}\n`));
    }
    return;
  }

  // ── restore <url|key> (unarchive from cold storage) ───────────────────────
  if (sub === 'restore' || sub === 'unarchive') {
    const target = positional[1];
    if (!target) {
      process.stdout.write('usage: bandit artifact restore <url|key>\n');
      return;
    }
    process.stdout.write(c.dim(`  ${glyph.spark} restoring from cold storage…\n`));
    try {
      await restoreArtifact({ ...base, keyOrUrl: target });
      process.stdout.write(c.green(`  ${glyph.check} restored — it's back on fast storage\n`));
    } catch (err) {
      process.stdout.write(c.red(`  ${glyph.cross} ${err instanceof Error ? err.message : String(err)}\n`));
    }
    return;
  }

  // ── archive <url|key> (move to cold storage) ──────────────────────────────
  if (sub === 'archive') {
    const target = positional[1];
    if (!target) {
      process.stdout.write('usage: bandit artifact archive <url|key>\n');
      return;
    }
    try {
      await archiveArtifact({ ...base, keyOrUrl: target });
      process.stdout.write(
        c.green(`  ${glyph.check} archived to cold storage (freed hot space)\n`) +
        c.dim(`  restore anytime: bandit artifact restore ${target}\n`)
      );
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
      '  bandit artifact <path> [--team]         publish a file (private by default; --team shares with your team)\n' +
      '  bandit artifact ls                      list your + your team\'s artifacts\n' +
      '  bandit artifact rm <url|key>            delete one\n' +
      '  bandit artifact clear [--team] [--yes]  delete all your private (or --team) artifacts\n' +
      '  bandit artifact share <url> [--expires 7d]  external link anyone can open (expires; revocable)\n' +
      '  bandit artifact email <url> <to> [--expires 7d]  email someone an external link\n' +
      '  bandit artifact shares <url>            list active external links for an artifact\n' +
      '  bandit artifact unshare <token>         revoke an external link\n' +
      '  bandit artifact scope <url> <private|team>  move an artifact between private and team\n' +
      '  bandit artifact archive <url>           move an artifact to cold storage (frees space)\n' +
      '  bandit artifact restore <url>           bring an archived artifact back to fast storage\n'
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
    const contentType = guessContentType(filename);
    // Inline <img> sources for HTML artifacts so they render standalone.
    let content = new Uint8Array(bytes);
    if (contentType === 'text/html') {
      const r = await inlineHtmlImages(bytes.toString('utf8'), { baseDir: path.dirname(abs) });
      content = new Uint8Array(Buffer.from(r.html, 'utf8'));
      if (r.inlined) process.stdout.write(c.dim(`  ${glyph.spark} inlined ${r.inlined} image(s)\n`));
    }
    const artifact = await publishArtifact({
      ...base,
      scope: team ? 'team' : undefined,
      content,
      filename,
      contentType,
    });
    // Hand back the Stealth dashboard deep-link (signs you in + renders the artifact), NOT the raw
    // owner-only S3 URL — that 401s in a browser. Share externally from the dashboard, or via
    // `bandit artifact share`.
    const dash = resolveDashboardUrl(fileConfig as { dashboard?: { baseUrl?: string } });
    const viewUrl = `${dash}/artifacts?a=${encodeURIComponent(artifactKeyFromUrl(artifact.url))}`;
    const label = team ? 'published to your team — open to view & share' : 'published (private) — open to view & share';
    process.stdout.write('  ' + renderPublishedLink(viewUrl, { label }) + '\n');
  } catch (err) {
    process.stdout.write(c.red(`  ${glyph.cross} ${err instanceof Error ? err.message : String(err)}\n`));
  }
}

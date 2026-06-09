/**
 * Mail-search skill — macOS only.
 *
 * Lets the agent answer "find my email thread with X about Y" without the
 * AppleScript trial-and-error pattern (16 iterations,
 * six 30s `whose subject contains …` timeouts on a large inbox). Two tools:
 *
 * mail_search — Spotlight-indexed search over ~/Library/Mail. mdfind
 * walks the kMD index in milliseconds even on inboxes
 * with tens of thousands of messages. Returns top hits
 * with subject / from / date / .emlx path.
 * mail_read — read a single .emlx by absolute path. Strips the Apple
 * envelope (byte-count prefix line + trailing plist) and
 * returns the RFC822 message — headers + body — so the
 * agent can quote, summarise, or extract a thread.
 *
 * Auto-activates when the user mentions email, inbox, or Mail.app —
 * triggers stay broad because the keyword set is tiny ("email"/"inbox"
 * are unambiguous). Manifest-level activation is `auto`; per-tool
 * platform gating happens inside `execute()` so the tool descriptor is
 * always present in the catalogue but fails cleanly on Linux/Windows.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SkillManifest } from '../skill-types';
import type { AgentTool, ToolResult, ToolExecutionContext } from '../tool-types';

// Lazily resolved: `os.homedir()` / `path.join` are externalized to
// `undefined` in browser bundles, so a top-level call here crashed the
// Stealth Web app on import. This skill is macOS-only and gated behind
// `darwinGuard()` at execute time, so the path is only ever needed on a
// real Node host.
let cachedMailRoot: string | undefined;
function mailRoot(): string {
  if (cachedMailRoot === undefined) {
    cachedMailRoot = path.join(os.homedir(), 'Library', 'Mail');
  }
  return cachedMailRoot;
}
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const READ_BYTE_CAP = 80_000;

function darwinGuard(): ToolResult | null {
  if (process.platform !== 'darwin') {
    return {
      output:
        'mail_search / mail_read are macOS-only — they read Mail.app\'s Spotlight index and ' +
        '~/Library/Mail .emlx files. On this platform the tool cannot run.',
      isError: true
    };
  }
  return null;
}

/**
 * Mail.app's data directory sits under macOS TCC (Transparency, Consent,
 * Control) — the parent process running bandit needs Full Disk Access in
 * System Settings → Privacy & Security → Full Disk Access. Without it,
 * `mdfind -onlyin ~/Library/Mail` silently returns ZERO hits even though
 * the inbox has thousands of messages, which would look identical to a
 * legitimate "no matches" — a classic source of agent confusion. Probe
 * once: if we can't readdir ~/Library/Mail, report the permission gap
 * with the exact remediation step the user needs.
 */
function fullDiskAccessGuard(): ToolResult | null {
  try {
    fs.readdirSync(mailRoot());
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM' || code === 'EACCES') {
      return {
        output:
          'macOS Full Disk Access required to read Mail.app data.\n\n' +
          'Open System Settings → Privacy & Security → Full Disk Access, click + and add the ' +
          'application that launched bandit (Terminal.app, iTerm.app, Ghostty, your VS Code build, etc.). ' +
          'Then quit and relaunch that application — TCC permissions only apply to processes started ' +
          'AFTER the grant. After that, mail_search / mail_read will work.',
        isError: true
      };
    }
    if (code === 'ENOENT') {
      return {
        output: 'Mail.app data directory not found at ~/Library/Mail. Is Apple Mail set up on this Mac?',
        isError: true
      };
    }
    return {
      output: `Could not access ~/Library/Mail: ${err instanceof Error ? err.message : String(err)}`,
      isError: true
    };
  }
}

/**
 * Build the mdfind query from user-supplied filters. Spotlight syntax:
 * kMDItemKind == 'Mail Message' -- restrict to email
 * kMDItemAuthors == '*alex*'cd -- author contains
 * kMDItemSubject == '*DFS*'cd -- subject contains
 * kMDItemTextContent == '*open api*'cd -- body contains
 * kMDItemContentCreationDate >= $time.iso(2026-04-01) -- after date
 *
 * The 'cd' flags = case-insensitive + diacritic-insensitive. We keep the
 * query free-text and treat it as a body/subject/author OR-match so a
 * single string like "alex dfs" finds messages where any of those terms
 * appear anywhere — that's the usual user intent.
 */
function buildQuery(opts: {
  query?: string;
  from?: string;
  subject?: string;
  since?: string;
}): string {
  const clauses: string[] = [`kMDItemKind == 'Mail Message'`];
  if (opts.from) {
    const escaped = opts.from.replace(/'/g, "\\'");
    clauses.push(`kMDItemAuthors == '*${escaped}*'cd`);
  }
  if (opts.subject) {
    const escaped = opts.subject.replace(/'/g, "\\'");
    clauses.push(`kMDItemSubject == '*${escaped}*'cd`);
  }
  if (opts.query) {
    const escaped = opts.query.replace(/'/g, "\\'");
    // Free-text: match in author OR subject OR body. Spotlight evaluates
    // the inner OR before AND-ing with the kind/from/subject/since
    // clauses.
    clauses.push(
      `(kMDItemAuthors == '*${escaped}*'cd || kMDItemSubject == '*${escaped}*'cd || kMDItemTextContent == '*${escaped}*'cd)`
    );
  }
  if (opts.since) {
    // Trust the model to pass an ISO date (YYYY-MM-DD or full ISO).
    // Spotlight's $time.iso() accepts both.
    const iso = opts.since.replace(/'/g, '');
    clauses.push(`kMDItemContentCreationDate >= $time.iso(${iso})`);
  }
  return clauses.join(' && ');
}

/**
 * Pull the metadata fields we surface in the search result list. mdls
 * output looks like:
 * kMDItemSubject = "FW: DFS Open API"
 * kMDItemAuthors = ("Jane Doe <jane@example.com>")
 * kMDItemContentCreationDate = 2026-04-29 16:01:30 +0000
 * Parse the right-hand side per key, falling back to '' on missing.
 */
function parseMdlsOutput(stdout: string): { subject: string; from: string; date: string } {
  const result = { subject: '', from: '', date: '' };
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(\w+)\s*=\s*(.*)$/);
    if (!m) {continue;}
    const key = m[1];
    let value = m[2].trim();
    // Strip surrounding quotes / parens / array braces.
    value = value.replace(/^["(]+|[")]+$/g, '').trim();
    // Multi-author array becomes "a", "b" — keep the first one for
    // display; the full list is rarely useful in a card-style listing.
    if (value.includes('","')) {value = value.split('","')[0].replace(/^"|"$/g, '');}
    if (key === 'kMDItemSubject') {result.subject = value;}
    else if (key === 'kMDItemAuthors') {result.from = value;}
    else if (key === 'kMDItemContentCreationDate') {result.date = value;}
  }
  return result;
}

const mailSearchTool: AgentTool = {
  name: 'mail_search',
  description:
    'Search Apple Mail.app via Spotlight. Returns up to N matching messages with subject, sender, ' +
    'date, and absolute .emlx path you can pass to mail_read. Use this instead of `osascript ... whose ...` ' +
    '— Spotlight is indexed and returns in <1s even on large inboxes; AppleScript `whose` does a linear ' +
    'scan and times out at 30s on inboxes with thousands of messages. macOS only.',
  parameters: [
    { name: 'query', description: 'Free-text search (matches in author, subject, or body).' },
    { name: 'from', description: 'Filter by sender substring (e.g. "alex" or "example.com").' },
    { name: 'subject', description: 'Filter by subject substring (e.g. "DFS").' },
    { name: 'since', description: 'ISO date (YYYY-MM-DD); only messages after this date.' },
    { name: 'limit', description: 'Max messages to return. Default 20, capped at 50.' }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const guarded = darwinGuard() ?? fullDiskAccessGuard();
    if (guarded) {return guarded;}

    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(params.limit ?? '', 10) || DEFAULT_LIMIT));
    const query = buildQuery({
      query: params.query?.trim(),
      from: params.from?.trim(),
      subject: params.subject?.trim(),
      since: params.since?.trim()
    });

    if (query === `kMDItemKind == 'Mail Message'`) {
      return {
        output:
          'Refusing to list every message in your inbox — pass at least one of `query`, `from`, ' +
          '`subject`, or `since` to narrow the search.',
        isError: true
      };
    }

    const findResult = await ctx.runCommand(
      'mdfind',
      ['-onlyin', mailRoot(), query],
      ctx.workspaceRoot
    );
    if (findResult.exitCode !== 0) {
      return {
        output: `mdfind failed: ${findResult.stderr.trim() || 'exit ' + findResult.exitCode}`,
        isError: true
      };
    }

    const paths = findResult.stdout.split('\n').map(s => s.trim()).filter(Boolean).slice(0, limit);
    if (paths.length === 0) {
      return { output: '(no matching messages)' };
    }

    // Pull metadata per hit. mdls is fast (≤5ms each) so we don't bother
    // batching — keeps the code simple and per-message failures don't
    // poison the whole result set.
    const rows: Array<{ subject: string; from: string; date: string; path: string }> = [];
    for (const p of paths) {
      try {
        const meta = await ctx.runCommand(
          'mdls',
          ['-name', 'kMDItemSubject', '-name', 'kMDItemAuthors', '-name', 'kMDItemContentCreationDate', p],
          ctx.workspaceRoot
        );
        const parsed = parseMdlsOutput(meta.stdout);
        rows.push({ ...parsed, path: p });
      } catch {
        rows.push({ subject: '(metadata read failed)', from: '', date: '', path: p });
      }
    }

    const lines = rows.map((r, i) => {
      const subj = r.subject || '(no subject)';
      const from = r.from || '(unknown sender)';
      const date = r.date || '(no date)';
      return `${i + 1}. [${date}] ${from}\n   ${subj}\n   path: ${r.path}`;
    });

    const truncatedNote = paths.length === limit
      ? `\n\n(showing first ${limit} hits — narrow the search if you need more.)`
      : '';
    return { output: `Found ${rows.length} message${rows.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}${truncatedNote}` };
  }
};

const mailReadTool: AgentTool = {
  name: 'mail_read',
  description:
    'Read a single Mail.app message by its .emlx file path (from mail_search). Returns the RFC822 ' +
    'message — headers + body. Strips Apple\'s envelope (byte-count prefix + trailing plist). macOS only.',
  parameters: [
    { name: 'path', description: 'Absolute path to a .emlx file (use the path field from a mail_search row).', required: true }
  ],
  async execute(params): Promise<ToolResult> {
    const guarded = darwinGuard() ?? fullDiskAccessGuard();
    if (guarded) {return guarded;}

    const filePath = params.path?.trim();
    if (!filePath) {
      return { output: 'mail_read requires `path` (the .emlx file from a mail_search row).', isError: true };
    }
    // Path safety: only allow absolute paths under ~/Library/Mail with
    // a recognised .emlx-family extension. Prevents the model from
    // accidentally aiming this at /etc/passwd or similar.
    const abs = path.resolve(filePath);
    const root = mailRoot();
    if (!abs.startsWith(root + path.sep)) {
      return {
        output: `mail_read can only open files under ${root}. Got: ${abs}`,
        isError: true
      };
    }
    if (!/\.(emlx|partial\.emlx|emlxpart)$/.test(abs)) {
      return {
        output: `mail_read expects a .emlx file. Got: ${abs}`,
        isError: true
      };
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(abs, 'utf-8');
    } catch (err) {
      return {
        output: `Failed to read ${abs}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true
      };
    }

    // Apple .emlx layout:
    // <ascii byte-count>\n
    // <RFC822 message of exactly that many bytes>
    // <Apple plist trailer>
    // Slice out the RFC822 portion using the declared byte count.
    const firstNewline = raw.indexOf('\n');
    const byteCount = parseInt(raw.slice(0, firstNewline).trim(), 10);
    let rfc822 = Number.isFinite(byteCount) && byteCount > 0
      ? raw.slice(firstNewline + 1, firstNewline + 1 + byteCount)
      : raw;
    if (rfc822.length > READ_BYTE_CAP) {
      rfc822 = rfc822.slice(0, READ_BYTE_CAP) + `\n\n[…truncated, ${rfc822.length - READ_BYTE_CAP} more bytes; use a more specific search to narrow the thread]`;
    }
    return { output: rfc822 };
  }
};

export const mailSearchSkill: SkillManifest = {
  id: 'mac/mail-search',
  name: 'Mail Search (macOS)',
  version: '1.0.0',
  description: 'Search and read Apple Mail.app messages via Spotlight + .emlx — no AppleScript timeouts.',
  instructions:
    'When the user asks about an email thread, who emailed them, or to summarise a conversation: ' +
    '\n1. Call `mail_search` with `query`/`from`/`subject`/`since` filters. Do NOT use `osascript ... whose ...` ' +
    'on Mail.app — it scans linearly and times out at 30s on large inboxes.\n' +
    '2. Pick the relevant `path` from the result list.\n' +
    '3. Call `mail_read(path=...)` to get the message body.\n' +
    'For a thread you may need to mail_read 2-3 messages. Prefer `from` over generic `query` when you ' +
    'know the sender — it returns much fewer false positives.',
  activation: 'auto',
  triggerPatterns: [
    /\bemail\b/i,
    /\binbox\b/i,
    /\bmail\.?app\b/i,
    /\bapple mail\b/i,
    /\bmessage(s)? from\b/i
  ],
  tools: [mailSearchTool, mailReadTool]
};

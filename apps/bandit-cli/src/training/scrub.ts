/**
 * scrub-v1: everything that leaves Mark's machine goes through here.
 *
 * Order matters: whole-file redaction first (a `.env` read is replaced outright),
 * then agent-core's high-confidence secret patterns, then the extra patterns
 * below, high-entropy tokens, emails, phones, home paths and the local denylist.
 * Only counts are recorded — never the redacted values.
 */
import { redactSecrets } from '@burtson-labs/agent-core';
import type { CanonicalMessage, RedactionKind, TrainingExample } from './types';
import { emptyRedactions } from './types';
import { ABSOLUTE_PATH_LEFTOVER_RE } from './paths';

export const SECRET = '[SECRET]';
export const REDACTED_FILE = '[redacted file]';

interface Rule {
  kind: RedactionKind;
  re: RegExp;
  replace: string | ((match: string, ...groups: string[]) => string);
}

// Extra secret shapes beyond agent-core's list (overlap is harmless: the first rule wins).
const SECRET_RULES: Rule[] = [
  { kind: 'secret', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, replace: SECRET },
  { kind: 'secret', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: SECRET },
  { kind: 'secret', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: SECRET },
  { kind: 'secret', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: SECRET },
  { kind: 'secret', re: /\b(?:bai|sk|rk|pk)_(?:live_|test_)?[A-Za-z0-9]{16,}\b/g, replace: SECRET },
  { kind: 'secret', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g, replace: SECRET },
  { kind: 'secret', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, replace: SECRET },
  { kind: 'secret', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, replace: SECRET },
  { kind: 'secret', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: SECRET },
  { kind: 'secret', re: /\bhf_[A-Za-z0-9]{30,}\b/g, replace: SECRET },
  // Credentials embedded in any URL (git remotes with tokens, basic-auth URLs).
  {
    kind: 'secret',
    re: /\b([a-z][a-z0-9+.-]*):\/\/[^\s/@'"`<>:]+:[^\s/@'"`<>]+@/gi,
    replace: (_m, scheme: string) => `${scheme}://${SECRET}@`
  },
  // Connection strings: keep the scheme so the example still reads naturally.
  {
    kind: 'secret',
    re: /\b(mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|rediss|amqps?|mssql|sqlserver):\/\/[^\s'"`<>]+/gi,
    replace: (_m, scheme: string) => `${scheme}://${SECRET}`
  },
  // ADO.NET style: Server=…;User Id=…;Password=…;
  { kind: 'secret', re: /\b(?:Password|Pwd|AccountKey|SharedAccessKey|ClientSecret)\s*=\s*[^;'"\s]+/gi, replace: m => `${m.split('=')[0]}=${SECRET}` },
  // Generic "secret-ish key": "literal" pairs agent-core may miss in YAML/INI/JSON. Quoted
  // literals only: code like `token: process.env.TOKEN` must survive untouched.
  {
    kind: 'secret',
    re: /\b((?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*)(["'])(?!\$\{)([^\s'"]{8,})\2/gi,
    replace: (_m, lead: string, q: string) => `${lead}${q}${SECRET}${q}`
  }
];

// Not `name@2x.png`-style asset names: the domain must not start with a scale suffix.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@(?!\d+(?:\.\d+)?x\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const EMAIL_KEEP = /^(?:user@example\.com|git@github\.com|noreply@github\.com|.*@users\.noreply\.github\.com|.*@example\.(?:com|org|net))$/i;

/** Addresses that carry no personal data and may stay (shared by scrub and self-check). */
export function isKeptEmail(email: string): boolean {
  return EMAIL_KEEP.test(email);
}
const PHONE_RE = /(?<![\w.-])(?:\+1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w.-])/g;
const HOME_PATH_RES: Array<[RegExp, string]> = [
  [/\/Users\/[^/\s'"`]+/g, '~'],
  [/\/home\/(?!runner\b)[^/\s'"`]+/g, '~'],
  [/[A-Za-z]:\\Users\\[^\\\s'"`]+/g, '~']
];
const TOKEN_RE = /[A-Za-z0-9+/=_-]{24,}/g;

/** Files whose contents never leave the machine (matched on a read path or a shell command). */
const SENSITIVE_FILE_RE = /(?:^|[\\/\s'"])(?:\.env(?:\.[\w.-]+)?|appsettings(?:\.[\w-]+)?\.json|[\w.-]+\.pem|[\w.-]+\.key|[\w.-]+\.p12|[\w.-]+\.pfx|id_(?:rsa|ed25519|ecdsa)|\.npmrc|\.pypirc|\.netrc|credentials(?:\.json)?|secrets?\.(?:ya?ml|json)|\.dockerconfigjson|kubeconfig)(?:$|[\s'"])/i;

export function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Long, mixed letter+digit, high-entropy runs are almost always keys or tokens. */
export function looksLikeSecretToken(tok: string): boolean {
  if (tok.length < 24) return false;
  if (!/[0-9]/.test(tok) || !/[A-Za-z]/.test(tok)) return false;
  if (/^[0-9a-f]+$/i.test(tok) && (tok.length === 40 || tok.length === 64)) return false; // git/sha hashes
  if (tok.includes('[SECRET]')) return false;
  return shannonEntropy(tok) > 4.0;
}

export interface DenyTerm {
  term: string;
  kind: 'client' | 'person';
  re: RegExp;
}

/** denylist.txt: one term per line; `person: Jane Doe` / `client: Acme` / bare term = client; `#` comments. */
export function parseDenylist(text: string): DenyTerm[] {
  const out: DenyTerm[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(person|client)\s*:\s*(.+)$/i);
    const kind = (m?.[1]?.toLowerCase() as 'person' | 'client' | undefined) ?? 'client';
    const term = (m?.[2] ?? line).trim();
    if (term.length < 2) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    out.push({ term, kind, re: new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi') });
  }
  return out;
}

export interface Scrubber {
  scrubText(text: string, counts: Record<RedactionKind, number>): string;
  scrubExample(example: TrainingExample): TrainingExample;
}

export function createScrubber(denylist: DenyTerm[] = []): Scrubber {
  const scrubText = (input: string, counts: Record<RedactionKind, number>): string => {
    if (!input) return input;
    let text = input;

    const core = redactSecrets(text);
    if (core.redactionCount > 0) {
      counts.secret += core.redactionCount;
      text = core.text.replace(/<REDACTED:[a-z0-9-]+>/gi, SECRET);
    }
    for (const rule of SECRET_RULES) {
      rule.re.lastIndex = 0;
      text = text.replace(rule.re, (...args: unknown[]) => {
        const match = args[0] as string;
        if (match.includes(SECRET) && !/:\/\//.test(match)) return match;
        counts[rule.kind]++;
        return typeof rule.replace === 'string'
          ? rule.replace
          : rule.replace(match, ...(args.slice(1).filter(a => typeof a === 'string') as string[]));
      });
    }
    text = text.replace(TOKEN_RE, tok => {
      if (!looksLikeSecretToken(tok)) return tok;
      counts.entropy++;
      return SECRET;
    });
    text = text.replace(EMAIL_RE, email => {
      if (isKeptEmail(email)) return email;
      counts.email++;
      return 'user@example.com';
    });
    text = text.replace(PHONE_RE, () => {
      counts.phone++;
      return '[PHONE]';
    });
    for (const [re, repl] of HOME_PATH_RES) {
      text = text.replace(re, () => {
        counts.path++;
        return repl;
      });
    }
    for (const d of denylist) {
      d.re.lastIndex = 0;
      text = text.replace(d.re, () => {
        counts[d.kind]++;
        return d.kind === 'person' ? '[PERSON]' : '[CLIENT]';
      });
    }
    return text;
  };

  const scrubExample = (example: TrainingExample): TrainingExample => {
    // path_absolute is counted earlier, by the relativizer (paths.ts); carry it through.
    const counts = { ...emptyRedactions(), path_absolute: example.scrub?.redactions?.path_absolute ?? 0 };
    // Which tool calls touched a sensitive file? Their results are replaced whole.
    const sensitiveCalls = new Set<string>();
    for (const m of example.messages) {
      if (m.role !== 'assistant' || !m.tool_calls) continue;
      for (const c of m.tool_calls) {
        if (SENSITIVE_FILE_RE.test(` ${c.function.arguments.replace(/[{}",:]/g, ' ')} `)) sensitiveCalls.add(c.id);
      }
    }
    const messages: CanonicalMessage[] = example.messages.map(m => {
      if (m.role === 'tool') {
        if (sensitiveCalls.has(m.tool_call_id)) {
          counts.file++;
          return { ...m, content: REDACTED_FILE };
        }
        return { ...m, content: scrubText(m.content, counts) };
      }
      if (m.role === 'assistant') {
        const next: CanonicalMessage = { ...m, content: scrubText(m.content, counts) };
        if (m.reasoning) next.reasoning = scrubText(m.reasoning, counts);
        if (m.tool_calls) {
          next.tool_calls = m.tool_calls.map(c => ({
            ...c,
            function: { ...c.function, arguments: scrubArguments(c.function.arguments, counts) }
          }));
        }
        return next;
      }
      return { ...m, content: scrubText(m.content, counts) };
    });
    return {
      ...example,
      sourceRef: scrubText(example.sourceRef, emptyRedactions()),
      messages,
      scrub: { version: 'scrub-v1', redactions: counts, dropped: false }
    };
  };

  /** Scrub string values inside tool-call arguments while keeping valid JSON. */
  const scrubArguments = (args: string, counts: Record<RedactionKind, number>): string => {
    try {
      const parsed = JSON.parse(args) as unknown;
      const walk = (v: unknown): unknown => {
        if (typeof v === 'string') return scrubText(v, counts);
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
        return v;
      };
      return JSON.stringify(walk(parsed));
    } catch {
      return JSON.stringify(scrubText(args, counts));
    }
  };

  return { scrubText, scrubExample };
}

/**
 * Redactions that count toward `--max-secrets`: real credential hits (token patterns,
 * PEM blocks, connection strings, URL credentials) and whole sensitive-file reads.
 * High-entropy, email and path redactions are routine (hashes, ids, logs) and don't.
 */
export function totalSecrets(counts: Record<RedactionKind, number>): number {
  return counts.secret + counts.file;
}

// ---- self-check: anything secret-looking that survived the scrub -------------------------

const LEFTOVER_RES: Array<[string, RegExp]> = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ['openai-style-key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/],
  ['burtson-key', /\bbai_[A-Za-z0-9]{16,}/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['url-credentials', /\b[a-z][a-z0-9+.-]*:\/\/(?!\[SECRET\])[^\s/@'"`<>:]+:[^\s/@'"`<>]+@/i],
  ['home-path', /\/Users\/[A-Za-z0-9._-]+\//],
  ['absolute-path', ABSOLUTE_PATH_LEFTOVER_RE]
];

export interface SelfCheckHit {
  exampleId: string;
  kind: string;
}

export function selfCheckText(exampleId: string, text: string): SelfCheckHit[] {
  const hits: SelfCheckHit[] = [];
  for (const [kind, re] of LEFTOVER_RES) {
    if (re.test(text)) hits.push({ exampleId, kind });
  }
  EMAIL_RE.lastIndex = 0;
  if ((text.match(EMAIL_RE) ?? []).some(e => !isKeptEmail(e))) hits.push({ exampleId, kind: 'email' });
  for (const tok of text.match(TOKEN_RE) ?? []) {
    if (looksLikeSecretToken(tok)) {
      hits.push({ exampleId, kind: 'high-entropy' });
      break;
    }
  }
  return hits;
}

/** Every string the example will train on, checked as raw text (not JSON-escaped). */
export function exampleStrings(example: TrainingExample): string[] {
  const out: string[] = [];
  for (const m of example.messages) {
    out.push(m.content);
    if (m.role === 'assistant') {
      if (m.reasoning) out.push(m.reasoning);
      for (const c of m.tool_calls ?? []) {
        try {
          const walk = (v: unknown): void => {
            if (typeof v === 'string') out.push(v);
            else if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') Object.values(v).forEach(walk);
          };
          walk(JSON.parse(c.function.arguments));
        } catch {
          out.push(c.function.arguments);
        }
      }
    }
  }
  return out;
}

export function selfCheckExample(example: TrainingExample): SelfCheckHit[] {
  const seen = new Set<string>();
  const hits: SelfCheckHit[] = [];
  for (const s of exampleStrings(example)) {
    for (const h of selfCheckText(example.id, s)) {
      if (seen.has(h.kind)) continue;
      seen.add(h.kind);
      hits.push(h);
    }
  }
  return hits;
}

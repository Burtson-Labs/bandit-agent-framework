/**
 * Secret-leak protection. Tool output (file reads, command
 * stdout, search results) routinely surfaces API keys, OAuth tokens,
 * and private keys when the user asks the agent to inspect dotfiles,
 * environment variables, or anything else that touches credentials.
 * Without redaction, those tokens land in:
 *
 * 1. The model's context window → the model may echo them in its
 * next response, embed them in a tool call, or hallucinate
 * surrounding prose that quotes them verbatim
 * 2. The user's terminal → secrets sit in the scrollback,
 * visible to over-shoulder readers and any screen-sharing flow
 * 3. The session log on disk → ~/.bandit/sessions/*.jsonl
 * persists raw secrets indefinitely, becoming a target if
 * that file is ever shared (bug reports, etc.)
 *
 * The redactor is the single source of truth for "what looks like a
 * secret." Patterns target high-confidence formats (known prefixes,
 * stable lengths) — we deliberately do NOT redact generic
 * high-entropy strings because false positives are corrosive (the
 * agent loses the ability to reason about real data that happens to
 * look secret-shaped).
 *
 * Each pattern has a `kind` label so the redaction replaces the match
 * with a typed token like `<REDACTED:github-pat>` — preserves enough
 * structure for the model (and the user) to understand what kind of
 * thing was hidden without leaking the value.
 */

export interface SecretPattern {
  /** Stable identifier used in the replacement token + telemetry. */
  kind: string;
  /** Human-readable label used in user-facing summaries. */
  label: string;
  /** Detection regex. MUST use the `g` flag (replace-all). */
  re: RegExp;
}

/**
 * Built-in secret patterns. Each entry is a high-confidence format with
 * either a recognized prefix or a strict length/charset constraint.
 *
 * Order matters: longer / more-specific patterns must match BEFORE
 * shorter / more-generic ones, otherwise a fine-grained PAT would be
 * partially matched by the classic-PAT pattern. We rely on the regex
 * engine matching in source order via the array iteration below.
 */
export const BUILTIN_SECRET_PATTERNS: SecretPattern[] = [
  // ─── GitHub ───────────────────────────────────────────────────────
  // Fine-grained PATs are LONG (82 char body) — listed first so the
  // classic-PAT pattern doesn't truncate them.
  {
    kind: 'github-pat-fine-grained',
    label: 'GitHub fine-grained PAT',
    re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g
  },
  {
    kind: 'github-pat',
    label: 'GitHub classic PAT',
    re: /\bghp_[A-Za-z0-9]{36,251}\b/g
  },
  {
    kind: 'github-oauth',
    label: 'GitHub OAuth token',
    re: /\bgho_[A-Za-z0-9]{36,251}\b/g
  },
  {
    kind: 'github-server-token',
    label: 'GitHub server-to-server token',
    re: /\bghs_[A-Za-z0-9]{36,251}\b/g
  },
  {
    kind: 'github-user-token',
    label: 'GitHub user-to-server token',
    re: /\bghu_[A-Za-z0-9]{36,251}\b/g
  },

  // ─── Slack ────────────────────────────────────────────────────────
  {
    kind: 'slack-bot-token',
    label: 'Slack bot token',
    re: /\bxoxb-[A-Za-z0-9-]+\b/g
  },
  {
    kind: 'slack-user-token',
    label: 'Slack user token',
    re: /\bxoxp-[A-Za-z0-9-]+\b/g
  },
  {
    kind: 'slack-app-token',
    label: 'Slack app token',
    re: /\bxoxa-[A-Za-z0-9-]+\b/g
  },

  // ─── GitLab ───────────────────────────────────────────────────────
  {
    kind: 'gitlab-pat',
    label: 'GitLab personal access token',
    re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g
  },

  // ─── AWS ──────────────────────────────────────────────────────────
  {
    kind: 'aws-access-key',
    label: 'AWS access key',
    re: /\b(?:AKIA|ASIA|AROA|AGPA|AIPA)[0-9A-Z]{16}\b/g
  },

  // ─── Anthropic / OpenAI / Bandit ──────────────────────────────────
  {
    kind: 'anthropic-key',
    label: 'Anthropic API key',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g
  },
  {
    kind: 'openai-key',
    label: 'OpenAI API key',
    re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g
  },
  {
    kind: 'bandit-api-key',
    label: 'Bandit / Burtson Labs API key',
    re: /\bbai_[A-Za-z0-9]{20,}\b/g
  },

  // ─── Google ───────────────────────────────────────────────────────
  // Google API keys start with "AIza" + 35 chars (39 total).
  {
    kind: 'google-api-key',
    label: 'Google API key',
    re: /\bAIza[A-Za-z0-9_-]{35}\b/g
  },
  // OAuth refresh tokens are "1//" + base64-like body.
  {
    kind: 'google-oauth-refresh',
    label: 'Google OAuth refresh token',
    re: /\b1\/\/[A-Za-z0-9_-]{43,}\b/g
  },

  // ─── Stripe ───────────────────────────────────────────────────────
  {
    kind: 'stripe-secret-key',
    label: 'Stripe secret key',
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g
  },

  // ─── JWTs (generic, three base64-url segments) ────────────────────
  // Any token shaped `eyJ<header>.<payload>.<signature>` — covers JWTs
  // from any issuer. Catches our own AuthApi tokens, Auth0, Google ID
  // tokens, etc. Long enough that the entropy filter doesn't hurt.
  {
    kind: 'jwt',
    label: 'JWT token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
  },

  // ─── Private keys (PEM blocks) ────────────────────────────────────
  // PEM-armored RSA / ECDSA / OpenSSH / generic private keys. The
  // multi-line matcher captures the entire BEGIN...END block.
  {
    kind: 'private-key',
    label: 'PEM private key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g
  },

  // ─── HTTP Authorization headers ───────────────────────────────────
  // Catches "Authorization: Bearer <token>" / Token / Basic shapes that
  // leak through curl outputs, request logs, fetch() debugging, etc.
  // Preserves the header name + scheme so the model can still reason
  // about WHAT auth was attempted, just not the token value.
  //
  // Caps the token character class at non-quote / non-whitespace /
  // non-angle-bracket so this pattern can't re-match an already-redacted
  // placeholder like "<REDACTED:jwt>".
  {
    kind: 'authorization-bearer',
    label: 'HTTP Authorization header token',
    // Backreferences \1 and \3 balance quotes around the key name and
    // the value so both `Authorization: Bearer foo` and the JSON form
    // `"Authorization": "Bearer foo"` match without grabbing stray quotes.
    re: /(["']?)Authorization\1(\s*[:=]\s*)(["']?)(Bearer|Token|Basic)\s+([^\s"'<>]{16,})\3/gi
  },

  // ─── JSON / JS-style camelCase secret fields ──────────────────────
  // The env-secret pattern below only catches SHOUTY_CASE names. JSON
  // config files use camelCase ("apiKey", "accessToken", "clientSecret"),
  // so the env pattern misses them entirely. ~/.bandit/config.json
  // ({"bandit": {"apiKey": "..."}}) was leaking because of exactly this
  // gap (2026-05-26).
  //
  // Matches: any quoted-or-bare camelCase identifier that ends in
  // Key|Token|Secret|Password|Credentials, OR standalone "password" /
  // "passwd" / "secret". Value must be a quoted string of 8+ chars.
  // The value char class excludes <, > so it can't re-match a prior
  // pattern's placeholder.
  //
  // Preserves: opening key quote, key name, closing key quote,
  // separator (`: ` or `=`), opening value quote, closing value quote.
  // Replaces: only the value's content.
  {
    kind: 'json-camelcase-secret',
    label: 'camelCase config secret value',
    re: /(["']?)([a-z][a-zA-Z0-9]*(?:Key|Token|Secret|Password|Credentials?)|password|passwd|secret)\1(\s*[:=]\s*)(["'])([^"'\s<>]{8,})\4/g
  },

  // ─── Generic env-style secret lines ───────────────────────────────
  // Last-resort pattern: capture `*_TOKEN=<value>`, `*_KEY=<value>`,
  // `*_SECRET=<value>`, `*_PASSWORD=<value>` style env lines where
  // the value is non-empty and has at least 8 characters. Replaces
  // only the value, not the variable name (preserves readability).
  //
  // The variable name is either a prefix + underscore + keyword
  // (`STRIPE_SECRET_KEY`, `GITHUB_TOKEN`) OR just the keyword on its
  // own (`PASSWORD=`, `TOKEN=`, `API_KEY=`). The optional non-capturing
  // group `(?:[A-Z][A-Z0-9_]*_)?` handles both cases — the trailing
  // underscore forces a real prefix boundary so `DEBUG=...` (which has
  // no keyword suffix) never matches.
  //
  // Quoted values supported via the back-referenced quote group.
  {
    kind: 'env-secret',
    label: 'env-style secret value',
    re: /\b((?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|API|AUTH))\s*[:=]\s*(['"]?)([^\s'"]{8,})\2/g
  }
];

/**
 * Result of a redaction pass. The text is the masked output; counts
 * and kinds tell the host how many secrets were found so it can show
 * a small "redacted N secrets" footer if it wants to.
 */
export interface RedactionResult {
  text: string;
  redactionCount: number;
  /** Kinds detected, deduplicated. Order matches first-occurrence. */
  kinds: string[];
}

/**
 * Apply all built-in patterns to a string. Replaces each match with
 * `<REDACTED:{kind}>`. The replacement is intentionally short so the
 * model can still reason about the surrounding text without burning
 * context on long placeholder tokens.
 *
 * The `env-secret` pattern is special: it preserves the variable name
 * and only redacts the value. So `GITHUB_TOKEN=ghp_abc...` becomes
 * `GITHUB_TOKEN=<REDACTED:env-secret>` — the model can still see WHAT
 * variable was set without seeing its value. For all other patterns
 * the whole match is replaced.
 */
export function redactSecrets(
  text: string,
  patterns: SecretPattern[] = BUILTIN_SECRET_PATTERNS
): RedactionResult {
  if (!text || text.length === 0) {
    return { text, redactionCount: 0, kinds: [] };
  }
  let working = text;
  let redactionCount = 0;
  const kinds: string[] = [];
  const recordKind = (kind: string) => {
    if (!kinds.includes(kind)) {kinds.push(kind);}
  };
  for (const pattern of patterns) {
    // Reset lastIndex so the global regex starts at 0 every call.
    pattern.re.lastIndex = 0;
    let mutated = false;
    if (pattern.kind === 'env-secret') {
      // Preserve `VAR=` prefix, redact only the value.
      working = working.replace(pattern.re, (_match, varName) => {
        redactionCount++;
        recordKind(pattern.kind);
        mutated = true;
        return `${varName}=<REDACTED:${pattern.kind}>`;
      });
    } else if (pattern.kind === 'json-camelcase-secret') {
      // Preserve quoted key + separator + value quotes; redact only the
      // inner value. Groups: (1) keyQuote, (2) keyName, (3) separator,
      // (4) valueQuote, (5) value.
      working = working.replace(pattern.re, (_match, kq, keyName, sep, vq) => {
        redactionCount++;
        recordKind(pattern.kind);
        mutated = true;
        return `${kq}${keyName}${kq}${sep}${vq}<REDACTED:${pattern.kind}>${vq}`;
      });
    } else if (pattern.kind === 'authorization-bearer') {
      // Preserve quoted header name + separator + value quotes; redact
      // only the token. Groups: (1) keyQuote, (2) separator, (3) valueQuote,
      // (4) scheme, (5) token.
      working = working.replace(pattern.re, (_match, kq, sep, vq, scheme) => {
        redactionCount++;
        recordKind(pattern.kind);
        mutated = true;
        return `${kq}Authorization${kq}${sep}${vq}${scheme} <REDACTED:${pattern.kind}>${vq}`;
      });
    } else {
      working = working.replace(pattern.re, () => {
        redactionCount++;
        recordKind(pattern.kind);
        mutated = true;
        return `<REDACTED:${pattern.kind}>`;
      });
    }
    // Defensive: regex with `g` flag carries state across calls. Reset
    // again to guarantee no leftover lastIndex affects later callers.
    if (mutated) {pattern.re.lastIndex = 0;}
  }
  return { text: working, redactionCount, kinds };
}

/**
 * Convenience helper used by callers that don't need the metadata —
 * just want the masked string. Equivalent to redactSecrets(text).text.
 */
export function redactSecretsString(text: string): string {
  return redactSecrets(text).text;
}

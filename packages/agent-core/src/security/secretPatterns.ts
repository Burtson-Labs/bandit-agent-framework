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
  /**
   * Optional replacement builder for patterns that keep part of the match
   * (a variable name, a URL's user/host) and hide only the value. Receives
   * the regex's capture groups (index 0 = group 1) and the placeholder
   * token. When absent the whole match is replaced with the token.
   */
  format?: (groups: string[], token: string) => string;
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
  {
    kind: 'github-refresh-token',
    label: 'GitHub refresh token',
    re: /\bghr_[A-Za-z0-9]{36,251}\b/g
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

  // Incoming-webhook URLs carry their secret in the path, so the whole URL
  // is the credential: anyone holding it can post to the channel.
  {
    kind: 'slack-webhook',
    label: 'Slack incoming-webhook URL',
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/g
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

  // The secret half of an AWS key pair has no prefix, so it is only
  // recognisable by its name: `aws_secret_access_key = …` in
  // ~/.aws/credentials (INI, lowercase — the SHOUTY env pattern below misses
  // it) and the session token next to it.
  {
    kind: 'aws-secret-key',
    label: 'AWS secret access key',
    re: /\b(aws_secret_access_key|aws_session_token)(["']?)(\s*[:=]\s*)(["']?)([A-Za-z0-9/+=]{16,})\4/gi,
    format: ([name, kq, sep, vq], token) => `${name}${kq}${sep}${vq}${token}${vq}`
  },

  // ─── Azure ────────────────────────────────────────────────────────
  // Storage / Service Bus / Event Hub connection strings:
  // `DefaultEndpointsProtocol=https;AccountName=x;AccountKey=<base64>;…`.
  // Keeps the field name so the rest of the connection string stays legible.
  {
    kind: 'azure-account-key',
    label: 'Azure account / shared access key',
    re: /\b(AccountKey|SharedAccessKey)=([A-Za-z0-9+/]{20,}={0,2})/g,
    format: ([name], token) => `${name}=${token}`
  },

  // ─── npm ──────────────────────────────────────────────────────────
  {
    kind: 'npm-token',
    label: 'npm access token',
    re: /\bnpm_[A-Za-z0-9]{36}\b/g
  },
  // .npmrc: `//registry.npmjs.org/:_authToken=…` (or a bare `_authToken=`).
  // The value may be a legacy UUID token with no prefix, so the key is what
  // identifies it. Runs after npm-token, whose placeholder `<…>` is outside
  // the value class and so never re-matched.
  {
    kind: 'npm-auth-token',
    label: 'npm _authToken value',
    re: /(_authToken\s*=\s*)(["']?)([^\s"'<>]{8,})\2/g,
    format: ([prefix, q], token) => `${prefix}${q}${token}${q}`
  },

  // ─── Hugging Face ─────────────────────────────────────────────────
  {
    kind: 'huggingface-token',
    label: 'Hugging Face access token',
    re: /\bhf_[A-Za-z0-9]{30,}\b/g
  },

  // ─── SendGrid ─────────────────────────────────────────────────────
  {
    kind: 'sendgrid-key',
    label: 'SendGrid API key',
    re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g
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

  // ─── Credentials embedded in URLs ─────────────────────────────────
  // `postgres://user:pass@host/db`, `redis://:pass@host`, `https://u:p@h`.
  // Only the password is hidden — scheme, user and host stay readable so
  // the model can still reason about which database / service is meant.
  {
    kind: 'url-credentials',
    label: 'password in a URL',
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/<>"'`]*):([^\s@/<>"'`]+)@/gi,
    format: ([scheme, user], token) => `${scheme}${user}:${token}@`
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
  },

  // ─── Generic secret assignments, any case ─────────────────────────
  // Catches what the SHOUTY env pattern and the quoted-camelCase pattern
  // miss: `export x_api_key=…`, `db_password: …` in YAML, gh's hosts.yml
  // `oauth_token: …`, `client-secret = …`, unquoted camelCase.
  //
  // False positives are what make a redactor useless, so this one is strict:
  // - the identifier must END in key / secret / token / password / passwd /
  //   pwd, as a whole word part (`_token`, `-key`, `.secret`, `apiKey`) —
  //   so `TOKEN_FILE=`, `secret_key_name=` and `monkey:` never match;
  // - the value must be 16+ chars of a token alphabet, contain a letter
  //   AND a digit, not start like a path (`/`, `.`, `~`), and end at a
  //   delimiter — so `token = "abc"`, `key: process.env.API_KEY`,
  //   `password=os.environ["PW"]` and file paths are left alone.
  // Keeps the identifier, quotes and separator; replaces only the value.
  {
    kind: 'secret-assignment',
    label: 'secret-named assignment value',
    re: /(?<![A-Za-z0-9_.-])((?:[A-Za-z0-9_.-]*[_.-])?(?:[a-z][A-Za-z0-9]*(?=Key|Secret|Token|Password|Passwd|Pwd))?(?:key|secret|token|password|passwd|pwd|Key|Secret|Token|Password|Passwd|Pwd|KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD))(["']?)(\s*[:=]\s*)(["']?)(?![/.~])(?=[A-Za-z0-9_+/=.~-]*[0-9])(?=[A-Za-z0-9_+/=.~-]*[A-Za-z])([A-Za-z0-9_+/=.~-]{16,})\4(?=$|[\s"',;})\]])/gm,
    format: ([name, kq, sep, vq], token) => `${name}${kq}${sep}${vq}${token}${vq}`
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
    } else if (pattern.format) {
      const format = pattern.format;
      const token = `<REDACTED:${pattern.kind}>`;
      working = working.replace(pattern.re, (...args: unknown[]) => {
        redactionCount++;
        recordKind(pattern.kind);
        mutated = true;
        // args = [match, ...groups, offset, input(, namedGroups)]; the
        // numeric offset marks where the capture groups end.
        const offsetIdx = args.findIndex((a, i) => i > 0 && typeof a === 'number');
        const realGroups = args.slice(1, offsetIdx).map((g) => (typeof g === 'string' ? g : ''));
        return format(realGroups, token);
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

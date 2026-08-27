/**
 * Turning an expired MCP credential into something the agent can act on.
 *
 * The failure this exists for: a connected MCP server's session expires
 * mid-task and the tool comes back with a server-generated string like
 *
 *   Tool 'listMessages' execution failed: The AuthApi rejected the session JWT
 *   and the API-key re-validation also failed. The API key may be…
 *
 * To a model that is only pattern-matching, that reads as "this capability is
 * broken", not "this capability needs sixty seconds of user action". Observed
 * consequence: the agent silently abandoned the connected service, fell back to
 * driving Mail.app through `osascript`, and never told the user their Gmail
 * connection had expired. The task limped to an answer by a much worse route,
 * and the actual problem went unreported.
 *
 * An expired credential is one of the most recoverable failures in the whole
 * system — the user just has to re-authorize. But nothing in the error said so,
 * and nothing named the command that does it.
 *
 * So: detect auth-shaped failures, and rewrite them into an instruction that
 * names the server, states plainly that this is recoverable, and tells the
 * agent to surface the reconnect command rather than routing around it.
 */

/**
 * Auth-shaped failure signatures.
 *
 * Deliberately broad on the symptom and narrow on the action: a false positive
 * costs one unnecessary "you may need to reconnect" line, while a false
 * negative costs a silent capability loss like the one above. Ordered from
 * most to least specific so the matched phrase can be quoted back.
 */
const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /rejected the session (?:jwt|token)/i,
  /re-?validation (?:also )?failed/i,
  /\b(?:token|session|credential|api[- ]?key)s?\b[^.]{0,40}\b(?:expired|invalid|revoked|rejected)\b/i,
  /\bexpired\b[^.]{0,30}\b(?:token|session|credential|grant)\b/i,
  /\b(?:401|403)\b|\bunauthori[sz]ed\b|\bforbidden\b/i,
  /\bauthentication (?:failed|required|error)\b/i,
  /\bnot authenticated\b|\bre-?authenticat/i,
  /\binvalid_grant\b|\binvalid_token\b|\btoken_expired\b/i,
  // An error that names a refresh token is an auth failure — Google's is
  // "refused the refresh token", which none of the verb-specific patterns
  // above catch on their own.
  /\brefresh[_ ]?token\b/i
];

export interface McpAuthFailure {
  /** The server whose credential needs refreshing. */
  server: string;
  /** Original error text, preserved so the user can see what actually failed. */
  original: string;
  /**
   * The command that actually refreshes THIS server's credential.
   *
   * Defaults to `/mcp connect <server>`, which re-runs the server's own
   * connect flow — right for OAuth-style servers. Wrong for servers with
   * `auth: 'bandit'`: their credential IS the user's Bandit sign-in, and
   * `/mcp connect` would reopen the transport carrying the same rejected key,
   * fail identically, and teach the user that the recovery advice is noise.
   * Hosts pass the hint from the server's auth config at registration time —
   * see getAllMcpAgentTools.
   */
  reconnectCommand?: string;
}

/**
 * Stable sentinel embedded in every auth-recovery guidance message.
 *
 * The loop's false-tool-absence detector fires on "I can't access X" claims
 * when X is registered — which is exactly what a CORRECT auth-expiry answer
 * looks like. It needs ground truth that an auth failure really happened this
 * turn, and this marker in a tool result is that ground truth. A distinctive
 * token rather than matching the prose so rewording the guidance can't
 * silently break the exemption.
 */
export const AUTH_RECOVERY_MARKER = '[auth-recovery]';

/** True when a tool result carries auth-recovery guidance from this module. */
export function isAuthRecoveryGuidance(text: string): boolean {
  return typeof text === 'string' && text.includes(AUTH_RECOVERY_MARKER);
}

/**
 * Signals that an auth failure is specifically a GOOGLE Workspace token, even
 * when it surfaces through a Bandit-authenticated MCP server.
 *
 * Why this matters: a server like `burtson-labs` authenticates its transport
 * with the user's Bandit key (so the per-server hint says `/login`), but then
 * uses the user's stored GOOGLE refresh token to reach Gmail/Drive/Calendar.
 * When GOOGLE rejects that token, `/login` (re-auth Bandit) does nothing — the
 * fix is `/mcp google connect` (re-authorize Google). The transport is fine;
 * the downstream Google grant is what expired. The error text is the only place
 * that distinguishes the two, so we read it.
 */
const GOOGLE_AUTH_SIGNALS = /\b(google|gmail|googleemail|workspace|refresh token)\b/i;

export function looksLikeGoogleAuthFailure(message: string): boolean {
  return !!message && looksLikeAuthFailure(message) && GOOGLE_AUTH_SIGNALS.test(message);
}

/**
 * Does this MCP failure look like an expired or rejected credential?
 *
 * Checked against the error text only. Tool output that merely *mentions*
 * tokens (reading an auth module's source, say) never reaches here — this runs
 * on the throw path, not on successful results.
 */
export function looksLikeAuthFailure(message: string): boolean {
  if (!message) {return false;}
  return AUTH_FAILURE_PATTERNS.some((re) => re.test(message));
}

/**
 * Rewrite an auth failure into a recovery instruction.
 *
 * Three things the replacement must do, each learned from the trace above:
 *
 *  1. Say it is recoverable and temporary. Otherwise the model reasons about
 *     the capability as permanently absent and stops considering it.
 *  2. Name the reconnect command, so the agent can hand the user something to
 *     run instead of paraphrasing "you may need to check your settings".
 *  3. Explicitly forbid the silent workaround. The agent routing around a
 *     broken connection without mentioning it is the part that actually cost
 *     the user — they finished the task believing Gmail had been searched.
 */
export function describeMcpAuthFailure(failure: McpAuthFailure): string {
  const { server, original } = failure;
  // Error content wins over the server's static auth config: a Google-token
  // failure needs `/mcp google connect` regardless of how the server's
  // transport authenticates. Otherwise fall back to the config-derived hint
  // (e.g. `/login` for Bandit-auth servers), then the generic default.
  const command = looksLikeGoogleAuthFailure(original)
    ? '/mcp google connect   (re-authorize your Google Workspace — pick the correct account in the browser)'
    : (failure.reconnectCommand ?? `/mcp connect ${server}`);
  return [
    `${AUTH_RECOVERY_MARKER} Authentication for the "${server}" MCP server has expired or been rejected.`,
    '',
    `Underlying error: ${original}`,
    '',
    'This is RECOVERABLE and usually takes under a minute — the connection is',
    'configured correctly, its credential just needs refreshing. Do not treat',
    `"${server}" as permanently unavailable.`,
    '',
    'Do this now, in order:',
    `1. Tell the user plainly that the "${server}" connection needs re-authorizing,`,
    `   and that they can fix it by running: ${command}`,
    `   Present that command as inline code in one sentence — do not wrap it in a`,
    `   code fence or put it on its own line.`,
    '2. Do NOT silently switch to another route to get the same data. If you can',
    '   reach it another way, say what you are about to do and why FIRST — a user',
    '   who is not told their connection expired will assume it worked.',
    '3. If the rest of the task does not depend on this server, continue with it',
    '   and report the expired connection alongside your result.'
  ].join('\n');
}

/**
 * Wrap an MCP invocation error, upgrading auth-shaped failures into recovery
 * instructions and passing everything else through unchanged.
 */
export function formatMcpToolError(
  namespacedName: string,
  server: string,
  message: string,
  reconnectCommand?: string
): string {
  if (looksLikeAuthFailure(message)) {
    return describeMcpAuthFailure({ server, original: message, reconnectCommand });
  }
  return `Error invoking ${namespacedName}: ${message}`;
}

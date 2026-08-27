/**
 * An expired MCP credential is one of the most recoverable failures in the
 * system, and it used to read to the model as a permanent capability loss.
 *
 * Observed: a Gmail session expired mid-task, the tool returned "The AuthApi
 * rejected the session JWT and the API-key re-validation also failed", and the
 * agent silently rerouted through `osascript` against Mail.app without ever
 * telling the user their connection had gone stale. The user got an answer and
 * no idea their integration was broken.
 */
import { describe, it, expect } from 'vitest';
import {
  looksLikeAuthFailure,
  describeMcpAuthFailure,
  formatMcpToolError,
  isAuthRecoveryGuidance,
  looksLikeGoogleAuthFailure,
  AUTH_RECOVERY_MARKER
} from '../src/mcp/authFailure';

describe('looksLikeAuthFailure', () => {
  it('recognizes the error that started this', () => {
    expect(looksLikeAuthFailure(
      'The AuthApi rejected the session JWT and the API-key re-validation also failed.'
    )).toBe(true);
  });

  it('recognizes the common shapes across providers', () => {
    for (const msg of [
      'Request failed with status 401',
      'HTTP 403 Forbidden',
      'Unauthorized',
      'authentication failed',
      'invalid_grant',
      'token_expired',
      'Your session has expired, please re-authenticate',
      'The access token is invalid or revoked',
      'credentials were rejected'
    ]) {
      expect(looksLikeAuthFailure(msg), msg).toBe(true);
    }
  });

  // Broad on symptom, but not so broad that ordinary failures get rewritten
  // into "go reconnect your account", which would send users chasing a
  // non-problem.
  it('leaves ordinary failures alone', () => {
    for (const msg of [
      'ECONNREFUSED 127.0.0.1:8080',
      'Tool not found: listMessages',
      'Expected object, received string',
      'Request timed out after 30000ms',
      'No matching messages',
      'rate limit exceeded, retry after 30s',
      ''
    ]) {
      expect(looksLikeAuthFailure(msg), msg).toBe(false);
    }
  });
});

describe('describeMcpAuthFailure', () => {
  const out = describeMcpAuthFailure({
    server: 'burtson-labs',
    original: 'The AuthApi rejected the session JWT and the API-key re-validation also failed.'
  });

  it('names the server and the command that fixes it', () => {
    expect(out).toContain('burtson-labs');
    expect(out).toContain('/mcp connect burtson-labs');
  });

  it('frames the failure as recoverable, not as a missing capability', () => {
    expect(out).toMatch(/RECOVERABLE/);
    expect(out).toMatch(/not treat|permanently unavailable/i);
  });

  // The part that actually cost the user: routing around the outage silently.
  it('forbids substituting another route without telling the user', () => {
    expect(out).toMatch(/do not silently switch/i);
  });

  it('preserves the original error for the user to see', () => {
    expect(out).toContain('rejected the session JWT');
  });

  it('lets the agent finish work that does not depend on the server', () => {
    expect(out).toMatch(/continue with it/i);
  });
});

describe('formatMcpToolError', () => {
  it('upgrades auth failures into recovery instructions', () => {
    const out = formatMcpToolError('gmail.listMessages', 'gmail', 'HTTP 401 Unauthorized');
    expect(out).toContain('/mcp connect gmail');
  });

  it('passes everything else through unchanged', () => {
    const out = formatMcpToolError('gmail.listMessages', 'gmail', 'ECONNREFUSED');
    expect(out).toBe('Error invoking gmail.listMessages: ECONNREFUSED');
  });
});

/**
 * Field report, second round: the guidance fired correctly but three things
 * around it degraded the turn — the default reconnect command was wrong for
 * bandit-auth servers, the false-tool-absence detector double-prompted the
 * (correct) reauth answer, and the model rendered the command in a clunky
 * fenced block. These pin the second-round fixes.
 */
describe('per-server reconnect command', () => {
  it('uses the supplied command instead of the /mcp connect default', () => {
    const out = describeMcpAuthFailure({
      server: 'burtson-labs',
      original: 'HTTP 401',
      reconnectCommand: '/login   (this server authenticates with your Bandit sign-in, which is what expired)'
    });
    expect(out).toContain('/login');
    // The default would have reopened the transport with the same stale key.
    expect(out).not.toContain('/mcp connect burtson-labs');
  });

  it('falls back to /mcp connect for servers that own their credential', () => {
    expect(describeMcpAuthFailure({ server: 'gmail', original: 'HTTP 401' }))
      .toContain('/mcp connect gmail');
  });

  it('threads through formatMcpToolError', () => {
    const out = formatMcpToolError('burtson-labs.listMessages', 'burtson-labs', 'HTTP 401', '/login');
    expect(out).toContain('/login');
  });
});

describe('auth-recovery marker', () => {
  it('every guidance message carries the marker', () => {
    expect(isAuthRecoveryGuidance(describeMcpAuthFailure({ server: 's', original: 'e' }))).toBe(true);
  });

  it('ordinary errors and prose do not carry it', () => {
    for (const text of [
      'Error invoking gmail.listMessages: ECONNREFUSED',
      'The connection has expired, please re-authorize',
      ''
    ]) {
      expect(isAuthRecoveryGuidance(text), JSON.stringify(text.slice(0, 40))).toBe(false);
    }
  });

  it('the marker is stable — rewording the prose must not break the loop exemption', () => {
    expect(describeMcpAuthFailure({ server: 's', original: 'e' }).startsWith(AUTH_RECOVERY_MARKER)).toBe(true);
  });
});

describe('display guidance', () => {
  it('tells the model to keep the command inline, not fenced', () => {
    // The fenced rendering read as broken horizontal rules in the terminal.
    const out = describeMcpAuthFailure({ server: 's', original: 'e' });
    expect(out).toMatch(/inline code/);
    expect(out).toMatch(/do not wrap it in a/);
  });
});

/**
 * Field report: a burtson-labs (Bandit-auth) MCP server failed on its GOOGLE
 * token, not its Bandit key. The per-server hint said /login, but /login
 * re-auths Bandit and does nothing for Google. The error text ("Google refused
 * the refresh token", googleEmail, workspace) is what distinguishes them.
 */
describe('Google-token failures route to the Google reconnect command', () => {
  const googleErr = 'Google refused the refresh token for googleEmail mburtson@gmail.com workspace gmail — token expired';

  it('detects a Google-specific auth failure', () => {
    expect(looksLikeGoogleAuthFailure(googleErr)).toBe(true);
    // A Bandit-key failure with no Google signal is NOT google-routed.
    expect(looksLikeGoogleAuthFailure('The AuthApi rejected the session JWT')).toBe(false);
    // Non-auth mention of google isn't enough — it must also look like auth.
    expect(looksLikeGoogleAuthFailure('fetched the google homepage')).toBe(false);
  });

  it('points at /mcp google connect even when the server is Bandit-auth', () => {
    // Server hint says /login (Bandit-auth), but the Google error overrides it.
    const out = describeMcpAuthFailure({
      server: 'burtson-labs',
      original: googleErr,
      reconnectCommand: '/login   (this server authenticates with your Bandit sign-in)',
    });
    expect(out).toContain('/mcp google connect');
    expect(out).not.toContain('/login');
    // And it nudges toward picking the right account.
    expect(out).toMatch(/correct account/i);
  });

  it('still uses /login for a genuine Bandit-key failure (no Google signal)', () => {
    const out = describeMcpAuthFailure({
      server: 'burtson-labs',
      original: 'The AuthApi rejected the session JWT and API-key re-validation failed',
      reconnectCommand: '/login   (Bandit sign-in expired)',
    });
    expect(out).toContain('/login');
    expect(out).not.toContain('/mcp google connect');
  });
});

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
  formatMcpToolError
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

/**
 * Native-app OAuth sign-in flow for Bandit Cloud.
 *
 * RFC 8252 (PKCE + ephemeral loopback redirect) — same shape Claude
 * Code, GitHub CLI, AWS CLI all use. The flow:
 *
 *   1. Generate code_verifier + S256 code_challenge
 *   2. Bind a local HTTP listener to 127.0.0.1:<random port>
 *   3. Open the system browser to /api/oidc/authorize with the
 *      challenge + state + redirect_uri pointing at the listener
 *   4. User authenticates against AuthApi (Google / GitHub / etc.)
 *   5. AuthApi redirects back to http://127.0.0.1:<port>/callback?code=...
 *   6. Exchange the code at /api/oidc/token (sending the verifier)
 *      to get a short-lived JWT
 *   7. POST that JWT to /api/keys/resolve-token to get the user's
 *      durable Bandit Cloud API key
 *   8. Caller stores the API key; the JWT is discarded — every
 *      subsequent gateway call uses the API key.
 *
 * The JWT is intentionally NOT persisted. Only the API key is — that's
 * the long-lived credential the user gets when they sign in via OAuth.
 * If the key is ever revoked from the website's Account tab, the
 * extension/CLI sees a 401 and re-runs this flow.
 */

import * as http from 'http';
import type * as net from 'net';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

// Self-hosters point this at their own OIDC issuer. Resolution order:
// 1. explicit `authBaseUrl` passed in OAuthSignInOptions (highest precedence)
// 2. process.env.BANDIT_AUTH_URL — works for the extension because the
//    VS Code extension host is Node.js and inherits the user's environment
// 3. https://auth.burtson.ai (Burtson Labs default)
const BUILTIN_AUTH_BASE_URL = 'https://auth.burtson.ai';
const DEFAULT_OIDC_CLIENT_ID = 'bandit';
const REDIRECT_PATH = '/callback';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000; // user has 5 minutes to finish browser flow

function resolveDefaultAuthBaseUrl(): string {
  return (process.env.BANDIT_AUTH_URL || BUILTIN_AUTH_BASE_URL).replace(/\/+$/, '');
}

export interface OAuthSignInOptions {
  /** Auth API base URL — defaults to https://auth.burtson.ai. Override for staging. */
  authBaseUrl?: string;
  /** OIDC client_id. Defaults to "bandit" (the public PKCE client registered in values.yaml). */
  clientId?: string;
  /** Friendly label persisted alongside the issued device key so the
   *  user can identify it on the website's Account tab. Defaults to
   *  "Bandit Stealth (VS Code) on <hostname> · <platform>". */
  deviceLabel?: string;
}

export interface OAuthSignInResult {
  /** The Bandit Cloud API key to store and use for future gateway calls. */
  apiKey: string;
  /** Optional masked preview the UI can echo back to the user. */
  maskedKey?: string;
  /** User's email pulled from the resolve-token response. */
  email?: string;
  /** User's display name pulled from the resolve-token response. */
  name?: string;
  /** Plan tier ("free", "pro", "team"). */
  plan?: string;
}

interface PkceMaterial {
  verifier: string;
  challenge: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce(): PkceMaterial {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function generateState(): string {
  return base64UrlEncode(crypto.randomBytes(16));
}

/**
 * Bind a local HTTP listener to a random port on 127.0.0.1 and resolve
 * with the port number plus a single-shot promise that fires when the
 * OAuth callback arrives. The server self-closes after one request, or
 * after SIGN_IN_TIMEOUT_MS, whichever comes first.
 */
function startLoopbackListener(state: string): Promise<{
  port: number;
  result: Promise<{ code: string }>;
  cancel: () => void;
}> {
  return new Promise((resolveOuter, rejectOuter) => {
    let pending: { resolve: (v: { code: string }) => void; reject: (e: Error) => void } | null = null;
    const result = new Promise<{ code: string }>((resolve, reject) => {
      pending = { resolve, reject };
    });

    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== REDIRECT_PATH) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
          return;
        }
        const returnedState = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('state mismatch');
          pending?.reject(new Error('OAuth state mismatch — refusing to complete sign-in. Try again.'));
          return;
        }
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h2>Bandit sign-in failed</h2><p>${escapeHtml(error)}</p><p>You can close this window.</p></body></html>`);
          pending?.reject(new Error(`Auth provider returned error: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('missing code');
          pending?.reject(new Error('OAuth callback arrived without a code.'));
          return;
        }
        // Show a friendly success page so the user knows it worked and
        // can close the tab. The extension picks up the code via the
        // promise, doesn't depend on the user's browser doing anything.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SUCCESS_PAGE);
        pending?.resolve({ code });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('error');
        } catch { /* response already sent */ }
        pending?.reject(new Error(`Loopback handler error: ${msg}`));
      } finally {
        // Single-shot listener — close after one request whether it
        // succeeded or failed, so we don't sit on a port indefinitely.
        try { server.close(); } catch { /* ignore */ }
      }
    });

    const timeout = setTimeout(() => {
      try { server.close(); } catch { /* ignore */ }
      pending?.reject(new Error('Sign-in timed out. Run sign-in again to retry.'));
    }, SIGN_IN_TIMEOUT_MS);

    server.on('error', (err) => {
      clearTimeout(timeout);
      rejectOuter(err);
    });

    // Port 0 = let the OS assign an ephemeral free port.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolveOuter({
        port: address.port,
        result,
        cancel: () => {
          clearTimeout(timeout);
          try { server.close(); } catch { /* ignore */ }
          pending?.reject(new Error('Sign-in cancelled.'));
        }
      });
    });
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SUCCESS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Bandit signed in</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background: #0b1220; color: #e2e8f0; display: flex; align-items: center;
         justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: rgba(15,23,42,.7); border: 1px solid rgba(99,102,241,.4);
          border-radius: 14px; padding: 2.5rem 3rem; text-align: center; max-width: 28rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; color: #38bdf8; }
  p { margin: .5rem 0 0; color: rgba(226,232,240,.8); line-height: 1.5; }
</style></head>
<body>
  <div class="card">
    <h1>You're signed in.</h1>
    <p>Bandit picked up your session. You can close this tab and return to your editor.</p>
  </div>
</body></html>`;

/**
 * Run the full OAuth sign-in flow and return the resolved API key.
 * Throws on cancel / timeout / network failure / token-exchange error.
 */
export async function runOAuthSignIn(options: OAuthSignInOptions = {}): Promise<OAuthSignInResult> {
  const authBase = options.authBaseUrl
    ? options.authBaseUrl.replace(/\/+$/, '')
    : resolveDefaultAuthBaseUrl();
  const clientId = options.clientId ?? DEFAULT_OIDC_CLIENT_ID;
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const listener = await startLoopbackListener(state);
  const redirectUri = `http://127.0.0.1:${listener.port}${REDIRECT_PATH}`;
  const authUrl = new URL(`${authBase}/api/oidc/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'openid profile email');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  // Kick off the user's browser. vscode.env.openExternal handles the
  // platform shell-out (open / xdg-open / start) for us.
  const opened = await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));
  if (!opened) {
    listener.cancel();
    throw new Error('Could not open the browser for sign-in. Copy the URL from the notification and open it manually.');
  }

  let code: string;
  try {
    const result = await listener.result;
    code = result.code;
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Exchange code → JWT.
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier
  });
  const tokenResp = await fetch(`${authBase}/api/oidc/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: tokenBody.toString()
  });
  if (!tokenResp.ok) {
    const detail = await tokenResp.text().catch(() => '');
    throw new Error(`Token exchange failed (${tokenResp.status}): ${detail || tokenResp.statusText}`);
  }
  const tokenJson = (await tokenResp.json()) as { access_token?: string };
  const jwt = tokenJson.access_token;
  if (!jwt) {throw new Error('Token endpoint returned no access_token.');}

  // Issue a fresh device-scoped API key for this user. The JWT
  // authorizes the issuance; the response body includes the plaintext
  // key (returned once, never retrievable from the server again — the
  // database stores only a hash). Friendly device label is purely for
  // the user's benefit when they review/revoke keys on the website.
  const deviceLabel = options.deviceLabel ?? buildDefaultDeviceLabel();
  const issueResp = await fetch(`${authBase}/api/keys/issue-device-key`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ deviceLabel })
  });
  if (!issueResp.ok) {
    const detail = await issueResp.text().catch(() => '');
    throw new Error(`issue-device-key failed (${issueResp.status}): ${detail || issueResp.statusText}`);
  }
  const issueJson = (await issueResp.json()) as {
    apiKey?: { key?: string; maskedKey?: string; keyPreview?: string };
    user?: { email?: string; firstName?: string; lastName?: string };
  };
  const apiKey = issueJson.apiKey?.key ?? '';
  if (!apiKey) {
    throw new Error('issue-device-key did not return a key. Sign in again or contact support@burtson.ai.');
  }
  const name = [issueJson.user?.firstName, issueJson.user?.lastName].filter(Boolean).join(' ').trim() || undefined;
  return {
    apiKey,
    maskedKey: issueJson.apiKey?.maskedKey ?? issueJson.apiKey?.keyPreview,
    email: issueJson.user?.email,
    name
  };
}

function buildDefaultDeviceLabel(): string {
  // Best-effort identifier: hostname + platform + agent label. Picked
  // up by AuthApi's logger and surfaced in the website Account tab so
  // the user can tell "MacBook Pro" from "ubuntu-laptop" when revoking.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os');
  const host = (() => {
    try { return os.hostname(); } catch { return 'unknown'; }
  })();
  const platform = process.platform === 'darwin'
    ? 'macOS'
    : process.platform === 'win32'
    ? 'Windows'
    : process.platform === 'linux'
    ? 'Linux'
    : process.platform;
  return `Bandit Stealth (VS Code) on ${host} · ${platform}`;
}

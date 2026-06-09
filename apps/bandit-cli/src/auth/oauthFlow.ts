/**
 * Native-app OAuth sign-in flow for the Bandit CLI.
 *
 * RFC 8252 (PKCE + ephemeral loopback redirect). Same flow as the
 * Bandit Stealth extension — see apps/bandit-stealth/src/auth/oauthFlow.ts
 * for the prose write-up. Differences here:
 *
 *   - Browser launch uses platform shell-out (open / xdg-open / start)
 *     instead of vscode.env.openExternal
 *   - Friendly success/failure HTML pages so the user knows when to
 *     close the tab vs. retry
 *   - Returns the resolved API key for the caller to persist via
 *     saveApiKey() in config.ts
 */
import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';
import * as os from 'os';
import { spawn } from 'child_process';

// Self-hosters point this at their own OIDC issuer. Resolution order:
// 1. explicit `authBaseUrl` passed in OAuthSignInOptions (highest precedence)
// 2. process.env.BANDIT_AUTH_URL
// 3. https://auth.burtson.ai (Burtson Labs default)
const BUILTIN_AUTH_BASE_URL = 'https://auth.burtson.ai';
const DEFAULT_OIDC_CLIENT_ID = 'bandit';
const REDIRECT_PATH = '/callback';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

function resolveDefaultAuthBaseUrl(): string {
  return (process.env.BANDIT_AUTH_URL || BUILTIN_AUTH_BASE_URL).replace(/\/+$/, '');
}

export interface OAuthSignInOptions {
  authBaseUrl?: string;
  clientId?: string;
  deviceLabel?: string;
}

export interface OAuthSignInResult {
  apiKey: string;
  maskedKey?: string;
  email?: string;
  name?: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function generateState(): string {
  return base64UrlEncode(crypto.randomBytes(16));
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
    <p>Bandit picked up your session. You can close this tab and return to your terminal.</p>
  </div>
</body></html>`;

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
          pending?.reject(new Error('OAuth state mismatch — refusing to complete sign-in. Try /login again.'));
          return;
        }
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h2>Bandit sign-in failed</h2><p>${escapeHtml(error)}</p><p>You can close this window and run <code>/login</code> again.</p></body></html>`);
          pending?.reject(new Error(`Auth provider returned error: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('missing code');
          pending?.reject(new Error('OAuth callback arrived without a code.'));
          return;
        }
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
        try { server.close(); } catch { /* ignore */ }
      }
    });

    const timeout = setTimeout(() => {
      try { server.close(); } catch { /* ignore */ }
      pending?.reject(new Error('Sign-in timed out after 5 minutes. Run /login to retry.'));
    }, SIGN_IN_TIMEOUT_MS);

    server.on('error', (err) => {
      clearTimeout(timeout);
      rejectOuter(err);
    });

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

/**
 * Open a URL in the user's default browser. Platform-aware:
 * - macOS: `open <url>`
 * - Windows: `cmd /c start "" <url>` (the empty quoted title prevents
 *   start from interpreting the URL as a window title)
 * - Linux: `xdg-open <url>` (or `wslview` on WSL — handled by xdg-open
 *   when wslu is installed). Falls back to throwing if no opener works.
 *
 * We don't await the spawned process — most browser openers exit
 * immediately after handing off to the user's browser; the OAuth
 * callback arrives via the loopback HTTP server, not via this child.
 */
function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let cmd: string;
    let args: string[];
    if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '""', url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => reject(err));
    child.unref();
    // Resolve immediately — the opener should fire-and-forget.
    resolve();
  });
}

function buildDefaultDeviceLabel(): string {
  let host: string;
  try { host = os.hostname(); } catch { host = 'unknown'; }
  const platform = process.platform === 'darwin'
    ? 'macOS'
    : process.platform === 'win32'
    ? 'Windows'
    : process.platform === 'linux'
    ? 'Linux'
    : process.platform;
  return `Bandit CLI on ${host} · ${platform}`;
}

/**
 * Run the OAuth sign-in flow and return the resolved Bandit Cloud API key.
 *
 * Caller is responsible for persisting the key (saveApiKey from config.ts).
 * The returned `apiKey` is the plaintext credential — store it via the
 * same secrets path the existing /login <key> command uses.
 */
export async function runOAuthSignIn(
  options: OAuthSignInOptions = {},
  log?: (line: string) => void
): Promise<OAuthSignInResult> {
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

  log?.(`Opening browser for sign-in… if it doesn't open automatically, copy this URL:\n  ${authUrl.toString()}`);
  try {
    await openBrowser(authUrl.toString());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`Browser open failed (${msg}). Copy the URL above and open it manually — the loopback listener is still waiting.`);
  }

  let code: string;
  try {
    const result = await listener.result;
    code = result.code;
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

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
  if (!jwt) throw new Error('Token endpoint returned no access_token.');

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

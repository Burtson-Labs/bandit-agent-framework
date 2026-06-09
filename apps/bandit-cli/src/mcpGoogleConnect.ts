/**
 * CLI-native Google Workspace connection flow.
 *
 * Mirrors the website's burtson.ai/mcp page so users who don't have
 * web access (CI runner, headless dev box, future self-hosted
 * AuthApi deploys) can authorize their workspaces directly from the
 * Bandit prompt. Three operations:
 *
 * /mcp google connect [--workspace=<label>] [--scopes=<csv>]
 * /mcp google list
 * /mcp google disconnect <connection-id>
 *
 * The connect flow follows the standard CLI-OAuth pattern (gh / gcloud
 * / vercel use the same shape):
 *
 * 1. Swap the user's Burtson Labs API key for a short-lived JWT
 * via POST /api/keys/validate (no UI, server-to-server).
 * 2. Bind a localhost listener on an ephemeral port.
 * 3. POST /api/me/google/connect/ticket with redirect pointing at
 * the local listener.
 * 4. Open the user's default browser to the returned connect URL.
 * 5. User completes Google OAuth in the browser; AuthApi
 * eventually 302s to http://127.0.0.1:<port>/done?google=connected&workspace=…
 * 6. Local listener serves a "you can close this tab" page, closes,
 * and prints success in the terminal.
 *
 * The API key never leaves the user's machine in plaintext — only the
 * one-time ticket is on the wire to the browser, and that ticket is
 * SHA-256-hashed at rest in AuthApi and consumed in one shot.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { addMcpServerToConfig, loadMcpServersConfig } from '@burtson-labs/host-kit';
import { c } from './ansi';
import type { ResolvedConfig } from './config';

const DEFAULT_AUTH_API_URL = 'https://auth.burtson.ai';

interface GoogleConnection {
  id: string;
  googleEmail: string;
  workspace: string;
  grantedScopes: string[];
  connectedAt: string;
  lastRefreshedAt: string | null;
  isPrimary: boolean;
}

/**
 * Read the user's Burtson Labs API key + AuthApi URL from resolved
 * config. The API key lives under `bandit.apiKey` regardless of
 * whether the user actually points their LLM provider at Bandit cloud
 * (provider=ollama users can still set it explicitly for AuthApi
 * access). Returns null when no key is set — caller surfaces a
 * user-actionable error directing them to `/connect`.
 */
function resolveCreds(cfg: ResolvedConfig): { apiKey: string; authApiUrl: string } | null {
  const apiKey = cfg.apiKey?.trim();
  if (!apiKey) return null;
  // BANDIT_AUTH_URL is the canonical env var (added 2026-05-27 for OSS
  // self-hosting). AUTH_API_URL is the legacy name kept so existing
  // CI / dev shells keep working without code changes. Falls through to
  // the Burtson Labs production URL otherwise.
  //
  // IMPORTANT — do NOT fall back to `cfg.apiUrl` here. That field is
  // the user's Bandit cloud LLM endpoint (api.burtson.ai), NOT the
  // AuthApi root (auth.burtson.ai). The two are deliberately separate
  // services on separate ingresses — conflating them produces a 404
  // at the validate step because /api/keys/validate only exists on
  // the auth service.
  const authApiUrl = (
    process.env.BANDIT_AUTH_URL ||
    process.env.AUTH_API_URL ||
    DEFAULT_AUTH_API_URL
  ).replace(/\/+$/, '');
  return { apiKey, authApiUrl };
}

/**
 * Exchange a Burtson Labs API key for a short-lived gateway JWT via
 * the existing AuthApi /api/keys/validate endpoint. The JWT is what
 * authorizes downstream `/api/me/google/*` calls. Throws on rejection
 * so the slash-command handler can surface a clear error.
 */
async function exchangeApiKeyForJwt(apiKey: string, authApiUrl: string): Promise<string> {
  // JWT-shaped keys (long, "ey…") are passed through unchanged — same
  // fast-path the MCP server's authGateway uses. Lets a power user
  // paste a JWT directly into `bandit.apiKey` for debugging.
  if (apiKey.length > 50 && apiKey.startsWith('ey')) return apiKey;

  // AuthApi's ApiKeyValidationRequest binds to `Key` (case-insensitive
  // via JSON binding, so `key` works too). The earlier shape sent
  // `apiKey` / `audience` / `tokenLifetimeMinutes` — none of those
  // bind, so the controller saw a null key and returned 400. The
  // gateway-scoped token that authorizes /api/me/google/* calls comes
  // back as `gatewayToken`, NOT `token`.
  const response = await fetch(`${authApiUrl}/api/keys/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: apiKey }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`AuthApi rejected the API key (HTTP ${response.status}${text ? `: ${text}` : ''})`);
  }
  const data = await response.json() as { valid?: boolean; gatewayToken?: string; reason?: string };
  if (data.valid === false) {
    throw new Error(`AuthApi rejected the API key: ${data.reason ?? 'invalid'}`);
  }
  if (!data.gatewayToken) {
    throw new Error('AuthApi /api/keys/validate did not return a gateway token (key may be valid but lack gateway access).');
  }
  return data.gatewayToken;
}

/**
 * Open the user's default browser to a URL. Best-effort —
 * cross-platform via the standard shell-out incantation. Returns
 * false when no opener is available so the caller can fall back to
 * printing the URL for manual copy.
 */
function openBrowser(url: string): boolean {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Bind an http listener on a free localhost port and resolve with the
 * port + a promise that resolves with the inbound query params when
 * the user lands back from AuthApi. Times out after 5 minutes — the
 * OAuth consent screen takes seconds, anything longer is the user
 * abandoning the flow.
 */
function startCallbackListener(): Promise<{
  port: number;
  awaitCallback: () => Promise<Record<string, string>>;
}> {
  return new Promise((resolve, reject) => {
    let capture: ((params: Record<string, string>) => void) | null = null;
    let captureErr: ((err: Error) => void) | null = null;
    const callback = new Promise<Record<string, string>>((res, rej) => {
      capture = res;
      captureErr = rej;
    });
    // Belt-and-suspenders: if startCallbackListener rejects on a bind
    // error BEFORE the caller has had a chance to consume awaitCallback,
    // the rejected callback promise would surface as unhandledRejection
    // and crash the process. The awaitCallback consumer still observes
    // the rejection because it `await`s the original `callback`, not
    // this chained variant — both chains fire independently when a
    // promise settles.
    callback.catch(() => { /* awaitCallback owns the user-facing surfacing */ });

    const server = http.createServer((req, res) => {
      // Path-match `/done` so we ignore favicon / random probes.
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/done') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const params: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        params[key] = value;
      });
      // Land a tiny success page so the browser tab isn't blank.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Bandit · connected</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0f18;color:#e8f1ff;margin:0;display:flex;align-items:center;justify-content:center;height:100vh}
.card{background:#0d1b2e;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:32px 40px;max-width:480px;text-align:center}
h1{font-size:1.4rem;margin:0 0 8px;color:#4fc3f7}
p{color:#94a6bc;margin:0;line-height:1.6}</style></head><body>
<div class="card"><h1>${params.google === 'connected' ? '✓ Workspace connected' : 'Connection complete'}</h1>
<p>You can close this tab and return to your terminal.</p></div></body></html>`);
      capture?.(params);
      // Tear down once the browser tab has its response — small delay
      // so the page actually renders before the socket closes.
      setTimeout(() => server.close(), 250);
    });

    server.on('error', (err) => {
      captureErr?.(err);
      reject(err);
    });

    // Port 0 = OS picks free port. Bind to 127.0.0.1 only — never
    // expose this on public interfaces.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address?.port) {
        // 5-minute timeout guard. If the user abandons the OAuth flow
        // we don't want this server hanging around forever.
        const timeout = setTimeout(() => {
          captureErr?.(new Error('Timed out waiting for browser callback after 5 minutes.'));
          server.close();
        }, 5 * 60_000);
        // Clear the timeout when the callback settles, but terminate
        // the chain with a no-op .catch so the awaitCallback consumer
        // is the sole owner of surfacing the rejection. Without that
        // .catch the .finally chain re-emitted the rejection on a
        // dangling promise and Node's default unhandledRejection
        // handler crashed the CLI process after awaitCallback had
        // already returned a friendly error message.
        callback
          .finally(() => clearTimeout(timeout))
          .catch(() => { /* awaitCallback owns the surfacing */ });

        resolve({ port: address.port, awaitCallback: () => callback });
      } else {
        reject(new Error('Could not determine bound port'));
      }
    });
  });
}

/**
 * Idempotently register the `burtson-labs` MCP server entry in
 * `~/.bandit/mcp-servers.json` so the agent's tool registry actually
 * receives Gmail/Drive/Sheets/Calendar tools after the OAuth
 * handshake. The OAuth flow alone only stores credentials in AuthApi —
 * the server-side stanza needs to be in the local config too for the
 * MCP pool to register the server at session start.
 *
 * Command-resolution preference order:
 *   1. Already-registered entry (no-op, preserves the user's custom config)
 *   2. Local build at `~/Documents/GitHub/burtson-labs-mcp/dist/index.js`
 *      (typical for users developing the MCP server alongside Bandit)
 *   3. npx fallback: `npx -y @burtson-labs/mcp-server` (post-publish path)
 *
 * Returns one of:
 *   - `{ action: 'skipped-already-registered', path }`
 *   - `{ action: 'created', path }`
 *   - `{ action: 'failed', error }`
 */
async function ensureBurtsonLabsMcpServerRegistered(): Promise<
  | { action: 'created'; path: string }
  | { action: 'skipped-already-registered'; path: string }
  | { action: 'failed'; error: string }
> {
  try {
    // Use process.cwd() for workspace config check + write target. The
    // host-kit helper does the right thing for both global + workspace
    // configs (workspace takes precedence; falls back to global).
    const cwd = process.cwd();
    const existing = await loadMcpServersConfig(cwd);
    if (existing && existing['burtson-labs']) {
      return { action: 'skipped-already-registered', path: '~/.bandit/mcp-servers.json' };
    }
    // Detect a local-build path; fall back to npx when the local build
    // isn't present. Both forms work — local-build keeps the user on
    // their latest checkout, npx is the right shape post-publish.
    const localBuild = path.join(os.homedir(), 'Documents', 'GitHub', 'burtson-labs-mcp', 'dist', 'index.js');
    let command: string;
    let args: string[];
    if (fs.existsSync(localBuild)) {
      command = 'node';
      args = [localBuild];
    } else {
      command = 'npx';
      args = ['-y', '@burtson-labs/mcp-server'];
    }
    // Pin whichever auth URL the user has configured into the MCP
    // server's launch env. The child process reads AUTH_API_URL (the
    // MCP server's own env-var contract); we accept BANDIT_AUTH_URL on
    // the Bandit side and translate.
    const authApiUrl = (
      process.env.BANDIT_AUTH_URL ||
      process.env.AUTH_API_URL ||
      DEFAULT_AUTH_API_URL
    ).replace(/\/+$/, '');
    const written = await addMcpServerToConfig(cwd, 'burtson-labs', {
      command,
      args,
      env: {
        AUTH_API_URL: authApiUrl,
        AUTH_ENABLED: 'true'
      },
      activation: 'always'
    });
    return { action: 'created', path: written };
  } catch (err) {
    return { action: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * /mcp google connect [--workspace=<label>] [--scopes=<csv>]
 *
 * End-to-end flow: API key → JWT → ticket → browser → local listener
 * → render success. The user's only manual step is clicking through
 * Google's consent screen in the browser tab Bandit opens for them.
 */
export async function connectGoogleViaCli(
  cfg: ResolvedConfig,
  args: { workspace?: string; scopes?: string }
): Promise<string> {
  const creds = resolveCreds(cfg);
  if (!creds) {
    return c.red(
      'No Burtson Labs API key configured. Run ' + c.cyan('/connect') +
      ' first (or set ' + c.cyan('bandit.apiKey') + ' in ~/.bandit/config.json).'
    );
  }

  let jwt: string;
  try {
    jwt = await exchangeApiKeyForJwt(creds.apiKey, creds.authApiUrl);
  } catch (err) {
    return c.red(`Couldn't exchange API key for a session token: ${err instanceof Error ? err.message : String(err)}`);
  }

  let listener: Awaited<ReturnType<typeof startCallbackListener>>;
  try {
    listener = await startCallbackListener();
  } catch (err) {
    return c.red(`Couldn't bind a localhost listener for the OAuth callback: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Mint the one-time ticket. The redirect points at our local
  // listener; the AuthApi callback hands us back ?google=connected
  // &workspace=… when Google's consent screen completes.
  let connectUrl: string;
  try {
    const ticketResp = await fetch(`${creds.authApiUrl}/api/me/google/connect/ticket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        workspace: args.workspace ?? '',
        scopes: args.scopes ?? 'gmail,docs,drive,sheets,calendar',
        redirect: `http://127.0.0.1:${listener.port}/done`,
      }),
    });
    if (!ticketResp.ok) {
      const text = await ticketResp.text().catch(() => '');
      throw new Error(`HTTP ${ticketResp.status}${text ? `: ${text}` : ''}`);
    }
    const data = await ticketResp.json() as { connectUrl: string };
    connectUrl = data.connectUrl;
  } catch (err) {
    return c.red(`Ticket mint failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Open the browser. If it fails (no DISPLAY, headless box, …), print
  // the URL so the user can manually paste it on another machine.
  const opened = openBrowser(connectUrl);
  const intro = [
    c.bold('Connecting Google workspace via auth.burtson.ai…'),
    '',
    opened
      ? c.dim('  ↳ A browser tab should have opened. Complete the Google consent flow there.')
      : c.dim('  ↳ Could not auto-open a browser. Open this URL manually:'),
  ];
  if (!opened) {
    intro.push(c.cyan('     ' + connectUrl));
  }
  intro.push(c.dim('  (Will time out in 5 minutes if not completed.)'));
  process.stdout.write(intro.join('\n') + '\n');

  let params: Record<string, string>;
  try {
    params = await listener.awaitCallback();
  } catch (err) {
    return c.red(`OAuth callback never landed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (params.google === 'connected') {
    const ws = params.workspace ?? '(auto-derived)';

    // Half-shipped flow fix: until v1.7.272, the OAuth handshake
    // landed credentials in AuthApi but never wrote the matching
    // MCP server entry to ~/.bandit/mcp-servers.json — meaning the
    // user saw "✓ Connected workspace" but Bandit's agent had no
    // Gmail/Drive/Sheets/Calendar tools in its registry because the
    // burtson-labs MCP server wasn't registered. Now we finish the
    // job: register the server entry too (idempotent), so the agent
    // picks up the tools on the next session start.
    const registerResult = await ensureBurtsonLabsMcpServerRegistered();
    const tail: string[] = [];
    if (registerResult.action === 'created') {
      tail.push(c.dim(`  ↳ registered MCP server: ${c.cyan('burtson-labs')} → ${registerResult.path}`));
      tail.push(c.dim(`  ↳ restart Bandit (or run ${c.cyan('/mcp reload')}) to pick up the new tools.`));
    } else if (registerResult.action === 'skipped-already-registered') {
      tail.push(c.dim(`  ↳ MCP server already registered at ${registerResult.path}`));
    } else if (registerResult.action === 'failed') {
      tail.push(c.yellow(`  ⚠ Connected but could NOT auto-register the MCP server: ${registerResult.error}`));
      tail.push(c.dim('     Add the entry to ~/.bandit/mcp-servers.json manually — see docs.'));
    }

    return c.green(`✓ Connected workspace `) + c.cyan(ws) +
      (tail.length > 0 ? '\n' + tail.join('\n') : '') +
      c.green(`\n  Run `) + c.cyan('/mcp google list') + c.green(' to verify.');
  }
  if (params.error) {
    return c.red(`Google connect returned an error: ${params.error}`);
  }
  return c.yellow('Connection callback returned without success or error params. Re-try the flow.');
}

/**
 * /mcp google list — show the user's existing Google connections.
 * Mirrors the table on burtson.ai/mcp but in monospace.
 */
export async function listGoogleConnections(cfg: ResolvedConfig): Promise<string> {
  const creds = resolveCreds(cfg);
  if (!creds) {
    return c.red('No Burtson Labs API key configured. Run ' + c.cyan('/connect') + ' first.');
  }

  let jwt: string;
  try {
    jwt = await exchangeApiKeyForJwt(creds.apiKey, creds.authApiUrl);
  } catch (err) {
    return c.red(`Couldn't authenticate: ${err instanceof Error ? err.message : String(err)}`);
  }

  let connections: GoogleConnection[];
  try {
    const response = await fetch(`${creds.authApiUrl}/api/me/google/connections`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${text ? `: ${text}` : ''}`);
    }
    const data = await response.json() as { connections: GoogleConnection[] };
    connections = data.connections ?? [];
  } catch (err) {
    return c.red(`Couldn't fetch connections: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (connections.length === 0) {
    return [
      c.dim('No Google workspaces connected yet.'),
      c.dim('Run ') + c.cyan('/mcp google connect') + c.dim(' to authorize one.'),
    ].join('\n');
  }

  const lines: string[] = [c.bold(`Google connections (${connections.length}):`)];
  for (const conn of connections) {
    const primary = conn.isPrimary ? c.yellow(' ★ primary') : '';
    const scopes = conn.grantedScopes
      .map((s) => s.replace(/^https:\/\/www\.googleapis\.com\/auth\//, ''))
      .map((s) => s.replace(/\.modify$|\.events$/, ''))
      .join(', ');
    lines.push(`  ${c.cyan(conn.googleEmail.padEnd(28))} ${c.dim('workspace=')}${c.bold(conn.workspace)}${primary}`);
    lines.push(c.dim(`    id: ${conn.id} · scopes: ${scopes}`));
    if (conn.lastRefreshedAt) {
      lines.push(c.dim(`    last used: ${new Date(conn.lastRefreshedAt).toLocaleString()}`));
    }
  }
  return lines.join('\n');
}

/**
 * /mcp google disconnect <id> — drop a workspace connection on the
 * AuthApi side. Refresh token is removed from the
 * userGoogleConnections collection; Google-side authorization stays
 * granted until the user revokes it at myaccount.google.com.
 */
export async function disconnectGoogle(cfg: ResolvedConfig, connectionId: string): Promise<string> {
  const creds = resolveCreds(cfg);
  if (!creds) {
    return c.red('No Burtson Labs API key configured. Run ' + c.cyan('/connect') + ' first.');
  }
  if (!connectionId || connectionId.trim().length === 0) {
    return c.red('Usage: /mcp google disconnect <connection-id> — get the id from /mcp google list');
  }

  let jwt: string;
  try {
    jwt = await exchangeApiKeyForJwt(creds.apiKey, creds.authApiUrl);
  } catch (err) {
    return c.red(`Couldn't authenticate: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const response = await fetch(`${creds.authApiUrl}/api/me/google/connections/${encodeURIComponent(connectionId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (response.status === 404) {
      return c.red(`Connection ${connectionId} not found (or not owned by this user).`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${text ? `: ${text}` : ''}`);
    }
  } catch (err) {
    return c.red(`Disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return c.green('✓ Connection removed. ') + c.dim('Google-side authorization persists; revoke at myaccount.google.com for full cleanup.');
}

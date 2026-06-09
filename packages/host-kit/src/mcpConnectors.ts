/**
 * Connector wizards — convenience helpers that turn a single user
 * input (a token, a credential, etc.) into a fully-formed McpServerConfig
 * for a well-known provider's official MCP server. Each wizard is a
 * small, single-purpose function; the surfaces (CLI slash command,
 * extension Connections panel) call into these to avoid duplicating
 * the spawn-command shape across surfaces.
 *
 * Phase 3 starts with GitHub — it's the simplest viable wizard
 * (single PAT, no OAuth callback). Slack / Google / Microsoft follow
 * as they each ship.
 */

import type { McpServerConfig } from '@burtson-labs/agent-core';

/**
 * Build a server config that runs `@modelcontextprotocol/server-github`
 * via npx with the user's PAT. The token never lands in the config
 * file's `args` (those are sometimes logged by editors); it goes into
 * the env block which Bandit explicitly excludes from the trust
 * fingerprint and from any UI surfaces that echo configs back.
 *
 * Activation defaults to "on-mention" with the standard github
 * triggers so the GitHub server's tools only land in the prompt
 * budget when the user actually mentions GitHub-y things.
 */
export function buildGitHubServerConfig(token: string): McpServerConfig {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('GitHub PAT is required');
  return {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: trimmed },
    activation: 'on-mention'
  };
}

/**
 * Reasonable token-shape sanity check. GitHub PATs come in three
 * flavors: classic (`ghp_…`, ~40 chars), fine-grained (`github_pat_…`,
 * ~93 chars), and OAuth (`gho_…`). All start with a known prefix.
 * We're not validating against the API here — just catching the
 * fat-finger "I pasted my SSH key" failure mode before the user
 * gets a confusing 401 from the server.
 */
export function looksLikeGitHubToken(token: string): boolean {
  const t = token.trim();
  return /^(ghp_|gho_|ghs_|ghu_|github_pat_)/.test(t);
}

/**
 * Build a server config that runs `@modelcontextprotocol/server-slack`
 * via npx. Slack's MCP server requires two env vars: a Bot User OAuth
 * Token (`xoxb-…`) and the workspace's Team ID (`T…`). We ship the
 * wizard with `activation: 'on-mention'` so Slack tools only land in
 * the prompt budget when the user actually mentions slack/channel/
 * message — the standard auto-derived triggers from activation.ts.
 */
export function buildSlackServerConfig(botToken: string, teamId: string): McpServerConfig {
  const tk = botToken.trim();
  const team = teamId.trim();
  if (!tk) throw new Error('Slack bot token (xoxb-…) is required');
  if (!team) throw new Error('Slack team ID (T…) is required');
  return {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: { SLACK_BOT_TOKEN: tk, SLACK_TEAM_ID: team },
    activation: 'on-mention'
  };
}

/** Slack Bot User OAuth tokens always start with "xoxb-". User tokens
 * are "xoxp-"; we deliberately accept both since the MCP server
 * works with either, but the docs recommend bot tokens. */
export function looksLikeSlackToken(token: string): boolean {
  return /^xox[bp]-/.test(token.trim());
}

/** Slack workspace IDs start with "T" followed by alphanumerics. We
 * accept any non-empty string starting with T to allow for future
 * changes in Slack's ID format. */
export function looksLikeSlackTeamId(teamId: string): boolean {
  return /^T[A-Z0-9]+$/i.test(teamId.trim());
}

/**
 * Build a server config that runs `@modelcontextprotocol/server-gitlab`
 * via npx. Defaults to GitLab.com's API; users with self-hosted
 * GitLab can pass the API base URL through GITLAB_API_URL.
 */
export function buildGitLabServerConfig(token: string, apiUrl?: string): McpServerConfig {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('GitLab personal access token is required');
  const env: Record<string, string> = {
    GITLAB_PERSONAL_ACCESS_TOKEN: trimmed
  };
  const trimmedUrl = (apiUrl ?? '').trim();
  if (trimmedUrl) env.GITLAB_API_URL = trimmedUrl;
  return {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gitlab'],
    env,
    activation: 'on-mention'
  };
}

/** GitLab PATs are typically 20 chars of base64-ish content with a
 * `glpat-` prefix on newer tokens (since GitLab 14.5). We accept
 * any non-empty string ≥ 20 chars to support older tokens too. */
export function looksLikeGitLabToken(token: string): boolean {
  const t = token.trim();
  if (t.startsWith('glpat-')) return true;
  return t.length >= 20 && /^[A-Za-z0-9_-]+$/.test(t);
}

/**
 * Build a server config that runs `@gongrzhe/server-gmail-autoauth-mcp`
 * via npx with the user's downloaded Google Cloud OAuth credentials.
 * the first Phase 3 Google-flavor wizard, closing the gap
 * memo'd in the 2026-04-29 MCP roadmap (Office 365 / Google / Slack
 * / GitHub all named as Phase 3 targets; GitHub + Slack + GitLab
 * shipped, Google was the last hold-out).
 *
 * Why this server: it's the most-cited community Gmail MCP server,
 * speaks the standard stdio MCP shape, and handles the OAuth dance
 * (browser popup → save refresh token) automatically on first spawn.
 * Anthropic doesn't ship a `server-gmail` from the official MCP repo,
 * so picking a community implementation is unavoidable — gongrzhe is
 * well-maintained as of this writing.
 *
 * Setup the user has to do first (we can't):
 * 1. Create an OAuth 2.0 client in https://console.cloud.google.com/
 * Type: Desktop app. Enable the Gmail API on the project first.
 * 2. Download the credentials JSON (the "OAuth client" download).
 * 3. Pass that file path to this wizard.
 *
 * The first Bandit turn that touches Gmail will open a browser for the
 * Google consent screen. After that the server caches a refresh token
 * to `~/.gmail-mcp/credentials.json` and runs unattended.
 */
export function buildGmailServerConfig(credentialsPath: string): McpServerConfig {
  const trimmed = credentialsPath.trim();
  if (!trimmed) throw new Error('Path to Google OAuth credentials JSON is required');
  return {
    command: 'npx',
    args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
    env: {
      // The gongrzhe server reads GMAIL_OAUTH_PATH if set, otherwise
      // defaults to ~/.gmail-mcp/gcp-oauth.keys.json. Pinning the env
      // var so the wizard doesn't depend on the user pre-creating
      // that directory or copying the credentials there manually.
      GMAIL_OAUTH_PATH: trimmed
    },
    activation: 'on-mention'
  };
}

/** Light shape check: the user pointed at a path that looks like a
 * Google OAuth credentials JSON. We don't open the file here (host-
 * kit stays filesystem-agnostic for testability); the wizard layer
 * does the actual fs check before calling this. */
export function looksLikeGmailCredentialsPath(p: string): boolean {
  const t = p.trim();
  if (!t) return false;
  // Must look like a real path AND end in .json. Reject obvious garbage
  // (URLs, single words) so users don't paste a token by mistake.
  if (!/\.json$/i.test(t)) return false;
  return t.includes('/') || t.includes('\\') || t.startsWith('~');
}

/**
 * Build a fully-custom server config from raw inputs. Used by the
 * "+ Custom" wizard tile so users can register any MCP server (Linear,
 * Jira, Bitbucket, Sentry, Postgres, an internal one they wrote) without
 * waiting for Bandit to ship a dedicated wizard for that provider.
 *
 * `envInput` accepts the standard `KEY=VALUE` shape one-per-line, the
 * format every CLI / dotfile uses, so users can paste from a `.env`.
 */
export function buildCustomServerConfig(params: {
  command: string;
  args?: string[];
  envInput?: string;
  activation?: 'always' | 'on-mention';
}): McpServerConfig {
  const cmd = params.command.trim();
  if (!cmd) throw new Error('Command is required');
  const env: Record<string, string> = {};
  if (params.envInput) {
    for (const rawLine of params.envInput.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue; // require a non-empty key before =
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      // Strip surrounding quotes (matches dotenv loader semantics) so
      // copy-paste from a .env file Just Works™.
      const unquoted = value.replace(/^["']|["']$/g, '');
      env[key] = unquoted;
    }
  }
  return {
    command: cmd,
    args: params.args && params.args.length > 0 ? params.args : undefined,
    env: Object.keys(env).length > 0 ? env : undefined,
    activation: params.activation ?? 'on-mention'
  };
}

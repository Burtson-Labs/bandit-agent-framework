/**
 * MCP "add server" wizards extracted from extension.ts.
 *
 * Why: extension.ts crossed 9k lines and bandit's self-evaluation
 * flagged it as monolithic. The four wizard handlers (GitHub, Slack,
 * GitLab, Custom) followed the same shape — chained showInputBox
 * prompts, build a config, write it to disk, pre-approve the
 * fingerprint, reload the pool, sync state, show a notification —
 * and were each 35-55 lines. They are pulled out as standalone
 * functions that take a tiny context bag for the host-side hooks
 * (workspace root + reload+sync callback). The lightweight handlers
 * (mcpReload, mcpReconnect, mcpDisconnect, mcpSetActivation,
 * mcpRevokeTrust) stay inline — they're 5-15 lines each and don't
 * justify a helper file.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  addMcpServerToConfig,
  approveMcpFingerprint,
  buildCustomServerConfig,
  buildGitHubServerConfig,
  buildGitLabServerConfig,
  buildGmailServerConfig,
  buildSlackServerConfig,
  looksLikeGitHubToken,
  looksLikeGitLabToken,
  looksLikeGmailCredentialsPath,
  looksLikeSlackTeamId,
  looksLikeSlackToken
} from '@burtson-labs/host-kit';
import { fingerprintServerConfig } from '@burtson-labs/agent-core';

export interface McpWizardContext {
  /** Workspace root (or process.cwd() fallback) where mcp-servers.json lives. */
  workspaceRoot: string;
  /** Reload the MCP pool from disk and re-sync the webview state. */
  reloadAndSync(): Promise<void>;
  /** Send a host-level message to the webview (used to open settings on success). */
  postMessage(message: { type: 'openSettings' }): void;
}

/**
 * Run the GitHub MCP wizard: prompt for a PAT, write the config,
 * pre-approve the fingerprint (the user actively chose this connector
 * — re-prompting on first spawn would be friction), reload the pool,
 * sync state, and offer to open the Connections panel.
 */
export async function runGitHubWizard(ctx: McpWizardContext): Promise<void> {
  const token = await vscode.window.showInputBox({
    prompt: 'GitHub Personal Access Token (classic or fine-grained)',
    placeHolder: 'ghp_… or github_pat_…',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const v = value?.trim() ?? '';
      if (!v) {return 'Token is required';}
      if (!looksLikeGitHubToken(v)) {
        return 'Doesn\'t look like a GitHub token. Classic PATs start with "ghp_"; fine-grained start with "github_pat_".';
      }
      return undefined;
    }
  });
  if (!token) {return;}

  try {
    const config = buildGitHubServerConfig(token);
    const target = await addMcpServerToConfig(ctx.workspaceRoot, 'github', config);
    const fingerprint = fingerprintServerConfig('github', config);
    await approveMcpFingerprint(fingerprint).catch(() => { /* best effort */ });
    await ctx.reloadAndSync();
    const link = await vscode.window.showInformationMessage(
      `GitHub MCP server added. Saved to ${target}. Try: "list my open PRs" or "show issues assigned to me".`,
      'Open Connections'
    );
    if (link === 'Open Connections') {
      ctx.postMessage({ type: 'openSettings' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await vscode.window.showErrorMessage(`Could not add GitHub server: ${msg}`);
  }
}

/**
 * Slack wizard: chains bot token + team ID prompts, then writes the
 * config and pre-approves. Same trust pattern as GitHub.
 */
export async function runSlackWizard(ctx: McpWizardContext): Promise<void> {
  const botToken = await vscode.window.showInputBox({
    prompt: 'Slack Bot User OAuth Token',
    placeHolder: 'xoxb-…',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const v = value?.trim() ?? '';
      if (!v) {return 'Bot token is required';}
      if (!looksLikeSlackToken(v)) {return 'Doesn\'t look like a Slack bot token (expected prefix: xoxb-).';}
      return undefined;
    }
  });
  if (!botToken) {return;}

  const teamId = await vscode.window.showInputBox({
    prompt: 'Slack Workspace / Team ID',
    placeHolder: 'T01ABC23DEF',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const v = value?.trim() ?? '';
      if (!v) {return 'Team ID is required';}
      if (!looksLikeSlackTeamId(v)) {return 'Team ID should start with "T" (e.g. T01ABC23DEF). Find it via https://yourworkspace.slack.com/services/SOMETHING — the URL contains the T-prefixed ID.';}
      return undefined;
    }
  });
  if (!teamId) {return;}

  try {
    const config = buildSlackServerConfig(botToken, teamId);
    const target = await addMcpServerToConfig(ctx.workspaceRoot, 'slack', config);
    const fingerprint = fingerprintServerConfig('slack', config);
    await approveMcpFingerprint(fingerprint).catch(() => { /* best effort */ });
    await ctx.reloadAndSync();
    await vscode.window.showInformationMessage(
      `Slack MCP server added. Saved to ${target}. Try: "what's in #engineering recently?" or "post the deploy summary to #releases".`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await vscode.window.showErrorMessage(`Could not add Slack server: ${msg}`);
  }
}

/**
 * GitLab wizard: PAT + optional self-hosted API URL. An empty URL
 * means "use gitlab.com" (showInputBox returns `''` for Enter,
 * `undefined` for cancel — we treat both as the default).
 */
export async function runGitLabWizard(ctx: McpWizardContext): Promise<void> {
  const token = await vscode.window.showInputBox({
    prompt: 'GitLab Personal Access Token',
    placeHolder: 'glpat-…',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const v = value?.trim() ?? '';
      if (!v) {return 'Token is required';}
      if (!looksLikeGitLabToken(v)) {return 'Doesn\'t look like a GitLab PAT (expected glpat- prefix or ≥20 chars).';}
      return undefined;
    }
  });
  if (!token) {return;}

  const apiUrl = await vscode.window.showInputBox({
    prompt: 'GitLab API URL (leave blank for gitlab.com)',
    placeHolder: 'https://gitlab.example.com/api/v4',
    ignoreFocusOut: true
  });
  const url = apiUrl?.trim() || undefined;

  try {
    const config = buildGitLabServerConfig(token, url);
    const target = await addMcpServerToConfig(ctx.workspaceRoot, 'gitlab', config);
    const fingerprint = fingerprintServerConfig('gitlab', config);
    await approveMcpFingerprint(fingerprint).catch(() => { /* best effort */ });
    await ctx.reloadAndSync();
    await vscode.window.showInformationMessage(
      `GitLab MCP server added. Saved to ${target}. Try: "list my open MRs" or "show recent issues in <project>".`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await vscode.window.showErrorMessage(`Could not add GitLab server: ${msg}`);
  }
}

/**
 * Gmail wizard: chains an instructional note, asks for the path to
 * the user's downloaded Google Cloud OAuth credentials JSON, copies
 * it into ~/.gmail-mcp/ where the upstream server looks for it, and
 * writes the standard config. First Gmail-touching turn after this
 * triggers the Google browser consent screen; the server caches the
 * refresh token locally and runs unattended thereafter.
 *
 * the last Phase 3 connector. Office 365 still pending if
 * users ask, but Gmail covers the dominant email-management use case.
 */
export async function runGmailWizard(ctx: McpWizardContext): Promise<void> {
  // Step 1: instructional pre-amble. Google OAuth is the one provider
  // where the wizard CANNOT do the setup for the user — they have to
  // create a Cloud project and download credentials themselves.
  const proceed = await vscode.window.showInformationMessage(
    'Gmail MCP needs a Google OAuth credentials file you create yourself. Open the Cloud Console to set one up?',
    { modal: true, detail: 'Steps:\n1. Create a Google Cloud project (or pick existing).\n2. Enable the Gmail API.\n3. Create an OAuth 2.0 Client ID of type "Desktop app".\n4. Download the JSON credentials.\n5. Come back and point the wizard at that file.' },
    'Open Cloud Console',
    'I already have credentials'
  );
  if (!proceed) {return;}
  if (proceed === 'Open Cloud Console') {
    await vscode.env.openExternal(vscode.Uri.parse('https://console.cloud.google.com/apis/credentials'));
    // Don't proceed yet — user needs to do the Google Cloud dance and
    // come back. They'll re-run the wizard after downloading.
    await vscode.window.showInformationMessage(
      'When you have the credentials JSON downloaded, run Bandit: Add Gmail MCP Server again and pick "I already have credentials".'
    );
    return;
  }

  const credentialsPath = await vscode.window.showInputBox({
    prompt: 'Path to your Google OAuth credentials JSON',
    placeHolder: '~/Downloads/client_secret_….json',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const v = value?.trim() ?? '';
      if (!v) {return 'Path is required';}
      if (!looksLikeGmailCredentialsPath(v)) {return 'Expected a path ending in .json (downloaded from Google Cloud Console → Credentials).';}
      // Resolve ~ before stat — same expansion the wizard does below.
      const resolved = v.startsWith('~/') ? path.join(os.homedir(), v.slice(2)) : v;
      try {
        if (!fs.existsSync(resolved)) {return `File not found: ${resolved}`;}
      } catch {
        return `Cannot read: ${resolved}`;
      }
      return undefined;
    }
  });
  if (!credentialsPath) {return;}

  try {
    // Resolve ~ and copy to ~/.gmail-mcp/gcp-oauth.keys.json — the
    // default path the upstream server falls back to. We ALSO pin the
    // path via GMAIL_OAUTH_PATH in the config so the wizard still works
    // even if the user's HOME differs from where bandit runs (e.g.
    // launchctl-spawned processes with a sparse env).
    const sourcePath = credentialsPath.trim().startsWith('~/')
      ? path.join(os.homedir(), credentialsPath.trim().slice(2))
      : credentialsPath.trim();
    const targetDir = path.join(os.homedir(), '.gmail-mcp');
    const targetPath = path.join(targetDir, 'gcp-oauth.keys.json');
    await fs.promises.mkdir(targetDir, { recursive: true });
    await fs.promises.copyFile(sourcePath, targetPath);

    const config = buildGmailServerConfig(targetPath);
    const target = await addMcpServerToConfig(ctx.workspaceRoot, 'gmail', config);
    const fingerprint = fingerprintServerConfig('gmail', config);
    await approveMcpFingerprint(fingerprint).catch(() => { /* best effort */ });
    await ctx.reloadAndSync();
    await vscode.window.showInformationMessage(
      `Gmail MCP server added. Saved to ${target}. The first time you say "check my email" or "draft a reply to…", a browser tab will open for Google's consent screen — approve once and the server caches the refresh token at ~/.gmail-mcp/credentials.json.`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await vscode.window.showErrorMessage(`Could not add Gmail server: ${msg}`);
  }
}

/**
 * Custom wizard for any MCP server we don't ship a dedicated wizard
 * for (Linear / Jira / Bitbucket / Sentry / Postgres / internal
 * tooling). Three chained input boxes: name → command (with args) →
 * env block. Env block accepts `KEY=VALUE` lines separated by `\n`
 * or `;` since showInputBox is single-line only.
 */
export async function runCustomWizard(ctx: McpWizardContext): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: 'Server name (one word, used in tool namespace as <name>.<tool>)',
    placeHolder: 'linear',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v?.trim() ?? '';
      if (!t) {return 'Name is required';}
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(t)) {return 'Use letters / digits / dashes / underscores; start with letter or digit.';}
      return undefined;
    }
  });
  if (!name) {return;}

  const commandLine = await vscode.window.showInputBox({
    prompt: 'Command line to spawn the server (e.g. "npx -y @some/mcp-server")',
    placeHolder: 'npx -y @company/mcp-internal',
    ignoreFocusOut: true,
    validateInput: (v) => (v?.trim() ? undefined : 'Command is required')
  });
  if (!commandLine) {return;}

  const envBlock = await vscode.window.showInputBox({
    prompt: 'Environment variables, KEY=VALUE one per line. Leave blank for none.',
    placeHolder: 'LINEAR_API_KEY=lin_api_…',
    ignoreFocusOut: true
  });
  const envInput = (envBlock ?? '').replace(/;/g, '\n');
  const tokens = commandLine.trim().split(/\s+/);
  const command = tokens[0];
  const args = tokens.slice(1);

  try {
    const config = buildCustomServerConfig({ command, args, envInput });
    const target = await addMcpServerToConfig(ctx.workspaceRoot, name.trim(), config);
    const fingerprint = fingerprintServerConfig(name.trim(), config);
    await approveMcpFingerprint(fingerprint).catch(() => { /* best effort */ });
    await ctx.reloadAndSync();
    await vscode.window.showInformationMessage(
      `MCP server "${name.trim()}" added. Saved to ${target}. Activation defaults to on-mention — type the server name or one of its tool keywords in a prompt to summon it.`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await vscode.window.showErrorMessage(`Could not add custom server: ${msg}`);
  }
}

/**
 * MCP server activation — decides which servers should contribute
 * tools to the current turn's registry.
 *
 * - "always" (default): every prompt registers the server's tools.
 * Backwards compatible with the - behavior.
 * - "on-mention": tools register only when the user's prompt
 * mentions one of the server's trigger keywords. Lets users
 * configure many servers without every tool definition landing
 * in every system prompt.
 *
 * The matcher is intentionally simple — case-insensitive substring
 * search across name + triggers + auto-derived defaults for well-
 * known providers. Cheap (~microseconds per server) and easy to
 * reason about; users who want fancier matching can drop the server
 * to "always" and pay the prompt cost.
 */

import type { McpServerConfig } from './types';

/**
 * Default trigger keywords for popular MCP servers. Auto-applied
 * when the user's config doesn't specify explicit triggers and the
 * server name (or one of these keys) is in the registered name.
 *
 * The match is two-way: "slack" in the server name → use these
 * triggers, AND a server's own name is always a trigger so users
 * who name their server something custom still get a sensible
 * baseline ("my-slack-bot" matches if the prompt mentions
 * "my-slack-bot" or "slack").
 */
const DEFAULT_TRIGGERS_FOR_PROVIDER: Record<string, string[]> = {
  slack: ['slack', 'channel', 'workspace', 'dm', 'message'],
  github: ['github', 'repo', 'repository', 'pr', 'pull request', 'issue', 'commit'],
  gmail: ['gmail', 'email', 'inbox', 'mail'],
  gdrive: ['drive', 'gdrive', 'docs', 'spreadsheet', 'document', 'folder'],
  google: ['google'],
  calendar: ['calendar', 'meeting', 'schedule', 'event', 'appointment'],
  outlook: ['outlook', 'email', 'inbox', 'mail'],
  teams: ['teams', 'channel', 'meeting'],
  microsoft: ['microsoft', 'office', 'sharepoint', 'onedrive'],
  filesystem: ['file', 'folder', 'directory'],
  postgres: ['postgres', 'sql', 'database', 'query'],
  mongo: ['mongo', 'mongodb', 'database', 'query']
};

/**
 * Identify the well-known provider this server's name implies (if
 * any). Used both to pick default triggers AND by the UI to render
 * a brand icon. Returns null when no provider hint is found — the
 * server gets only its own name as a trigger.
 */
export function inferProviderHint(serverName: string): string | null {
  const lower = serverName.toLowerCase();
  for (const key of Object.keys(DEFAULT_TRIGGERS_FOR_PROVIDER)) {
    if (lower.includes(key)) {return key;}
  }
  return null;
}

/**
 * Compute the effective trigger set for one server. Always includes
 * the server's own name; merges in explicit triggers from config and
 * auto-derived defaults for well-known providers.
 */
export function effectiveTriggers(serverName: string, config: McpServerConfig): string[] {
  const set = new Set<string>();
  set.add(serverName.toLowerCase());
  for (const t of config.triggers ?? []) {set.add(t.toLowerCase());}
  const provider = inferProviderHint(serverName);
  if (provider) {
    for (const t of DEFAULT_TRIGGERS_FOR_PROVIDER[provider]) {set.add(t);}
  }
  return [...set];
}

/**
 * Decide whether a server should contribute tools for this prompt.
 *
 * - activation === "always" (default) → true regardless of prompt.
 * - activation === "on-mention" → true iff at least one trigger
 * appears as a substring in the prompt (case-insensitive).
 * - disabled === true → false (server is off entirely).
 *
 * The prompt is matched against trigger words with simple substring
 * containment — so "post a message in slack" matches the "slack"
 * trigger; "slacking off" also matches but that's an acceptable
 * false positive for a one-line matcher (the cost of a wasted tool
 * registration on a misread prompt is bounded — Bandit just sends
 * a few extra tool defs that the model ignores).
 */
export function shouldActivateServer(
  serverName: string,
  config: McpServerConfig,
  prompt: string | undefined
): boolean {
  if (config.disabled) {return false;}
  const mode = config.activation ?? 'always';
  if (mode === 'always') {return true;}
  if (!prompt) {return false;}
  const haystack = prompt.toLowerCase();
  const triggers = effectiveTriggers(serverName, config);
  return triggers.some((t) => haystack.includes(t));
}

/**
 * Universal MCP intent keywords — when the user explicitly says "mcp"
 * or "model context protocol", they're asking to use MCP tooling
 * generally, not naming a specific server. Treat that as a mention
 * of every configured server so the first-time-spawn gate doesn't
 * skip enumeration just because the user didn't memorize the server
 * name. (Custom-named servers like "burtson-labs" have no other
 * trigger words; without this you'd have to type "burtson-labs" to
 * unlock its tools, which defeats the point of a generic "use mcp"
 * request.)
 */
const MCP_INTENT_KEYWORDS = ['mcp', 'model context protocol'];

/**
 * Pure trigger-match check — does this prompt mention the server's
 * name, any of its derived triggers, OR a universal MCP-intent
 * keyword? Returns true even for servers configured with
 * `activation: "always"`, where shouldActivateServer would
 * unconditionally return true. Used by host enumeration logic to
 * gate the FIRST-TIME spawn of an `always`-mode server: when we have
 * no cached tool list, we only want to spawn (and fire the trust
 * gate) when the user clearly intends to use that server — not on
 * every "hi". See getAllMcpAgentTools.
 */
export function isServerMentioned(
  serverName: string,
  config: McpServerConfig,
  prompt: string | undefined
): boolean {
  if (!prompt) {return false;}
  const haystack = prompt.toLowerCase();
  if (MCP_INTENT_KEYWORDS.some((k) => haystack.includes(k))) {return true;}
  const triggers = effectiveTriggers(serverName, config);
  return triggers.some((t) => haystack.includes(t));
}

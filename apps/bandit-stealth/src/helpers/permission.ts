/**
 * Permission-card helpers extracted from extension.ts.
 *
 * Why: extension.ts crossed 9k lines and bandit's self-evaluation
 * flagged it as monolithic. The permission flow weaves a webview
 * card into the chat assistant entry, then waits for the user's
 * choice and replaces the card with a resolved marker. The pieces
 * that don't touch class state (the JSON payload shape, the
 * resolved-marker formatter, the live-status marker stripper) are
 * pulled here so the class method becomes orchestration only.
 */
import { compactToolDisplayParam } from './formatting';

export interface PermissionRequestInfo {
  tool: string;
  primary: string;
  description: string;
  risk?: string;
  bodyPreview?: string;
  warning?: string;
  diffStats?: { added: number; removed: number };
  /** Full shell command — populated for run_command so the card shows
   *  the exact string the agent will execute, including pipes, flags,
   *  and trailing args. */
  command?: string;
  /** Key=value dump of all params for non-command tools (apply_edit
   *  find/replace, git_checkout branch, etc). Surfaced in the same
   *  monospace block as `command` so every tool call has auditable
   *  detail, not just run_command. */
  paramsPreview?: string;
}

export type PermissionChoice = 'once' | 'session' | 'save' | 'deny';

const THINKING_MARKER_RE = /\n*`⟳ (?:[a-z]+)…`\s*$/;
const TOOL_CALL_GEN_MARKER_RE = /\n*`⟳ (?:generating tool call|streaming response)(?:[^`]*)`\s*$/;

/**
 * Build the JSON payload the webview deserializes into a permission
 * card. Embedded into the assistant entry as a fenced
 * ```bandit-permission block so it survives the markdown render
 * pipeline; the chat component swaps to the interactive card when it
 * sees this fence type.
 */
export function buildPermissionCardPayload(id: string, req: PermissionRequestInfo): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: 'bandit:permission',
    id,
    tool: req.tool,
    primary: req.primary,
    description: req.description,
    bodyPreview: req.bodyPreview ?? ''
  };
  if (req.warning) {payload.warning = req.warning;}
  if (req.risk) {payload.risk = req.risk;}
  if (req.diffStats) {payload.diffStats = req.diffStats;}
  if (req.command) {payload.command = req.command;}
  if (req.paramsPreview) {payload.paramsPreview = req.paramsPreview;}
  return payload;
}

export function describePermissionRisk(tool: string, params: Record<string, string>): string {
  if (tool === 'write_file' || tool === 'apply_edit' || tool === 'replace_range' || tool === 'apply_patch') {
    return 'Modifies files. Review the preview before approving.';
  }
  if (tool === 'run_command') {
    const full = `${params.cmd ?? ''} ${params.args ?? ''}`.trim();
    if (/\b(rm|dd|mkfs|chmod|chown|sudo)\b|\b--force\b|\b-f\b/.test(full)) {
      return 'High impact shell command. Check the command and working directory carefully.';
    }
    if (/\b(npm|pnpm|yarn|bun|pip|cargo|go)\b.*\b(install|add|update|upgrade)\b/i.test(full)) {
      return 'May change dependencies or install packages.';
    }
    if (/^git\s+(push|commit|reset|checkout|clean|rebase|merge)\b/i.test(full)) {
      return 'Changes Git state or history. Confirm this is intended.';
    }
    return 'Runs in your shell with your local permissions.';
  }
  if (tool === 'task') {return 'Starts a focused agent with its own context and tool calls.';}
  if (tool.startsWith('git_')) {return 'Reads or changes Git state depending on the operation.';}
  if (tool === 'web_fetch' || tool === 'web_search') {return 'May contact the network and include fetched text in context.';}
  return 'Bandit is asking before using this capability.';
}

/**
 * Strip live-thinking / tool-call-generation status markers from the
 * tail of the assistant entry's content. Without this, a pending
 * "_⟳ pondering…_" marker lands BETWEEN the prior content and the
 * fenced permission block — subsequent marker ticks then strip only
 * the last-anchored marker and keep appending new ones AFTER the
 * permission fence, which has been observed to visually swamp the
 * card on slow renders. Stripping up-front keeps the card at the
 * tail where the user's eye is looking.
 */
export function stripLiveStatusMarkers(content: string): string {
  return content.replace(THINKING_MARKER_RE, '').replace(TOOL_CALL_GEN_MARKER_RE, '');
}

/**
 * Build the resolved-permission marker that replaces the live card
 * after the user chooses. Compacts absolute paths to workspace-
 * relative before embedding so a long path doesn't force the chat
 * pane to grow a horizontal scrollbar, and surfaces the user's deny
 * notes in the history so a scrollback explains why a tool was
 * blocked.
 */
export function buildResolvedPermissionMarker(
  tool: string,
  primary: string,
  choice: PermissionChoice,
  notes: string | undefined,
  workspaceRoot: string
): string {
  const label = choice === 'deny'
    ? '✗ denied'
    : choice === 'save'
      ? '✓ always allow (saved)'
      : choice === 'session'
        ? '✓ allowed for session'
        : '✓ allowed once';
  const compactPrimary = primary ? compactToolDisplayParam(primary, workspaceRoot) : '';
  const target = compactPrimary ? `\`${compactPrimary}\`` : '';
  const tail = choice === 'deny' && notes ? ` — "${notes.replace(/"/g, '\\"')}"` : '';
  // Build the inner text cleanly so markdown italic markers don't end
  // up adjacent to a trailing space (e.g. `_foo _`) — markdown-it
  // rejects that as an emphasis run and renders the underscores as
  // literal chars.
  const parts: string[] = [`${label}:`, tool];
  if (target) {parts.push(target);}
  const body = parts.join(' ') + tail;
  return `\n\n_${body}_\n`;
}

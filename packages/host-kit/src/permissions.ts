/**
 * Permission policy for tool execution.
 *
 * Hosts (CLI, VS Code extension) consult the policy BEFORE a tool runs.
 * The policy returns one of:
 *   - 'allow' : proceed without prompting
 *   - 'ask'   : prompt the user (host decides how — modal, [y/N], etc.)
 *   - 'deny'  : abort, model sees a blocked-tool result
 *
 * Patterns can target a tool by name ("write_file") or a tool+arg filter
 * ("write_file:src/**", "run_command:npm test*"). Glob matching uses the
 * same minimal engine as host-kit/mentions — *, **, ?, and {a,b}.
 *
 * Config shape in .bandit/settings.json:
 *
 *   {
 *     "permissions": {
 *       "allow": ["read_file", "list_files", "search_code", "write_file:docs/**"],
 *       "deny":  ["run_command:rm *"],
 *       "ask":   ["write_file", "run_command"]
 *     }
 *   }
 *
 * Evaluation order: deny > allow > ask > default.
 * Default for dangerous tools (write_file, apply_edit, replace_range, run_command) is 'ask'.
 * Default for read-only tools is 'allow'.
 */

export type PermissionDecision = 'allow' | 'ask' | 'deny';

export interface PermissionPolicy {
  allow: string[];
  deny: string[];
  ask: string[];
}

/** Tools that mutate state or execute code and therefore require ask-by-default. */
const DANGEROUS_TOOLS = new Set(['write_file', 'apply_edit', 'replace_range', 'apply_patch', 'run_command']);

/**
 * Mutating-tool name patterns used to gate MCP-bridged tools that
 * aren't in the static DANGEROUS_TOOLS set. Catches tools whose names
 * imply they change state outside Bandit's process — Gmail filters,
 * Calendar events, Drive files, etc. — so the user sees a permission
 * card before the agent silently archives 200 emails or creates a
 * filter that auto-trashes mail.
 *
 * Captured 2026-05-25: bandit-logic ran createFilter +
 * modifyMessageLabels + trashMessage without any permission prompt
 * because they're all MCP-bridged tools and the evaluator defaulted
 * to 'allow' for anything not in DANGEROUS_TOOLS. The user had no
 * idea the inbox was being changed until after the fact.
 *
 * Read-only patterns (list*, get*, search*, read*) are deliberately
 * NOT in this list — auto-allowing those keeps the agent able to
 * browse without prompt-spam. The principle: ask before write,
 * allow read by default.
 */
const MUTATING_PATTERNS: RegExp[] = [
  /^create[A-Z_]/,        // createFilter, createLabel, createEvent, createFolder, create_event
  /^update[A-Z_]/,        // updateDraft, updateEvent, updateSpreadsheet
  /^modify[A-Z_]/,        // modifyMessageLabels, modify_message_labels
  /^delete[A-Z_]/,        // deleteEvent, deleteFile, deleteFilter
  /^remove[A-Z_]/,        // removeLabel, removeMember
  /^trash[A-Z_]/,         // trashMessage
  /^archive[A-Z_]/,       // archiveMessage
  /^move[A-Z_]/,          // moveFile, moveMessage
  /^send[A-Z_]/,          // sendEmail, sendDraft, sendMessage
  /^post[A-Z_]/,          // postMessage, postComment
  /^add[A-Z_]/,           // addComment, addMember (catches additive mutations too)
  /^insert[A-Z_]/,        // insertText, insertEvent
  /^replace[A-Z_]/,       // replaceTableRowData, findAndReplace
  /^rename[A-Z_]/,        // renameSheet, renameTab, renameFile
  /^duplicate[A-Z_]/,     // duplicateSheet
  /^batch[A-Z_]/,         // batchWrite, batchUpdate
  /^write[A-Z_]/,         // writeSpreadsheet
  /^append[A-Z_]/,        // appendTableRows, appendToGoogleDoc, appendSpreadsheetRows
  /^clear[A-Z_]/,         // clearSpreadsheetRange
  /^copy[A-Z_]/,          // copyFile, copySheetTo (creates a new resource)
  /^upload[A-Z_]/,        // uploadFile
  /^revoke[A-Z_]/,        // revokeAccess
  /^grant[A-Z_]/,         // grantPermission
  /^triage[A-Z_]/,        // triageInbox (writes label/state)
  /^apply[A-Z_]/,         // applyTextStyle, applyParagraphStyle (modifies docs)
  /^set[A-Z_]/,           // setCellBorders, setRowHeights, setColumnWidths
  /^protect[A-Z_]/,       // protectRange
  /^group[A-Z_]/,         // groupRows
  /^ungroup[A-Z_]/,       // ungroupAllRows
  /^freeze[A-Z_]/,        // freezeRowsAndColumns
  /^auto[Rr]esize/,       // autoResizeColumns / autoResizeRows
  /^reply[A-Z_]/,         // replyToComment, replyToSheetsComment
  /^cancel[A-Z_]/,        // cancelEvent
  /^quick[Aa]dd/,         // quickAddEvent
];

/**
 * Strip the MCP namespace prefix (e.g. "burtson-labs.createFilter" →
 * "createFilter") before pattern-testing. Tools registered via
 * mcpToolToAgentTool get a "<server>.<tool>" naming convention; the
 * mutating-verb test operates on the tool name itself.
 */
function stripMcpNamespace(toolName: string): string {
  const dotIdx = toolName.indexOf('.');
  if (dotIdx > 0) return toolName.slice(dotIdx + 1);
  // mcp__server__tool naming convention (alternate)
  const underIdx = toolName.indexOf('__');
  if (underIdx > 0 && toolName.startsWith('mcp__')) {
    const after = toolName.slice(underIdx + 2);
    const next = after.indexOf('__');
    return next > 0 ? after.slice(next + 2) : after;
  }
  return toolName;
}

/**
 * Does this tool's name look like a mutating operation?
 * Used as the default-ask gate for MCP-bridged tools that aren't
 * declared in the in-tree DANGEROUS_TOOLS set.
 */
function looksMutating(toolName: string): boolean {
  const bareName = stripMcpNamespace(toolName);
  return MUTATING_PATTERNS.some((re) => re.test(bareName));
}

export const emptyPolicy = (): PermissionPolicy => ({ allow: [], deny: [], ask: [] });

/**
 * Merge two policies. Used to combine workspace settings with session
 * overrides (e.g. the user's "always allow for this session" choices).
 */
export function mergePolicies(a: PermissionPolicy, b: PermissionPolicy): PermissionPolicy {
  return {
    allow: [...new Set([...a.allow, ...b.allow])],
    deny: [...new Set([...a.deny, ...b.deny])],
    ask: [...new Set([...a.ask, ...b.ask])]
  };
}

/**
 * Evaluate the policy for a tool invocation. Returns the decision.
 *
 * @param toolName     Tool being invoked (e.g. "write_file")
 * @param primary      The first meaningful param value (path, cmd, url…)
 *                     used for fine-grained pattern matching. Empty
 *                     string if unknown.
 * @param policy       Merged workspace + session policy.
 * @param primaryFull  Optional fuller representation of the invocation
 *                     used for pattern matching alongside `primary`.
 *                     For `run_command` the host should pass the full
 *                     command line ("git push origin main") so glob
 *                     patterns like `run_command:git *` and
 *                     `run_command:rm *` work intuitively. When
 *                     omitted (default) only `primary` is consulted —
 *                     preserves the original semantics for callers
 *                     that don't need the wider match.
 */
export function evaluatePermission(
  toolName: string,
  primary: string,
  policy: PermissionPolicy,
  primaryFull?: string
): PermissionDecision {
  // Deny has highest precedence — explicit deny wins over explicit allow.
  if (matchesAny(toolName, primary, policy.deny, primaryFull)) return 'deny';
  if (matchesAny(toolName, primary, policy.allow, primaryFull)) return 'allow';
  if (matchesAny(toolName, primary, policy.ask, primaryFull)) return 'ask';

  // Default: dangerous tools require explicit permission, read-only are OK.
  // MCP-bridged tools whose names imply they mutate external state
  // (createFilter, trashMessage, modifyMessageLabels, sendEmail, etc.)
  // also default to 'ask' — without this, every MCP tool gets auto-
  // allowed and the user has no chance to stop the agent before it
  // archives 200 emails or creates a forwarding rule.
  if (DANGEROUS_TOOLS.has(toolName)) return 'ask';
  if (looksMutating(toolName)) return 'ask';
  return 'allow';
}

function matchesAny(
  toolName: string,
  primary: string,
  patterns: string[],
  primaryFull?: string
): boolean {
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    const colon = pattern.indexOf(':');
    if (colon === -1) {
      // Tool-only pattern: matches every invocation of that tool.
      if (pattern === toolName) return true;
      continue;
    }
    const toolPart = pattern.slice(0, colon);
    const argPart = pattern.slice(colon + 1);
    if (toolPart !== toolName) continue;
    // Try the wider form first when provided — this is what makes
    // patterns like `run_command:git *` and `run_command:rm *` work
    // (matching against "git push origin main", not just "git"). Fall
    // back to the narrow primary for grants stored at binary-only
    // scope and for non-run_command tools where primaryFull is
    // identical to primary.
    if (primaryFull && globMatch(argPart, primaryFull)) return true;
    if (globMatch(argPart, primary)) return true;
  }
  return false;
}

/**
 * Permission-pattern glob matcher.
 *
 * Unlike path-glob matchers, this one treats `*` as greedy (matching slashes
 * too) because permission patterns target heterogeneous inputs (commands,
 * URLs, paths) and users don't expect `/` to be segmenting. Keep `**` as an
 * alias for `*` for user convenience so both "write_file:src/**" and
 * "run_command:rm *" behave intuitively.
 */
function globMatch(pattern: string, input: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(input);
}

function globToRegex(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') { i++; }
      out += '.*';
    } else if (ch === '?') {
      out += '.';
    } else if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { out += '\\{'; continue; }
      const opts = glob.slice(i + 1, end).split(',').map(escapeRegex).join('|');
      out += `(?:${opts})`;
      i = end;
    } else if (/[.+^$()|\\]/.test(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  out += '$';
  return new RegExp(out);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * In-memory store for session-level "always allow" choices. Hosts instantiate
 * one per conversation so approvals reset when the user starts fresh.
 */
export class SessionPermissionStore {
  private readonly allow = new Set<string>();

  /** Remember an "always allow for this session" choice. */
  grant(toolName: string, primary?: string): void {
    this.allow.add(primary ? `${toolName}:${primary}` : toolName);
  }

  /** Returns a policy fragment reflecting session grants only. */
  toPolicy(): PermissionPolicy {
    return { allow: [...this.allow], deny: [], ask: [] };
  }

  clear(): void {
    this.allow.clear();
  }

  size(): number {
    return this.allow.size;
  }
}

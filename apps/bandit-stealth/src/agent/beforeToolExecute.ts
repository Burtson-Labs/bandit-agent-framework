import * as vscode from 'vscode';
import type {
  SessionPermissionStore} from '@burtson-labs/host-kit';
import {
  evaluatePermission,
  evaluateSecurityGuard,
  mergePolicies,
  persistAllowEntry,
  previewText,
  runHooks,
  type HookSettings,
  type TurnLogger
} from '@burtson-labs/host-kit';

import { describePermissionRisk } from '../helpers/permission';
import type { PermissionGateService } from '../provider/services/permissionGateService';
import type { ConversationEntry } from '../services/conversationTypes';
import { buildPermissionAskPreview } from './permissionAskPreview';
import type { TurnState } from './turnState';

export type BeforeToolExecuteResult =
  | { allow: true }
  | { allow: false; reason: string };

export type BeforeToolExecute = (
  call: { name: string; params: Record<string, string> }
) => Promise<BeforeToolExecuteResult>;

/**
 * Inputs to `buildBeforeToolExecute`. Captures everything the per-call
 * permission gate needs:
 *
 *  - `state`: per-turn mutable state (only `toolStartedAt` is touched
 *    here — the start-timestamp the tool-result handler reads back to
 *    compute durationMs).
 *  - `assistantEntry`: the live assistant conversation entry the
 *    permission card gets injected into (the gate service mutates
 *    `content`/`payload` in-place during inject and resolve).
 *  - `permissionGate` / `permissionStore`: the card-lifecycle service
 *    and the session allow-list, respectively. Decoupled because the
 *    `grant()` calls that promote a one-time approval into a session/
 *    saved policy still live at the decision site (see the deliberate
 *    "NOT in this service" note on `PermissionGateService`).
 *  - `hookSettings`: project-authored `PreToolUse` guardrails plus the
 *    workspace's `permissions.{allow,deny,ask}` config.
 *  - `workspaceRoot`: needed for resolving relative paths in the diff
 *    preview and for `persistAllowEntry` (writes to `.bandit/allow`).
 *  - `userGoal`: the user's prompt for this turn. Used by the
 *    edit-vs-create intent detector that warns when `write_file` is
 *    about to CREATE a new file while the prompt asked to EDIT one.
 *  - `turnLog`: append-only JSONL log written under `.bandit/logs/`.
 *    Receives `permission-request`, `permission-decision`, and
 *    `permission-denied` entries. `null` when the log couldn't be opened.
 *  - `notifyUser`: native OS notification when the chat panel isn't
 *    visible. The gate fires `('approval', ...)` so the user gets
 *    pinged when a permission card appears off-screen.
 */
export interface BeforeToolExecuteDeps {
  state: TurnState;
  assistantEntry: ConversationEntry;
  permissionGate: PermissionGateService;
  permissionStore: SessionPermissionStore;
  hookSettings: HookSettings;
  workspaceRoot: string;
  userGoal: string;
  turnLog: TurnLogger | null;
  notifyUser: (kind: 'approval', title: string, message: string) => void;
}

/**
 * Build the `beforeToolExecute` callback the tool-use loop (and the Task
 * subagent tool) invokes for every tool call. Returns `{allow: true}` to
 * proceed, or `{allow: false, reason}` to abort the call before it runs.
 *
 * Each returned closure owns its own per-turn state:
 *  - `turnApprovedKeys`: tracks (tool, primary) pairs the user said
 *    "Once" to. Re-entering the same key within this turn skips the
 *    card so parallel multi-region edits to one file don't stack
 *    duplicate prompts.
 *  - `inflightPermissions`: shared-promise dedup. Two parallel tool
 *    calls with the same (tool, primary) await one card instead of
 *    racing two.
 *
 * Both maps live in closure scope (not on `TurnState`) because they
 * exist for the lifetime of one `performToolUseCompletion` call only
 * and are not read or mutated by any other module.
 *
 * Decision order, every call:
 *
 *  1. **`PreToolUse` shell hooks.** Scripted guardrails — first non-zero
 *     exit denies the call. Reason is stderr (preferred) or stdout, with
 *     a fallback to `"PreToolUse hook exited N"`.
 *
 *  2. **Permission policy.** Evaluates the merged workspace config +
 *     session allow-list. `deny` aborts; `allow` proceeds; `ask` opens
 *     a permission card.
 *
 *  3. **`ask` short-circuits:**
 *     - Turn-local auto-grant if the (tool, primary) was already approved
 *       this turn via "Once" or higher.
 *     - `agent.autoApproveEdits` config bypass for `write_file` /
 *       `apply_edit` / `replace_range` / `apply_patch` (read fresh
 *       every call so flipping the setting mid-run takes effect on the
 *       next tool use). `run_command` is NEVER bypassed.
 *
 *  4. **Permission card.** Builds the card payload (with a compact diff
 *     preview for `write_file` / `replace_range`, an edit-vs-create
 *     warning when intent suggests an edit but the file would be
 *     created, and the full `command` string for `run_command`), shares
 *     in-flight promises across parallel duplicate calls, and awaits the
 *     user's choice. Each choice writes a `permission-decision` log
 *     entry; `session` promotes the tool to the session allow-list;
 *     `save` additionally persists `tool:primary` to `.bandit/allow`.
 *     `deny` with notes builds a guidance-aware reason the model sees on
 *     its next turn.
 *
 *  5. **`toolStartedAt` mark.** Every allow path sets
 *     `state.toolStartedAt.set(name, Date.now())` so the tool-result
 *     handler can compute `durationMs`. Not set on the deny paths.
 *
 * Load-bearing behaviors a refactor must preserve:
 *
 *  - **Sync `state.toolStartedAt` set on ALL allow paths.** Three sites
 *    (turn-local auto-grant, autoApproveEdits bypass, post-card "Once" /
 *    "Session" / "Save"). Skipping any one causes the corresponding
 *    `tool_result` to report `durationMs: NaN`.
 *  - **`inflightPermissions.delete(turnKey)` in the promise's finally.**
 *    Without this, a denied-and-then-re-attempted call inside the same
 *    turn would re-resolve from the stale settled promise instead of
 *    spawning a fresh card.
 *  - **`buildTurnKey`'s tool-only fallback.** Tools without a primary
 *    param (e.g. `list_directory` with no path) key on the tool name
 *    alone, so two parallel name-only calls also dedup.
 *  - **`primaryFull` for `run_command`.** The full `cmd + args` string
 *    is passed to `evaluatePermission` so workspace patterns like
 *    `run_command:git *` match identically here and in the CLI gate.
 *    Without it, a workspace rule for `git push` matches in CLI but is
 *    silently bypassed in the extension.
 *  - **`autoApproveEdits` bypass is config-keyed, not state-keyed.**
 *    Read fresh on every call so a mid-run toggle takes effect on the
 *    next tool use without restarting the loop.
 *  - **Deny-with-notes reason format.** The exact phrasing ("User
 *    denied X and asked you to revise your approach: \"notes\". Do not
 *    retry this tool call with the same arguments — adjust your plan
 *    based on the user's guidance.") is what nudges the model away from
 *    retrying with the same params. Loosening the phrasing reintroduces
 *    the loop-on-denial regression caught in v1.7.34x testing.
 */
export function buildBeforeToolExecute(deps: BeforeToolExecuteDeps): BeforeToolExecute {
  const {
    state,
    assistantEntry,
    permissionGate,
    permissionStore,
    hookSettings,
    workspaceRoot,
    userGoal,
    turnLog,
    notifyUser
  } = deps;

  // Turn-local auto-grant so parallel edits to the SAME file only
  // prompt once. Without this, a model that emits two apply_edit calls
  // in one iteration (common when it's patching two regions of the
  // same file) shows the user two back-to-back permission cards for
  // identical `tool + path` — which reads as a duplicate prompt bug.
  // Scope is this turn only; the map is GC'd when the closure dies.
  const turnApprovedKeys = new Set<string>();

  // Inflight permission promises keyed by turnKey. If two tool calls
  // fire in the same iteration for the same file, the second one
  // awaits the first's card instead of spawning its own.
  const inflightPermissions = new Map<
    string,
    Promise<{ choice: 'once' | 'session' | 'save' | 'deny'; notes?: string }>
  >();

  const buildTurnKey = (toolName: string, primaryParam: string) =>
    primaryParam ? `${toolName}:${primaryParam}` : toolName;

  return async function beforeToolExecute({ name, params }) {
    const primary = params.path ?? params.pattern ?? params.cmd ?? params.url ?? params.query ?? '';
    const displayPrimary = name === 'run_command' && params.cmd
      ? `${params.cmd}${params.args ? ' ' + params.args : ''}`.trim()
      : primary;
    const risk = describePermissionRisk(name, params);

    // 0. Built-in security guard (opt-in, off by default) — first line of
    // defense against the model footgunning a catastrophic call, before the
    // project's own hooks. No-op unless `security.guard.enabled`.
    const guard = evaluateSecurityGuard({ name, params }, hookSettings.security?.guard, { workspaceRoot });
    if (!guard.allow) {
      const reason = `security guard blocked ${guard.reason ?? 'a dangerous call'}`;
      await turnLog?.append({
        type: 'permission-denied',
        name,
        primary: previewText(primary),
        displayPrimary: previewText(displayPrimary),
        source: 'security-guard',
        reason: previewText(reason)
      });
      return { allow: false, reason };
    }

    // 1. Shell hooks — project-authored guardrails.
    const hookResults = await runHooks('PreToolUse', hookSettings, { toolName: name, primary }, workspaceRoot);
    const blocker = hookResults.find(r => r.exitCode !== 0);
    if (blocker) {
      const reason = (blocker.stderr.trim() || blocker.stdout.trim()) || `PreToolUse hook exited ${blocker.exitCode}`;
      await turnLog?.append({
        type: 'permission-denied',
        name,
        primary: previewText(primary),
        displayPrimary: previewText(displayPrimary),
        source: 'hook',
        reason: previewText(reason)
      });
      return { allow: false, reason };
    }

    // 2. Permission policy — merged workspace config + session grants.
    const merged = mergePolicies(
      {
        allow: hookSettings.permissions?.allow ?? [],
        deny: hookSettings.permissions?.deny ?? [],
        ask: hookSettings.permissions?.ask ?? []
      },
      permissionStore.toPolicy()
    );
    // Same primaryFull mechanic as the CLI gate so workspace patterns
    // like `run_command:git *` apply identically to extension and
    // terminal hosts.
    const primaryFull = name === 'run_command' && params.cmd
      ? `${params.cmd}${params.args ? ' ' + params.args : ''}`.trim()
      : undefined;
    const decision = evaluatePermission(name, primary, merged, primaryFull);
    if (decision === 'deny') {
      await turnLog?.append({
        type: 'permission-denied',
        name,
        primary: previewText(primary),
        displayPrimary: previewText(displayPrimary),
        source: 'policy',
        reason: `denied by permission policy (${name}${primary ? `:${primary}` : ''})`
      });
      return { allow: false, reason: `denied by permission policy (${name}${primary ? `:${primary}` : ''})` };
    }
    if (decision === 'ask') {
      // Turn-local auto-grant: if the user already approved this exact
      // (tool, primary) within the current turn, skip the card so
      // parallel multi-region edits to one file don't stack duplicate
      // prompts.
      const turnKey = buildTurnKey(name, primary);
      if (turnApprovedKeys.has(turnKey)) {
        state.toolStartedAt.set(name, Date.now());
        return { allow: true };
      }
      // Edit-automatically toggle: bypass the card for file edits when
      // the user has opted in. run_command is never bypassed — shell
      // commands always require an explicit choice. Fetched fresh
      // every call so flipping the toggle mid-run takes effect on the
      // next tool use without restarting the loop.
      const autoApproveEdits = vscode.workspace
        .getConfiguration('banditStealth')
        .get<boolean>('agent.autoApproveEdits', false) ?? false;
      if (autoApproveEdits && (name === 'write_file' || name === 'apply_edit' || name === 'replace_range' || name === 'apply_patch')) {
        await turnLog?.append({
          type: 'permission-decision',
          name,
          primary: previewText(primary),
          displayPrimary: previewText(displayPrimary),
          choice: 'auto-approved',
          source: 'extension-setting'
        });
        state.toolStartedAt.set(name, Date.now());
        return { allow: true };
      }
      const { description, bodyPreview, warning, diffStats, command, paramsPreview } =
        buildPermissionAskPreview(name, params, workspaceRoot, userGoal);

      // Share an inflight card with any sibling call that hit this
      // gate at the same time for the same (tool, primary). First
      // caller creates the promise, the rest await it.
      let permissionPromise = inflightPermissions.get(turnKey);
      if (!permissionPromise) {
        await turnLog?.append({
          type: 'permission-request',
          name,
          primary: previewText(primary),
          displayPrimary: previewText(displayPrimary),
          risk
        });
        notifyUser('approval', 'Bandit needs approval', `${name}${primary ? ` ${primary}` : ''}`);
        permissionPromise = permissionGate.request({
          tool: name,
          primary,
          description,
          risk,
          bodyPreview,
          warning,
          diffStats,
          command,
          paramsPreview,
          assistantEntry
        });
        inflightPermissions.set(turnKey, permissionPromise);
        void permissionPromise.finally(() => inflightPermissions.delete(turnKey));
      }
      const picked = await permissionPromise;
      if (picked.choice === 'once') {
        // Remember for the remainder of this turn only — covers the
        // common case where the model emits two apply_edits to the
        // same file in one iteration.
        turnApprovedKeys.add(turnKey);
        await turnLog?.append({
          type: 'permission-decision',
          name,
          primary: previewText(primary),
          displayPrimary: previewText(displayPrimary),
          choice: 'once'
        });
      } else if (picked.choice === 'session') {
        permissionStore.grant(name);
        turnApprovedKeys.add(turnKey);
        await turnLog?.append({
          type: 'permission-decision',
          name,
          primary: previewText(primary),
          displayPrimary: previewText(displayPrimary),
          choice: 'session'
        });
      } else if (picked.choice === 'save') {
        permissionStore.grant(name, primary);
        turnApprovedKeys.add(turnKey);
        const entry = primary ? `${name}:${primary}` : name;
        void persistAllowEntry(workspaceRoot, entry).catch(() => undefined);
        await turnLog?.append({
          type: 'permission-decision',
          name,
          primary: previewText(primary),
          displayPrimary: previewText(displayPrimary),
          choice: 'save'
        });
      } else {
        // 'deny' — abort. When the user supplied follow-up notes,
        // surface them in the denial reason so the model can read the
        // correction on its next turn and adjust rather than just
        // seeing "blocked."
        const target = primary ? `${name} ${primary}` : name;
        const reason = picked.notes
          ? `User denied \`${target}\` and asked you to revise your approach: "${picked.notes}". Do not retry this tool call with the same arguments — adjust your plan based on the user's guidance.`
          : `User denied \`${target}\`. Do not retry this tool call with the same arguments.`;
        await turnLog?.append({
          type: 'permission-denied',
          name,
          primary: previewText(primary),
          displayPrimary: previewText(displayPrimary),
          source: 'user',
          reason: previewText(reason),
          notes: picked.notes ? previewText(picked.notes) : undefined
        });
        return { allow: false, reason };
      }
    }

    state.toolStartedAt.set(name, Date.now());
    return { allow: true };
  };
}

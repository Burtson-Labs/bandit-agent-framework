/**
 * Permission mode — how much Bandit is allowed to do without stopping to ask.
 *
 *   ask        (default) Every non-allowlisted call prompts. Today's behavior.
 *   auto       `routine` calls run unprompted; `elevated` and `critical` still
 *              prompt. This is the mode meant for "let it work while I watch."
 *   dangerous  Everything runs unprompted. For CI and sandboxes.
 *
 * The floor: **`critical` never auto-approves in `auto` mode.** Deletes,
 * writes outside the workspace, force-push, global installs, credential paths
 * and egress always require an explicit answer. That is the whole reason `auto`
 * is a different mode from `dangerous` rather than a softer setting on the same
 * dial — a mode whose exceptions are configurable is a bypass with extra steps.
 *
 * `dangerous` has no floor, by design and by name. If someone needs an
 * unattended full-access run, they should have to type a word that tells them
 * what they are doing; the failure mode we are avoiding is a user reaching for
 * "auto" in a blog post and getting "no confirmation for anything."
 */
import type { RiskAssessment, RiskTier } from './riskTiers';

export type PermissionMode = 'ask' | 'auto' | 'dangerous';

export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto', 'dangerous'] as const;

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

export interface ResolveModeInput {
  /** `permissions.mode` from .bandit/settings.json. */
  settingsMode?: string;
  /** Runtime override — a `--auto` flag or a `/auto` toggle. Wins over config. */
  override?: PermissionMode;
  /** Process env. Injectable for tests. */
  env?: Record<string, string | undefined>;
}

export interface ResolvedMode {
  mode: PermissionMode;
  /** Where the mode came from, for the status line and `/permissions`. */
  source: 'override' | 'env' | 'settings' | 'default';
  /** Set when a deprecated input was used; hosts print this once at startup. */
  deprecation?: string;
}

/**
 * Resolve the effective mode. Precedence: runtime override > env > settings >
 * default.
 *
 * `BANDIT_AUTO_APPROVE=1` predates this module and meant "skip the permission
 * policy entirely" — a full bypass. It keeps that meaning and maps to
 * `dangerous`, with a deprecation notice. Quietly re-pointing it at `auto`
 * would have been the friendlier-looking choice and the wrong one: every
 * existing CI job using it would start prompting for `elevated` calls, and a
 * non-interactive prompt denies, so pipelines would fail in a way that looks
 * like a Bandit bug rather than a config change.
 */
export function resolvePermissionMode(input: ResolveModeInput = {}): ResolvedMode {
  const env = input.env ?? process.env;

  if (input.override) {
    return { mode: input.override, source: 'override' };
  }

  const explicit = env.BANDIT_PERMISSION_MODE?.trim().toLowerCase();
  if (explicit) {
    if (isPermissionMode(explicit)) {
      return { mode: explicit, source: 'env' };
    }
    return {
      mode: 'ask',
      source: 'default',
      deprecation: `BANDIT_PERMISSION_MODE="${explicit}" is not a valid mode (expected: ${PERMISSION_MODES.join(', ')}). Falling back to "ask".`
    };
  }

  if (/^(1|true)$/i.test(env.BANDIT_DANGEROUSLY_APPROVE_ALL ?? '')) {
    return { mode: 'dangerous', source: 'env' };
  }

  if (/^(1|true)$/i.test(env.BANDIT_AUTO_APPROVE ?? '')) {
    return {
      mode: 'dangerous',
      source: 'env',
      deprecation:
        'BANDIT_AUTO_APPROVE is deprecated and still means "approve everything". '
        + 'Use BANDIT_DANGEROUSLY_APPROVE_ALL=1 for that, or BANDIT_PERMISSION_MODE=auto '
        + 'for the new auto mode, which keeps prompting for destructive calls.'
    };
  }

  if (input.settingsMode) {
    const fromSettings = input.settingsMode.trim().toLowerCase();
    if (isPermissionMode(fromSettings)) {
      return { mode: fromSettings, source: 'settings' };
    }
    return {
      mode: 'ask',
      source: 'default',
      deprecation: `permissions.mode="${input.settingsMode}" in .bandit/settings.json is not a valid mode (expected: ${PERMISSION_MODES.join(', ')}). Falling back to "ask".`
    };
  }

  return { mode: 'ask', source: 'default' };
}

export interface AutoDecision {
  /** True when the mode lets this call run without prompting. */
  autoApprove: boolean;
  /** Why, for the ledger and the transcript line. */
  reason: string;
}

/**
 * Should this call skip the prompt under the given mode?
 *
 * Callers must still run the security guard and PreToolUse hooks first — this
 * function answers only "does the mode waive the user prompt", never "is this
 * call safe."
 */
export function shouldAutoApprove(mode: PermissionMode, risk: RiskAssessment): AutoDecision {
  if (mode === 'dangerous') {
    return { autoApprove: true, reason: 'permission mode is "dangerous" (all prompts disabled)' };
  }
  if (mode !== 'auto') {
    return { autoApprove: false, reason: 'permission mode is "ask"' };
  }
  if (risk.tier === 'routine') {
    return { autoApprove: true, reason: `auto mode: routine call (${risk.rule})` };
  }
  return {
    autoApprove: false,
    reason: risk.tier === 'critical'
      ? `auto mode always asks before destructive calls (${risk.rule})`
      : `auto mode asks before non-routine calls (${risk.rule})`
  };
}

export interface PermissionDecisionInput {
  mode: PermissionMode;
  risk: RiskAssessment;
  /** What the allow/deny/ask policy said, before mode and tier are applied. */
  policyDecision: 'allow' | 'ask' | 'deny';
}

export interface PermissionOutcome {
  action: 'allow' | 'ask' | 'deny';
  /** Why — surfaced in the transcript, the turn log, and the ledger. */
  reason: string;
  /** True when the critical floor overrode a policy that said `allow`. */
  flooredByRisk?: boolean;
}

/**
 * The single precedence chain both hosts use. Previously each host open-coded
 * this order and they had already drifted (the extension gained a turn-local
 * auto-grant the CLI never had, the CLI gained an env short-circuit the
 * extension never had). One function, one order, one set of tests:
 *
 *   1. `deny` from policy — nothing overrides an explicit deny.
 *   2. **The critical floor.** A `critical` call always asks, even when a
 *      stored rule says allow. This is what stops a saved grant from widening
 *      into destruction: approving `git push origin main` for the session
 *      stores `run_command:git push*`, which as a bare glob would also cover
 *      `git push --force`. It doesn't, because force-push classifies critical
 *      and lands here. Same protection covers a hand-written `run_command:git *`
 *      in settings.json, which had this hole before the floor existed.
 *   3. `dangerous` mode — no floor, by name and by design.
 *   4. `auto` mode — routine runs unattended.
 *   5. Otherwise the policy decides.
 *
 * The security guard and PreToolUse hooks run BEFORE this, in the host. This
 * function answers "does the user have to be asked", not "is this call safe".
 */
export function decidePermission(input: PermissionDecisionInput): PermissionOutcome {
  const { mode, risk, policyDecision } = input;

  if (policyDecision === 'deny') {
    return { action: 'deny', reason: 'denied by permission policy' };
  }

  if (mode === 'dangerous') {
    return { action: 'allow', reason: 'permission mode is "dangerous" (all prompts disabled)' };
  }

  if (risk.tier === 'critical') {
    return {
      action: 'ask',
      reason: `destructive or irreversible (${risk.rule}) — always requires explicit approval`,
      flooredByRisk: policyDecision === 'allow'
    };
  }

  if (mode === 'auto' && risk.tier === 'routine') {
    return { action: 'allow', reason: `auto mode: routine call (${risk.rule})` };
  }

  if (policyDecision === 'allow') {
    return { action: 'allow', reason: 'allowed by permission policy' };
  }

  return {
    action: 'ask',
    reason: mode === 'auto'
      ? `auto mode asks before non-routine calls (${risk.rule})`
      : `permission mode is "ask" (${risk.rule})`
  };
}

/** A single auto-approved call, for the session ledger. */
export interface AutoApprovalRecord {
  tool: string;
  target: string;
  tier: RiskTier;
  rule: string;
  at: number;
}

/**
 * In-memory record of what auto mode did this session.
 *
 * Auto-approval without a record is indistinguishable from a bypass — the user
 * has no way to answer "what did it do while I wasn't looking?". `/permissions`
 * renders this.
 */
export class AutoApprovalLedger {
  private readonly entries: AutoApprovalRecord[] = [];
  private readonly limit: number;

  constructor(limit = 500) {
    this.limit = limit;
  }

  record(entry: AutoApprovalRecord): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
  }

  all(): readonly AutoApprovalRecord[] {
    return this.entries;
  }

  size(): number {
    return this.entries.length;
  }

  /** Counts per tool, most-used first — the useful shape for a summary line. */
  summary(): Array<{ tool: string; count: number }> {
    const counts = new Map<string, number>();
    for (const e of this.entries) counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
    return [...counts.entries()]
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count);
  }

  clear(): void {
    this.entries.length = 0;
  }
}

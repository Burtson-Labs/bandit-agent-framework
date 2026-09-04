/**
 * The safety layer for remote control.
 *
 * A remote task drives the agent on the user's real machine with nobody at the
 * keyboard, so it CANNOT fall back to a permission card the way the interactive
 * CLI does. This gate turns the shared host-kit permission boundary
 * (`decidePermission`) into a `beforeToolExecute` guard the tool-use loop
 * enforces:
 *
 *   - `plan` (the default): read-only calls run; every edit / write / mutating
 *     command / delete / network-write is refused. The agent produces a plan.
 *   - `auto`: routine calls run; destructive calls are refused (there's no
 *     human to approve the critical floor, so it becomes a hard block here).
 *   - an `ask` outcome can't be answered remotely, so it's refused with a
 *     reason the model can act on. (Routing approvals back to the web is a
 *     later phase — that's what the gateway's proposed-changes/apply gate is
 *     for.)
 *
 * Refusing is deliberately informative: the model sees WHY and re-plans, which
 * is exactly the "present a plan instead of acting" behavior remote control
 * wants. The classification lives in ONE place (host-kit), shared with the CLI
 * and extension, so remote control can't drift from local enforcement.
 */
import { classifyRisk, decidePermission } from '@burtson-labs/host-kit';
import type { RemoteRunMode } from '@burtson-labs/host-kit';

export type BeforeToolExecute = (call: { name: string; params: Record<string, string> }) =>
  { allow: boolean; reason?: string };

/** Build a `beforeToolExecute` gate that enforces `mode` for a remote task. */
export function createPlanModeGate(mode: RemoteRunMode, workspaceRoot: string): BeforeToolExecute {
  return (call) => {
    const risk = classifyRisk(call, { workspaceRoot });
    // No stored allowlist on a remote runner (Phase 1): policy is neutral, so
    // the mode + risk tier alone decide. `plan` allows only read-only; `auto`
    // allows routine; both floor destructive calls.
    const outcome = decidePermission({ mode, risk, policyDecision: 'ask' });

    if (outcome.action === 'allow') {
      return { allow: true };
    }
    if (outcome.action === 'deny') {
      return { allow: false, reason: outcome.reason };
    }
    // action === 'ask' — nobody is at this machine to answer.
    return {
      allow: false,
      reason:
        `"${call.name}" needs approval, but this is a remote runner with nobody at the keyboard `
        + `(${mode} mode). Do not attempt it — describe what you would change instead so the user `
        + `can review and approve it. (${outcome.reason})`
    };
  };
}

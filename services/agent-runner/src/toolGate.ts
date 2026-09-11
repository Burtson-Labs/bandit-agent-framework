/**
 * Server-side permission gate for cloud turns (SEC-005) — the runner's
 * equivalent of the CLI/IDE approval floor, built from the SAME host-kit
 * primitives (`evaluateSecurityGuard`, `classifyRisk`) so policy never
 * forks between hosts. There is no human to prompt here, so every decision
 * is allow/deny: a denial becomes the tool result and the model replans.
 *
 * Modes (`AGENT_RUNNER_PERMISSION_MODE`):
 *
 *  - `standard` (default) — deny the `critical` risk tier (destructive
 *    commands, outside-workspace writes, credential paths, egress, …);
 *    allow `routine` and `elevated`, i.e. read/write within the workspace.
 *  - `read-only`   — only calls host-kit positively vouches for as
 *    read-only pass (plan-mode ceiling).
 *  - `unrestricted` — tier checks off. Only for fully isolated sandboxes.
 *
 * In every mode — including `unrestricted` — host-kit's security guard
 * runs first as a hard floor: catastrophic `rm`, curl-pipe-shell,
 * credential exfil, and writes to the agent's own permission config are
 * never allowed.
 */
import { classifyRisk, evaluateSecurityGuard } from '@burtson-labs/host-kit';

export type PermissionMode = 'standard' | 'read-only' | 'unrestricted';

export function parsePermissionMode(raw: string | undefined): PermissionMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'standard') return 'standard';
  if (v === 'read-only' || v === 'unrestricted') return v;
  throw new Error(
    `invalid AGENT_RUNNER_PERMISSION_MODE '${raw}' — expected standard | read-only | unrestricted`,
  );
}

export interface GateDecision {
  allow: boolean;
  reason?: string;
}

export type ToolGate = (call: { name: string; params: Record<string, string> }) => GateDecision;

export function buildToolGate(mode: PermissionMode, workspaceRoot: string): ToolGate {
  const ctx = { workspaceRoot };
  return (call) => {
    const guard = evaluateSecurityGuard(call, { enabled: true }, ctx);
    if (!guard.allow) {
      return { allow: false, reason: `blocked by security guard (${guard.rule}): ${guard.reason}` };
    }
    if (mode === 'unrestricted') return { allow: true };

    const risk = classifyRisk(call, ctx);
    if (mode === 'read-only') {
      return risk.readOnly === true
        ? { allow: true }
        : {
            allow: false,
            reason: `permission mode 'read-only' blocks this call (${risk.rule}): ${risk.why}`,
          };
    }
    if (risk.tier === 'critical') {
      return { allow: false, reason: `denied by runner policy (${risk.rule}): ${risk.why}` };
    }
    return { allow: true };
  };
}

/**
 * Phase 6 — per-node capability envelopes.
 *
 * An envelope narrows what a NODE may do, independent of what the host's
 * global permission model allows. The two compose, and the layering is
 * deliberate:
 *
 *  - agent-core (here) provides the MECHANISM: a declarative, serializable
 *    envelope (tool-name allow/deny) evaluated as a beforeToolExecute-style
 *    gate, plus gate composition. No policy knowledge — this package doesn't
 *    know what "plan mode" or "risk tier" means.
 *  - hosts provide the POLICY: the CLI/extension inject their host-kit
 *    permission gate (mode + risk classification) per node via loop options;
 *    `composeGates` runs envelope first, host gate second, first deny wins.
 *
 * So "verification nodes run read-only" is spelled: give the verify node an
 * envelope allowing only read tools — enforced in-core — while the host's own
 * plan/auto gate still applies on top. A node can only ever be NARROWER than
 * the host allows, never wider: an envelope has no allow-override power, it
 * can only deny.
 */
import type { NodeEnvelope } from './types';

/** Same shape the tool loop's beforeToolExecute uses — kept structural so the
 *  graph module doesn't import loop types it doesn't need. */
export type ToolGate = (call: { name: string; params: Record<string, string> }) =>
  | Promise<{ allow: boolean; reason?: string }>
  | { allow: boolean; reason?: string };

/**
 * Build a gate from a declarative envelope.
 *  - `denyTools` always blocks its entries (deny wins over allow).
 *  - `allowTools`, when present, blocks everything NOT listed.
 *  - No envelope / empty envelope = allow everything (the host gate still runs).
 */
export function envelopeGate(envelope: NodeEnvelope | undefined): ToolGate {
  const deny = new Set(envelope?.denyTools ?? []);
  const allow = envelope?.allowTools ? new Set(envelope.allowTools) : null;
  return (call) => {
    if (deny.has(call.name)) {
      return {
        allow: false,
        reason: `node envelope denies "${call.name}" — this node may not use that tool; work within its declared capabilities or report what you would have done.`
      };
    }
    if (allow && !allow.has(call.name)) {
      return {
        allow: false,
        reason: `node envelope allows only [${[...allow].join(', ')}] — "${call.name}" is outside this node's capabilities; use the allowed tools or report what you would have done.`
      };
    }
    return { allow: true };
  };
}

/**
 * Compose gates left → right: the first deny wins (its reason surfaces), a
 * call must pass every gate to run. Undefined entries are skipped so callers
 * can pass optional host gates without branching.
 */
export function composeGates(...gates: Array<ToolGate | undefined>): ToolGate {
  const active = gates.filter((g): g is ToolGate => typeof g === 'function');
  return async (call) => {
    for (const gate of active) {
      const verdict = await gate(call);
      if (!verdict.allow) return verdict;
    }
    return { allow: true };
  };
}

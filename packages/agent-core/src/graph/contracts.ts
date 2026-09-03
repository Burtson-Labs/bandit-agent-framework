/**
 * Phase 3 — completion contracts, evidence, verification nodes.
 *
 * A node that "completed" without producing what it promised is the graph
 * version of the claim-without-doing problem the loop's detectors chase in
 * prose. Contracts make the promise EXPLICIT and machine-checkable:
 * an executor returns an outcome + evidence, the scheduler checks the node's
 * contract against them, and a violation IS a failure — dependents skip, the
 * run reports failed, nobody builds on unverified work.
 *
 * Contracts are deliberately DECLARATIVE (plain data, serializable):
 *  - a future planner (Phase 9) can propose them alongside a GraphSpec;
 *  - checkpoints (Phase 5) can persist them;
 *  - hosts can render "why is this node failed" without executing anything.
 * Anything needing custom logic belongs in a verification NODE — independent
 * work the scheduler runs like any other node — not in a contract lambda.
 */

import type {
  CompletionContract,
  EvidenceItem,
  GraphNodeSpec,
  NodeExecutor,
  NodeRunContext,
} from './types';

/**
 * Check a contract. Returns human-readable violations — empty array = pass.
 * Pure and total: bad regex sources become a violation, never a throw.
 */
export function checkContract(
  contract: CompletionContract | undefined,
  outcome: { output?: unknown; evidence?: EvidenceItem[] }
): string[] {
  if (!contract) return [];
  const violations: string[] = [];
  const text = typeof outcome.output === 'string'
    ? outcome.output
    : outcome.output === undefined
      ? ''
      : JSON.stringify(outcome.output);

  if (contract.outputNonEmpty && text.trim().length === 0) {
    violations.push('contract: output is empty');
  }
  if (contract.outputMatches) {
    try {
      const re = new RegExp(contract.outputMatches, 's');
      if (!re.test(text)) {
        violations.push(`contract: output does not match /${contract.outputMatches}/`);
      }
    } catch {
      violations.push(`contract: invalid outputMatches regex /${contract.outputMatches}/`);
    }
  }
  for (const req of contract.requireEvidence ?? []) {
    const min = Math.max(1, req.min ?? 1);
    const count = (outcome.evidence ?? []).filter((e) => e.kind === req.kind).length;
    if (count < min) {
      violations.push(`contract: needs ${min} evidence of kind "${req.kind}", got ${count}`);
    }
  }
  return violations;
}

// ── Verification nodes ───────────────────────────────────────────────────────

/** What a verifier decides about upstream work. */
export interface Verdict {
  pass: boolean;
  /** Required when pass=false — a verdict without reasons is unactionable. */
  reasons?: string[];
}

export type VerifierFn = (ctx: NodeRunContext) => Promise<Verdict> | Verdict;

/**
 * Build an INDEPENDENT verification node for `targetId`: it depends on the
 * target, runs the verifier against the target's result, and fails the graph
 * branch when the verdict is negative — so anything depending on the verify
 * node only runs over verified work. (Chain: work → verify → consume.)
 *
 * The verifier is ordinary node work — it can be a wrapped loop turn (a second
 * model reviewing the first's output) or plain code (run the tests, diff the
 * artifact). The scheduler treats it like any node; there is no special path.
 */
export function verificationNode(
  id: string,
  targetId: string,
  verifier: VerifierFn,
  spec?: Partial<Pick<GraphNodeSpec, 'label' | 'dependsOn'>>
): { node: GraphNodeSpec; executor: NodeExecutor } {
  const node: GraphNodeSpec = {
    id,
    label: spec?.label ?? `verify ${targetId}`,
    dependsOn: [...new Set([targetId, ...(spec?.dependsOn ?? [])])],
  };
  const executor: NodeExecutor = async (ctx) => {
    const verdict = await verifier(ctx);
    if (!verdict.pass) {
      const reasons = verdict.reasons?.length ? verdict.reasons.join('; ') : 'no reasons given';
      throw new Error(`verification failed for ${targetId}: ${reasons}`);
    }
    return {
      output: verdict,
      summary: `verified ${targetId}`,
      evidence: [{ kind: 'verification', detail: targetId, data: verdict }],
    };
  };
  return { node, executor };
}

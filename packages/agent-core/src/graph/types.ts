/**
 * Graph runtime — types. (Phase 1 of the graph plan.)
 *
 * A run is a DAG of nodes; each node's executor runs only after every node it
 * depends on has finished. The existing ToolUseLoop is NOT rewritten — a node
 * executor typically wraps one loop run (see loopNode.ts), so a graph is
 * "several of today's turns with explicit dependencies" rather than a new
 * agent architecture. Nothing in the framework consumes this module yet; hosts
 * opt in explicitly (that's the feature flag — zero behavior change until a
 * host wires it).
 *
 * Design rules:
 *  - The planner (model) may eventually PROPOSE a GraphSpec, but it never owns
 *    scheduling. The scheduler is deterministic host code.
 *  - Node states form a strict machine:
 *      pending → running → done | failed
 *      pending → skipped        (an upstream dependency failed or was skipped)
 *      pending → cancelled      (the run's signal aborted before it started)
 *    Terminal states never transition again.
 */

/** A structured claim about what a node actually did (Phase 3).
 *  e.g. { kind: 'file-changed', detail: 'src/x.ts' }. JSON-serializable. */
export interface EvidenceItem {
  kind: string;
  detail?: string;
  data?: unknown;
}

export interface EvidenceRequirement {
  kind: string;
  /** Minimum count of matching items. Default 1. */
  min?: number;
}

/** Declarative completion contract: what a node MUST produce to count as
 *  done. Checked by the scheduler after the executor resolves; violations are
 *  failures (dependents skip). Plain data on purpose — proposable by a future
 *  planner, persistable by future checkpoints. */
export interface CompletionContract {
  outputNonEmpty?: boolean;
  /** Regex source the (stringified) output must match (flags: 's'). */
  outputMatches?: string;
  requireEvidence?: EvidenceRequirement[];
}

/** One node in the DAG. */
export interface GraphNodeSpec {
  /** Unique id within the graph. */
  id: string;
  /** Ids of nodes that must complete (state 'done') before this one runs. */
  dependsOn?: string[];
  /** Human label for UIs; falls back to id. */
  label?: string;
  /** Completion contract enforced on this node's outcome. */
  contract?: CompletionContract;
}

export interface GraphSpec {
  nodes: GraphNodeSpec[];
}

export type NodeState = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';

/** What an executor returns on success. `output` is handed to downstream
 *  executors verbatim; `summary` is a short human line for UIs/events. */
export interface NodeOutcome {
  output?: unknown;
  summary?: string;
  /** Structured claims about what was actually done — checked against the
   *  node's contract and carried on the result for downstream/UIs. */
  evidence?: EvidenceItem[];
}

/** Terminal record for one node after a run. */
export interface NodeResult {
  id: string;
  state: NodeState;
  output?: unknown;
  summary?: string;
  evidence?: EvidenceItem[];
  /** Set when state === 'failed'. */
  error?: string;
  /** Set when the failure was a contract violation (state 'failed'). */
  contractViolations?: string[];
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

export type GraphRunStatus = 'completed' | 'failed' | 'cancelled';

export interface GraphRunResult {
  status: GraphRunStatus;
  /** Terminal result per node id — every node in the spec appears. */
  nodes: Record<string, NodeResult>;
  durationMs: number;
}

/** Context handed to a node's executor when it runs. */
export interface NodeRunContext {
  nodeId: string;
  /** Abort signal for the whole graph run — executors must respect it. */
  signal: AbortSignal;
  /** Terminal results of this node's direct dependencies (all state 'done'). */
  upstream: Record<string, NodeResult>;
}

export type NodeExecutor = (ctx: NodeRunContext) => Promise<NodeOutcome> | NodeOutcome;

export interface GraphValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Structural validation: duplicate ids, unknown/self dependencies, cycles.
 * Kahn's algorithm for cycle detection — if a topological pass can't consume
 * every node, whatever remains is (part of) a cycle and gets named in the
 * error so the author can see it.
 */
export function validateGraph(spec: GraphSpec): GraphValidation {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const node of spec.nodes) {
    if (!node.id || node.id.trim().length === 0) errors.push('node with empty id');
    else if (ids.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    else ids.add(node.id);
  }
  for (const node of spec.nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (dep === node.id) errors.push(`node ${node.id} depends on itself`);
      else if (!ids.has(dep)) errors.push(`node ${node.id} depends on unknown node: ${dep}`);
    }
  }
  if (errors.length === 0) {
    // Kahn: repeatedly remove nodes with no unconsumed deps.
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const node of spec.nodes) {
      indegree.set(node.id, (node.dependsOn ?? []).length);
      for (const dep of node.dependsOn ?? []) {
        const list = dependents.get(dep) ?? [];
        list.push(node.id);
        dependents.set(dep, list);
      }
    }
    const queue = spec.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
    let consumed = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      consumed += 1;
      for (const next of dependents.get(id) ?? []) {
        const left = (indegree.get(next) ?? 1) - 1;
        indegree.set(next, left);
        if (left === 0) queue.push(next);
      }
    }
    if (consumed !== spec.nodes.length) {
      const cyclic = spec.nodes.filter((n) => (indegree.get(n.id) ?? 0) > 0).map((n) => n.id);
      errors.push(`cycle detected involving: ${cyclic.join(', ')}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

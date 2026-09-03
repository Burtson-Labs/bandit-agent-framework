/**
 * Graph scheduler — deterministic host code that runs a validated DAG.
 * (Phase 4's conservative core, shipped with Phase 1 so the types are provably
 * runnable; budgets/checkpoints layer on later without changing this surface.)
 *
 * Semantics:
 *  - A node runs once ALL of its dependencies are 'done'.
 *  - `maxConcurrency` caps simultaneously-running nodes. Default 2 — the
 *    plan's "safe default concurrency": enough to prove parallel lift, small
 *    enough that filesystem/tool contention stays rare. Callers raise it
 *    deliberately.
 *  - Failure is contained, not contagious across branches: when a node fails,
 *    its transitive dependents are 'skipped'; independent branches keep
 *    running to completion. Overall status is then 'failed'.
 *  - Cancellation (opts.signal) stops launching new nodes; already-running
 *    executors receive the same signal and are awaited; never-started nodes
 *    end 'cancelled'. Overall status 'cancelled' (a cancelled run never
 *    reports 'failed' — the user stopped it, it didn't break).
 *  - Events mirror the tool loop's (type, payload) convention so hosts fold
 *    graph progress into the SAME stream that already carries tool_loop:*
 *    (Phase 7): graph:start, graph:node_start, graph:node_done,
 *    graph:node_failed, graph:node_skipped, graph:node_cancelled, graph:done.
 */
import {
  validateGraph,
  type GraphRunResult,
  type GraphSpec,
  type NodeExecutor,
  type NodeResult,
} from './types';
import { checkContract } from './contracts';

export interface RunGraphOptions {
  /** Cap on simultaneously running nodes. Default 2 (conservative). */
  maxConcurrency?: number;
  /** Abort the whole run. */
  signal?: AbortSignal;
  /** Progress events — same shape as the tool loop's emitEvent. */
  emitEvent?: (type: string, payload?: unknown) => void;
}

/** Executors per node id, or one executor shared by every node. */
export type GraphExecutors = NodeExecutor | Record<string, NodeExecutor>;

export async function runGraph(
  spec: GraphSpec,
  executors: GraphExecutors,
  opts: RunGraphOptions = {}
): Promise<GraphRunResult> {
  const startedAt = Date.now();
  const validation = validateGraph(spec);
  if (!validation.ok) {
    throw new Error(`invalid graph: ${validation.errors.join('; ')}`);
  }
  const maxConcurrency = Math.max(1, opts.maxConcurrency ?? 2);
  const emit = opts.emitEvent ?? (() => undefined);
  const signal = opts.signal;

  const executorFor = (id: string): NodeExecutor => {
    if (typeof executors === 'function') return executors;
    const fn = executors[id];
    if (!fn) throw new Error(`no executor for node: ${id}`);
    return fn;
  };
  // Resolve every executor up front so a missing one fails the run BEFORE any
  // node starts, not halfway through.
  for (const node of spec.nodes) executorFor(node.id);

  const results: Record<string, NodeResult> = {};
  for (const node of spec.nodes) {
    results[node.id] = { id: node.id, state: 'pending' };
  }
  const dependents = new Map<string, string[]>();
  for (const node of spec.nodes) {
    for (const dep of node.dependsOn ?? []) {
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }
  const deps = new Map<string, string[]>(spec.nodes.map((n) => [n.id, n.dependsOn ?? []]));
  const labelOf = new Map<string, string>(spec.nodes.map((n) => [n.id, n.label ?? n.id]));
  const specOf = new Map(spec.nodes.map((n) => [n.id, n]));

  const running = new Map<string, Promise<void>>();
  let anyFailed = false;

  const readyToRun = (id: string): boolean =>
    results[id].state === 'pending' &&
    (deps.get(id) ?? []).every((d) => results[d].state === 'done');

  /** A dependency failed or was skipped/cancelled → this node can never run. */
  const blocked = (id: string): boolean =>
    results[id].state === 'pending' &&
    (deps.get(id) ?? []).some((d) => {
      const s = results[d].state;
      return s === 'failed' || s === 'skipped' || s === 'cancelled';
    });

  const markSkippedCascade = (): void => {
    // Iterate to a fixed point: skipping a node can block its own dependents.
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of spec.nodes) {
        if (blocked(node.id)) {
          results[node.id] = { ...results[node.id], state: 'skipped' };
          emit('graph:node_skipped', { id: node.id, label: labelOf.get(node.id) });
          changed = true;
        }
      }
    }
  };

  const launch = (id: string): void => {
    const record = results[id];
    record.state = 'running';
    record.startedAt = Date.now();
    emit('graph:node_start', { id, label: labelOf.get(id) });
    const upstream: Record<string, NodeResult> = {};
    for (const d of deps.get(id) ?? []) upstream[d] = results[d];

    const promise = (async () => {
      try {
        const outcome = await executorFor(id)({
          nodeId: id,
          signal: signal ?? new AbortController().signal,
          upstream,
        });
        // Phase 3: the node only counts as done if its completion contract
        // holds. A violation is a FAILURE — "finished but produced nothing it
        // promised" must not feed downstream nodes.
        const violations = checkContract(specOf.get(id)?.contract, outcome ?? {});
        record.output = outcome?.output;
        record.summary = outcome?.summary;
        record.evidence = outcome?.evidence;
        if (violations.length > 0) {
          record.state = 'failed';
          record.error = violations.join('; ');
          record.contractViolations = violations;
          anyFailed = true;
          emit('graph:node_contract_violation', { id, label: labelOf.get(id), violations });
          emit('graph:node_failed', { id, label: labelOf.get(id), error: record.error });
        } else {
          record.state = 'done';
          emit('graph:node_done', { id, label: labelOf.get(id), summary: record.summary });
        }
      } catch (err) {
        record.state = 'failed';
        record.error = err instanceof Error ? err.message : String(err);
        anyFailed = true;
        emit('graph:node_failed', { id, label: labelOf.get(id), error: record.error });
      } finally {
        record.endedAt = Date.now();
        record.durationMs = record.endedAt - (record.startedAt ?? record.endedAt);
        running.delete(id);
      }
    })();
    running.set(id, promise);
  };

  emit('graph:start', { nodes: spec.nodes.length, maxConcurrency });

  // Main pump: launch every ready node up to the cap, wait for one running
  // node to settle, repeat. Skip-cascade runs each pass so a failure releases
  // its blocked subtree immediately (as 'skipped', not stuck 'pending').
  for (;;) {
    markSkippedCascade();
    if (!signal?.aborted) {
      for (const node of spec.nodes) {
        if (running.size >= maxConcurrency) break;
        if (readyToRun(node.id)) launch(node.id);
      }
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }

  // Anything still pending at the end: cancelled (signal aborted before it
  // could start) — by construction nothing else can remain pending.
  for (const node of spec.nodes) {
    if (results[node.id].state === 'pending') {
      results[node.id] = { ...results[node.id], state: 'cancelled' };
      emit('graph:node_cancelled', { id: node.id, label: labelOf.get(node.id) });
    }
  }

  const status: GraphRunResult['status'] = signal?.aborted
    ? 'cancelled'
    : anyFailed
      ? 'failed'
      : 'completed';
  const result: GraphRunResult = {
    status,
    nodes: results,
    durationMs: Date.now() - startedAt,
  };
  emit('graph:done', {
    status,
    durationMs: result.durationMs,
    done: Object.values(results).filter((r) => r.state === 'done').length,
    failed: Object.values(results).filter((r) => r.state === 'failed').length,
    skipped: Object.values(results).filter((r) => r.state === 'skipped').length,
  });
  return result;
}

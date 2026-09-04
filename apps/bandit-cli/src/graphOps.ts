/**
 * `/graph` inspection surface (Phase 8) — pure functions over a GraphSpec +
 * persisted GraphCheckpoint. Everything here answers questions or rewrites
 * the checkpoint; nothing executes nodes (running/resuming stays on
 * `bandit graph demo [--resume]`, so the slash command remains instant and
 * side-effect-free apart from the explicit retry invalidation).
 *
 *   status        — the whole DAG at a glance (state, timing, summary)
 *   inspect NODE  — one node in depth (deps, evidence, contract, error, output)
 *   why NODE      — root-cause walk: which ancestor failure blocks this node
 *   retry NODE    — invalidate the node + its transitive dependents in the
 *                   checkpoint so the next --resume re-runs exactly that slice
 */
import {
  graphFingerprint,
  type GraphCheckpoint,
  type GraphSpec,
  type NodeResult,
  type NodeState,
} from '@burtson-labs/agent-core';
import { c, glyph } from './ansi';

export interface GraphView {
  spec: GraphSpec;
  checkpoint: GraphCheckpoint;
}

/** Parse + validate a checkpoint against the spec it claims to snapshot. */
export function parseCheckpoint(spec: GraphSpec, raw: string): { ok: true; view: GraphView } | { ok: false; error: string } {
  let checkpoint: GraphCheckpoint;
  try {
    checkpoint = JSON.parse(raw) as GraphCheckpoint;
  } catch {
    return { ok: false, error: 'checkpoint file is not valid JSON' };
  }
  if (!checkpoint || checkpoint.version !== 1 || typeof checkpoint.specFingerprint !== 'string') {
    return { ok: false, error: 'checkpoint file is not a graph checkpoint' };
  }
  if (checkpoint.specFingerprint !== graphFingerprint(spec)) {
    return { ok: false, error: 'checkpoint belongs to a different graph shape (node ids/deps changed since it was written)' };
  }
  return { ok: true, view: { spec, checkpoint } };
}

function stateGlyph(state: NodeState | undefined): string {
  switch (state) {
    case 'done': return c.green(glyph.check);
    case 'failed': return c.red(glyph.cross);
    case 'running': return c.accent('▶');
    case 'skipped': return c.dim('↷');
    case 'cancelled': return c.dim('■');
    default: return c.dim('·');
  }
}

function resultOf(view: GraphView, id: string): NodeResult | undefined {
  return view.checkpoint.nodes[id];
}

/** The whole DAG at a glance. */
export function renderStatus(view: GraphView): string {
  const lines: string[] = [c.bold('Graph status') + c.dim(' — last demo run')];
  for (const node of view.spec.nodes) {
    const r = resultOf(view, node.id);
    const deps = (node.dependsOn ?? []).length > 0 ? c.dim(` ← ${(node.dependsOn ?? []).join(', ')}`) : '';
    const dur = r?.durationMs !== undefined ? c.dim(` · ${(r.durationMs / 1000).toFixed(1)}s`) : '';
    const summary = r?.summary ? c.dim(` — ${r.summary.split('\n')[0].slice(0, 60)}`) : '';
    lines.push(`  ${stateGlyph(r?.state)} ${c.cyan(node.id)}${deps}${dur}${summary}`);
  }
  const states = view.spec.nodes.map((n) => resultOf(view, n.id)?.state);
  const done = states.filter((s) => s === 'done').length;
  lines.push(c.dim(`  ${done}/${view.spec.nodes.length} done · /graph inspect <node> · /graph why <node> · /graph retry <node>`));
  return lines.join('\n');
}

/** One node in depth. */
export function renderInspect(view: GraphView, nodeId: string): string {
  const node = view.spec.nodes.find((n) => n.id === nodeId);
  if (!node) return c.red(`No node "${nodeId}". Nodes: ${view.spec.nodes.map((n) => n.id).join(', ')}`);
  const r = resultOf(view, nodeId);
  const lines: string[] = [
    c.bold(node.label ?? node.id) + c.dim(` (${node.id})`),
    `  state: ${stateGlyph(r?.state)} ${r?.state ?? 'pending'}`,
  ];
  if (node.dependsOn?.length) lines.push(`  depends on: ${node.dependsOn.join(', ')}`);
  if (node.envelope?.allowTools) lines.push(c.dim(`  envelope: allow [${node.envelope.allowTools.join(', ')}]`));
  if (node.envelope?.denyTools) lines.push(c.dim(`  envelope: deny [${node.envelope.denyTools.join(', ')}]`));
  if (node.contract) lines.push(c.dim(`  contract: ${JSON.stringify(node.contract)}`));
  if (r?.durationMs !== undefined) lines.push(`  duration: ${(r.durationMs / 1000).toFixed(1)}s`);
  for (const e of r?.evidence ?? []) {
    lines.push(`  evidence: ${e.kind}${e.detail ? ` — ${e.detail}` : ''}`);
  }
  if (r?.contractViolations?.length) {
    lines.push(c.red(`  contract violations: ${r.contractViolations.join('; ')}`));
  }
  if (r?.error) lines.push(c.red(`  error: ${r.error}`));
  if (typeof r?.output === 'string' && r.output.trim()) {
    const preview = r.output.length > 500 ? r.output.slice(0, 500) + '…' : r.output;
    lines.push(c.dim('  output:'), ...preview.split('\n').map((l) => '    ' + l));
  }
  return lines.join('\n');
}

/** Root-cause walk: WHY is this node not done? Names the deepest failed
 *  ancestor (with its error/violations) or the immediate unmet dependency. */
export function explainWhy(view: GraphView, nodeId: string): string {
  const node = view.spec.nodes.find((n) => n.id === nodeId);
  if (!node) return c.red(`No node "${nodeId}". Nodes: ${view.spec.nodes.map((n) => n.id).join(', ')}`);
  const r = resultOf(view, nodeId);
  if (r?.state === 'done') return `${c.green(glyph.check)} ${nodeId} is done — nothing is blocking it.`;
  if (r?.state === 'running') return `${c.accent('▶')} ${nodeId} is currently running.`;
  if (r?.state === 'failed') {
    return r.contractViolations?.length
      ? `${c.red(glyph.cross)} ${nodeId} failed its completion contract: ${r.contractViolations.join('; ')}`
      : `${c.red(glyph.cross)} ${nodeId} failed: ${r.error ?? 'unknown error'}`;
  }
  // pending / skipped / cancelled — walk up to the root cause.
  const byId = new Map(view.spec.nodes.map((n) => [n.id, n]));
  const chain: string[] = [];
  const visit = (id: string): string | null => {
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const depResult = resultOf(view, dep);
      if (depResult?.state === 'failed') {
        chain.push(dep);
        return `${dep} failed: ${depResult.contractViolations?.length ? depResult.contractViolations.join('; ') : depResult.error ?? 'unknown error'}`;
      }
      if (depResult?.state !== 'done') {
        chain.push(dep);
        const deeper = visit(dep);
        if (deeper) return deeper;
        return `${dep} has not completed (state: ${depResult?.state ?? 'pending'})`;
      }
    }
    return null;
  };
  const cause = visit(nodeId);
  if (!cause) return `${c.dim('·')} ${nodeId} is ${r?.state ?? 'pending'} with all dependencies met — it will run on the next resume.`;
  const path = [nodeId, ...chain].join(' ← ');
  return `${c.dim('↷')} ${nodeId} is blocked.\n  chain: ${path}\n  root cause: ${c.red(cause)}\n  fix and re-run: ${c.cyan('BANDIT_GRAPH=1 bandit graph demo --resume')}`;
}

/**
 * Invalidate a node + its TRANSITIVE dependents in the checkpoint so the next
 * resume re-runs exactly that slice (a retried node's dependents consumed its
 * old output — they must re-run too). Returns the invalidated ids.
 */
export function invalidateForRetry(view: GraphView, nodeId: string): { checkpoint: GraphCheckpoint; invalidated: string[] } | { error: string } {
  if (!view.spec.nodes.some((n) => n.id === nodeId)) {
    return { error: `No node "${nodeId}". Nodes: ${view.spec.nodes.map((n) => n.id).join(', ')}` };
  }
  const dependents = new Map<string, string[]>();
  for (const node of view.spec.nodes) {
    for (const dep of node.dependsOn ?? []) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), node.id]);
    }
  }
  const invalidated = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (invalidated.has(id)) continue;
    invalidated.add(id);
    queue.push(...(dependents.get(id) ?? []));
  }
  const nodes = Object.fromEntries(
    Object.entries(view.checkpoint.nodes).filter(([id]) => !invalidated.has(id))
  );
  return {
    checkpoint: { ...view.checkpoint, nodes },
    invalidated: [...invalidated],
  };
}

/**
 * Phase 9 — the planner: let the MODEL propose a graph; the HOST owns
 * everything that runs.
 *
 * Hard boundary, per the plan ("the planner never owns the scheduler"):
 * a proposal is pure DATA — ids, dependencies, per-node prompts, and a
 * read-only hint. The model cannot name tools, pick executors, set
 * concurrency, or touch scheduling. The host validates the proposal
 * (structure, caps, DAG-ness), maps hints to envelopes it controls, builds
 * the executors itself, and runs the graph with ITS options. A malicious or
 * confused proposal can therefore only produce a smaller/different DAG of
 * host-controlled work — never wider capabilities.
 *
 * Classification contract: the model first decides HOW a task should run —
 *   direct  one answer, no tools needed beyond a single turn
 *   loop    one focused multi-step turn (today's tool loop)
 *   graph   ≥2 separable chunks that benefit from explicit deps/parallelism
 * "graph always wins" is exactly the assumption Phase 10's bench exists to
 * test, so `direct`/`loop` are first-class outcomes, not failures.
 */
import { validateGraph, type GraphNodeSpec, type GraphSpec, type NodeEnvelope, type NodeExecutor } from './types';

export type ExecutionKind = 'direct' | 'loop' | 'graph';

/** One node as the model proposes it. Deliberately narrow: no tool names, no
 *  envelopes, no scheduler knobs — just work description + shape. */
export interface ProposalNode {
  id: string;
  /** Self-contained instruction for this node's turn. */
  prompt: string;
  label?: string;
  dependsOn?: string[];
  /** Hint that this node only reads/inspects. The HOST decides what envelope
   *  that maps to; in v1 hosts run ALL planned nodes read-only regardless. */
  readOnly?: boolean;
}

export interface GraphProposal {
  kind: ExecutionKind;
  /** One sentence the UI can show for the classification. */
  reason?: string;
  /** Present iff kind === 'graph'. */
  nodes?: ProposalNode[];
}

export interface PlannerLimits {
  /** Cap on proposed nodes. Default 6 — enough to prove decomposition,
   *  small enough that a runaway proposal can't fan out a fleet. */
  maxNodes?: number;
}

const DEFAULT_MAX_NODES = 6;

/** The classification+proposal prompt. One completion, no tools. */
export function buildPlannerPrompt(task: string, limits: PlannerLimits = {}): string {
  const maxNodes = limits.maxNodes ?? DEFAULT_MAX_NODES;
  return [
    'You are a planning classifier for a coding agent. Decide how the task below should run and answer with ONE JSON object in a ```json fence and nothing else.',
    '',
    'Choose "kind":',
    '- "direct": answerable in one response without multi-step tool work.',
    '- "loop": one focused multi-step turn (read/edit/verify in sequence) — the default for most coding tasks.',
    `- "graph": ONLY when the task splits into 2-${maxNodes} separable chunks where explicit dependencies or parallelism genuinely help (e.g. survey several areas independently, then synthesize).`,
    '',
    'JSON shape:',
    '{"kind":"direct"|"loop"|"graph","reason":"one sentence","nodes":[{"id":"kebab-case","label":"short","prompt":"self-contained instruction","dependsOn":["other-id"],"readOnly":true}]}',
    '',
    'Rules for "graph":',
    `- 2 to ${maxNodes} nodes; ids kebab-case and unique; dependsOn only lists earlier-declared ids; no cycles.`,
    '- Each node prompt must stand alone (its reader sees ONLY that prompt plus its dependencies\' results).',
    '- End with a node that depends on the others and synthesizes the final answer.',
    '- Mark nodes that only read/inspect with "readOnly": true.',
    '- Omit "nodes" entirely for "direct" and "loop".',
    '',
    'Task:',
    task.trim()
  ].join('\n');
}

export interface ParsedProposal {
  ok: boolean;
  proposal?: GraphProposal;
  errors: string[];
}

/**
 * Parse + strictly validate a model response into a proposal. Never throws.
 * Accepts a ```json fence or bare JSON amid prose (first balanced object).
 */
export function parseGraphProposal(text: string, limits: PlannerLimits = {}): ParsedProposal {
  const maxNodes = limits.maxNodes ?? DEFAULT_MAX_NODES;
  const raw = extractJsonObject(text);
  if (!raw) return { ok: false, errors: ['no JSON object found in the planner response'] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ['planner response JSON does not parse'] };
  }
  const obj = parsed as Partial<GraphProposal> & { nodes?: unknown };
  const errors: string[] = [];

  if (obj.kind !== 'direct' && obj.kind !== 'loop' && obj.kind !== 'graph') {
    errors.push(`kind must be direct|loop|graph (got ${JSON.stringify(obj.kind)})`);
  }

  let nodes: ProposalNode[] | undefined;
  if (obj.kind === 'graph') {
    if (!Array.isArray(obj.nodes) || obj.nodes.length === 0) {
      errors.push('graph proposals need a non-empty "nodes" array');
    } else if (obj.nodes.length > maxNodes) {
      errors.push(`too many nodes: ${obj.nodes.length} (max ${maxNodes})`);
    } else {
      nodes = [];
      for (const [i, n] of (obj.nodes as unknown[]).entries()) {
        const node = n as Partial<ProposalNode>;
        if (!node || typeof node.id !== 'string' || node.id.trim() === '') {
          errors.push(`node[${i}]: missing id`);
          continue;
        }
        if (typeof node.prompt !== 'string' || node.prompt.trim().length < 8) {
          errors.push(`node "${node.id}": missing or trivial prompt`);
          continue;
        }
        nodes.push({
          id: node.id.trim(),
          prompt: node.prompt.trim(),
          label: typeof node.label === 'string' ? node.label : undefined,
          dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn.filter((d): d is string => typeof d === 'string') : undefined,
          readOnly: node.readOnly === true,
        });
      }
      if (errors.length === 0 && nodes.length > 0) {
        // Structural validation via the same code the scheduler trusts.
        const structural = validateGraph({ nodes: nodes.map(({ id, dependsOn }) => ({ id, dependsOn })) });
        if (!structural.ok) errors.push(...structural.errors);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    proposal: {
      kind: obj.kind as ExecutionKind,
      reason: typeof obj.reason === 'string' ? obj.reason : undefined,
      nodes,
    },
  };
}

/** First ```json fence, else the first balanced top-level {...}. */
function extractJsonObject(text: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence && fence[1].trim().startsWith('{')) return fence[1].trim();
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface MaterializeOptions {
  /** Host-built executor for one proposed node (typically wrapLoopAsNode over
   *  the node's prompt). The proposal never supplies executors. */
  makeExecutor: (node: ProposalNode) => NodeExecutor;
  /** Host-owned envelope for one proposed node. The proposal's readOnly flag
   *  is a HINT; the host decides the actual bounds and may ignore or tighten
   *  it — it can never be loosened by the proposal. */
  envelopeFor: (node: ProposalNode) => NodeEnvelope | undefined;
}

/** Turn a validated graph proposal into a runnable spec + executor map. */
export function materializeProposal(
  proposal: GraphProposal,
  opts: MaterializeOptions
): { spec: GraphSpec; executors: Record<string, NodeExecutor> } {
  if (proposal.kind !== 'graph' || !proposal.nodes || proposal.nodes.length === 0) {
    throw new Error('materializeProposal: only graph proposals with nodes can be materialized');
  }
  const specNodes: GraphNodeSpec[] = proposal.nodes.map((n) => ({
    id: n.id,
    label: n.label ?? n.id,
    dependsOn: n.dependsOn,
    envelope: opts.envelopeFor(n),
    // Every planned node must actually produce something — silence is the
    // graph version of a claim without work.
    contract: { outputNonEmpty: true },
  }));
  const executors: Record<string, NodeExecutor> = {};
  for (const n of proposal.nodes) executors[n.id] = opts.makeExecutor(n);
  return { spec: { nodes: specNodes }, executors };
}

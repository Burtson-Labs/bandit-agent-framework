/**
 * `bandit graph plan "<task>"` — Phase 9 live: the model classifies a task
 * (direct | loop | graph) and, for graph, proposes a DAG. The host validates
 * the proposal, shows it, and only executes with an explicit `--run` — under
 * READ-ONLY envelopes for every node in v1, regardless of what the proposal
 * hinted. The planner never owns the scheduler: proposals are data; executors,
 * envelopes, concurrency, and checkpoints are all host-side.
 *
 * `bandit graph resume` continues the last persisted run (demo or planned) —
 * finished nodes restore instantly, the rest re-run.
 *
 * Flag-gated (BANDIT_GRAPH=1), like the rest of the graph runtime.
 */
import {
  buildPlannerPrompt,
  parseGraphProposal,
  materializeProposal,
  wrapLoopAsNode,
  defaultNodePrompt,
  type ProposalNode,
} from '@burtson-labs/agent-core';
import { c, glyph } from './ansi';
import { buildGraphHostDeps, graphFlagGate } from './graphDemo';
import { READ_ONLY_TOOLS, resumeSpecLive, runSpecLive } from './graphRun';

export async function runGraphPlan(argv: string[], cwd: string): Promise<void> {
  if (!graphFlagGate('graph plan "your task"')) return;
  const doRun = argv.includes('--run');
  const task = argv.filter((a) => a !== '--run').join(' ').trim();
  if (!task) {
    process.stdout.write(c.red('usage: bandit graph plan "<task>" [--run]\n'));
    return;
  }

  const { deps, model } = await buildGraphHostDeps(cwd);

  // ── Classify + propose (one completion, no tools) ─────────────────────────
  process.stdout.write(c.dim(`  ${glyph.spark} asking ${model} to classify the task…\n`));
  const chat = await deps.chatFactory();
  let plannerText = '';
  for await (const chunk of chat([{ role: 'user', content: buildPlannerPrompt(task) }])) {
    plannerText += chunk;
  }
  const parsed = parseGraphProposal(plannerText);
  if (!parsed.ok || !parsed.proposal) {
    process.stdout.write(c.red(`  ${glyph.cross} planner proposal rejected:\n`));
    for (const e of parsed.errors) process.stdout.write(c.red(`    • ${e}\n`));
    process.stdout.write(c.dim('  Nothing ran. Try rephrasing the task or just run it as a normal prompt.\n'));
    return;
  }
  const proposal = parsed.proposal;

  process.stdout.write(
    `\n${c.bold('Classification:')} ${c.accent(proposal.kind)}` +
    (proposal.reason ? c.dim(` — ${proposal.reason}`) : '') + '\n'
  );

  if (proposal.kind !== 'graph') {
    process.stdout.write(
      c.dim(`  The planner says this doesn't need a graph. Run it normally:\n`) +
      `  ${c.cyan(`bandit "${task.replace(/"/g, '\\"')}"`)}\n`
    );
    return;
  }

  // ── Show the proposed DAG ─────────────────────────────────────────────────
  process.stdout.write('\n');
  for (const n of proposal.nodes ?? []) {
    const nodeDeps = n.dependsOn?.length ? c.dim(` ← ${n.dependsOn.join(', ')}`) : '';
    const ro = n.readOnly ? c.dim(' · read-only') : '';
    process.stdout.write(`  ${c.cyan(n.id)}${nodeDeps}${ro}\n`);
    process.stdout.write(c.dim(`    ${n.prompt.slice(0, 100)}${n.prompt.length > 100 ? '…' : ''}\n`));
  }
  if (!doRun) {
    process.stdout.write(
      '\n' + c.dim('  Proposal only — nothing ran. Execute it (all nodes read-only) with:\n') +
      `  ${c.cyan(`BANDIT_GRAPH=1 bandit graph plan "${task.replace(/"/g, '\\"')}" --run`)}\n`
    );
    return;
  }

  // ── Execute: host-owned everything, read-only envelopes in v1 ─────────────
  const nodePrompts: Record<string, string> = {};
  for (const n of proposal.nodes ?? []) nodePrompts[n.id] = n.prompt;
  const { spec, executors } = materializeProposal(proposal, {
    makeExecutor: (node: ProposalNode) =>
      wrapLoopAsNode(
        { registry: deps.registry, ctx: deps.ctx, chatFactory: deps.chatFactory, loopOptions: deps.loopOptions },
        defaultNodePrompt(node.prompt)
      ),
    // v1 policy: EVERY planned node is read-only, whatever the hint said.
    envelopeFor: () => ({ allowTools: READ_ONLY_TOOLS }),
  });

  process.stdout.write('\n' + c.dim(`  executing ${spec.nodes.length} nodes (read-only) — /graph inspects it afterwards\n\n`));
  const result = await runSpecLive({ cwd, spec, executors, nodePrompts });

  // Print the sink nodes' output (the synthesis) — that's the answer.
  const dependedUpon = new Set(spec.nodes.flatMap((n) => n.dependsOn ?? []));
  const sinks = spec.nodes.filter((n) => !dependedUpon.has(n.id));
  for (const sink of sinks) {
    const out = result.nodes[sink.id]?.output;
    if (typeof out === 'string' && out.trim()) process.stdout.write('\n' + out.trim() + '\n');
  }
}

/** `bandit graph resume` — continue the last persisted run (demo or planned). */
export async function runGraphResume(cwd: string): Promise<void> {
  if (!graphFlagGate('graph resume')) return;
  const { deps, model } = await buildGraphHostDeps(cwd);
  process.stdout.write(c.bold('Graph resume') + c.dim(` — model ${model}\n\n`));
  const result = await resumeSpecLive(cwd, deps);
  if (result?.status === 'completed') {
    // Print sink outputs so a resumed run still ends with the answer.
    const loaded = await import('./graphRun').then((m) => m.loadRunFile(cwd));
    if (loaded && loaded.ok) {
      const dependedUpon = new Set(loaded.file.spec.nodes.flatMap((n) => n.dependsOn ?? []));
      for (const sink of loaded.file.spec.nodes.filter((n) => !dependedUpon.has(n.id))) {
        const out = result.nodes[sink.id]?.output;
        if (typeof out === 'string' && out.trim()) process.stdout.write('\n' + out.trim() + '\n');
      }
    }
  }
}

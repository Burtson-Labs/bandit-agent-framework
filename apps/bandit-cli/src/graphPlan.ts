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
import * as fs from 'fs';
import * as path from 'path';
import {
  buildPlannerPrompt,
  parseGraphProposal,
  materializeProposal,
  wrapLoopAsNode,
  defaultNodePrompt,
  parseSpec,
  validateSpec,
  buildSpecPlanPrompt,
  specTemplate,
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

/**
 * REPL auto-routing (the 'everything uses graph' decision, CLI half):
 * plan + run a graph for a typed prompt WITHOUT the explicit command.
 * Returns ran:false — never throws — whenever the planner classifies the
 * task as non-graph, rejects, or anything fails: the caller falls back to
 * the normal loop, so routing can never cost the user a turn. v1 keeps the
 * explicit command's read-only envelopes, which is why the caller only
 * routes read-shaped prompts.
 */
export async function tryAutoGraphTurn(
  task: string,
  cwd: string,
): Promise<{ ran: boolean; answer: string }> {
  const none = { ran: false, answer: '' };
  try {
    const { deps, model } = await buildGraphHostDeps(cwd);
    process.stdout.write(c.dim(`  ${glyph.spark} graph-shaped — asking ${model} for a plan (BANDIT_GRAPH=0 disables)
`));
    const chat = await deps.chatFactory();
    let plannerText = '';
    for await (const chunk of chat([{ role: 'user', content: buildPlannerPrompt(task) }])) {
      plannerText += chunk;
    }
    const parsed = parseGraphProposal(plannerText);
    if (!parsed.ok || parsed.proposal?.kind !== 'graph' || !(parsed.proposal.nodes?.length)) {
      process.stdout.write(c.dim('  planner says: not a graph — running normally\n'));
      return none;
    }
    const proposal = parsed.proposal;
    for (const n of proposal.nodes ?? []) {
      const nd = n.dependsOn?.length ? c.dim(` ← ${n.dependsOn.join(', ')}`) : '';
      process.stdout.write(`  ${c.cyan(n.id)}${nd}
`);
    }
    const nodePrompts: Record<string, string> = {};
    for (const n of proposal.nodes ?? []) nodePrompts[n.id] = n.prompt;
    const { spec, executors } = materializeProposal(proposal, {
      makeExecutor: (node: ProposalNode) =>
        wrapLoopAsNode(
          { registry: deps.registry, ctx: deps.ctx, chatFactory: deps.chatFactory, loopOptions: deps.loopOptions },
          defaultNodePrompt(node.prompt)
        ),
      envelopeFor: () => ({ allowTools: READ_ONLY_TOOLS }),
    });
    process.stdout.write(c.dim(`  running ${spec.nodes.length} nodes (read-only)

`));
    const result = await runSpecLive({ cwd, spec, executors, nodePrompts });
    const dependedUpon = new Set(spec.nodes.flatMap((n) => n.dependsOn ?? []));
    const sinks = spec.nodes.filter((n) => !dependedUpon.has(n.id));
    const answer = sinks
      .map((sink) => result.nodes[sink.id]?.output)
      .filter((out): out is string => typeof out === 'string' && out.trim().length > 0)
      .join('\n\n')
      .trim();
    if (!answer) {
      process.stdout.write(c.dim('  graph produced no synthesis — running normally\n'));
      return none;
    }
    process.stdout.write('\n' + answer + '\n');
    return { ran: true, answer };
  } catch (err) {
    process.stdout.write(c.dim(`  graph route unavailable (${err instanceof Error ? err.message : String(err)}) — running normally
`));
    return none;
  }
}

/**
 * `bandit spec new <name>` scaffolds a spec; `bandit spec run <file>` turns a
 * spec into a graph plan whose final node verifies every acceptance criterion.
 * Spec-driven development = spec → planner → graph → contracts-as-criteria,
 * composing the graph runtime. v1 runs READ-ONLY (plan the work + check which
 * criteria are already met) — a spec gap report, not autonomous code-writing.
 */
export async function runSpecCommand(argv: string[], cwd: string): Promise<void> {
  if (!graphFlagGate('spec run <file>')) return;
  const sub = argv[0];
  const arg = argv.slice(1).filter((a) => !a.startsWith('--')).join(' ').trim();

  if (sub === 'new') {
    const name = (arg || 'feature').replace(/[^\w.-]+/g, '-').replace(/\.md$/, '');
    const specPath = path.join(cwd, '.bandit', 'specs', `${name}.md`);
    if (fs.existsSync(specPath)) { process.stdout.write(c.red(`already exists: ${path.relative(cwd, specPath)}\n`)); return; }
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, specTemplate(name.replace(/[-_]/g, ' ')), 'utf8');
    process.stdout.write(
      c.green(`${glyph.check} created ${path.relative(cwd, specPath)}\n`) +
      c.dim('  Fill in the goal + acceptance criteria, then: ') +
      c.cyan(`BANDIT_GRAPH=1 bandit spec run ${path.relative(cwd, specPath)}\n`)
    );
    return;
  }

  if (sub !== 'run' || !arg) {
    process.stdout.write('usage: bandit spec <new <name> | run <file.md>>\n');
    return;
  }

  const specPath = path.isAbsolute(arg) ? arg : path.join(cwd, arg);
  let raw: string;
  try { raw = fs.readFileSync(specPath, 'utf8'); } catch { process.stdout.write(c.red(`can't read spec: ${arg}\n`)); return; }
  const spec = parseSpec(raw);
  const check = validateSpec(spec);
  if (!check.ok) {
    process.stdout.write(c.red(`spec not runnable:\n`) + check.errors.map((e) => c.red(`  • ${e}`)).join('\n') + '\n');
    return;
  }

  const { deps, model } = await buildGraphHostDeps(cwd);
  process.stdout.write(
    c.bold(`Spec: ${spec.title}`) + c.dim(` · ${spec.criteria.length} criteria · ${model}\n`) +
    c.dim(`  ${glyph.spark} planning the graph from the spec…\n`)
  );

  const chat = await deps.chatFactory();
  let plannerText = '';
  for await (const chunk of chat([{ role: 'user', content: buildSpecPlanPrompt(spec) }])) plannerText += chunk;
  const parsed = parseGraphProposal(plannerText);
  if (!parsed.ok || !parsed.proposal || parsed.proposal.kind !== 'graph' || !parsed.proposal.nodes) {
    process.stdout.write(c.red(`  ${glyph.cross} couldn't plan this spec:\n`) + parsed.errors.map((e) => c.red(`    • ${e}`)).join('\n') + '\n');
    return;
  }
  const proposal = parsed.proposal;
  const proposalNodes = proposal.nodes ?? [];

  process.stdout.write('\n' + c.dim('  planned nodes:\n'));
  for (const n of proposalNodes) {
    const nd = n.dependsOn?.length ? c.dim(` ← ${n.dependsOn.join(', ')}`) : '';
    process.stdout.write(`  ${c.cyan(n.id)}${nd}\n`);
  }

  // v1 = read-only: implementation nodes investigate + describe the work,
  // verify-spec checks criteria against current state. The verify node must
  // produce a non-empty report (completion contract).
  const nodePrompts: Record<string, string> = {};
  for (const n of proposalNodes) nodePrompts[n.id] = n.prompt;
  const { spec: graphSpec, executors } = materializeProposal(proposal, {
    makeExecutor: (node: ProposalNode) =>
      wrapLoopAsNode(
        { registry: deps.registry, ctx: deps.ctx, chatFactory: deps.chatFactory, loopOptions: deps.loopOptions },
        defaultNodePrompt(
          node.id === 'verify-spec'
            ? `${node.prompt}\n\nCheck EACH acceptance criterion against the current codebase and report PASS/FAIL per criterion:\n${spec.criteria.map((cr, i) => `${i + 1}. ${cr}`).join('\n')}`
            : node.prompt
        )
      ),
    envelopeFor: () => ({ allowTools: READ_ONLY_TOOLS }),
  });

  process.stdout.write('\n' + c.dim('  running read-only (plan + criteria check — no edits)\n\n'));
  const result = await runSpecLive({ cwd, spec: graphSpec, executors, nodePrompts });
  const verdict = result.nodes['verify-spec']?.output ?? result.nodes[graphSpec.nodes[graphSpec.nodes.length - 1].id]?.output;
  if (typeof verdict === 'string' && verdict.trim()) {
    process.stdout.write('\n' + c.bold('Acceptance criteria:') + '\n' + verdict.trim() + '\n');
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

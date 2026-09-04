/**
 * Shared live-run plumbing for CLI graph executions (demo + planned graphs):
 * one event renderer, one persistence format, one resume path.
 *
 * The run file (.bandit/graph-run.json) stores the spec, the latest
 * checkpoint, AND each node's prompt. Planned graphs are dynamic — without
 * spec+prompts on disk, /graph inspect/why/retry would have nothing to
 * interpret the checkpoint against, and `bandit graph resume` couldn't
 * rebuild executors for the unfinished nodes.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  runGraph,
  graphFingerprint,
  wrapLoopAsNode,
  defaultNodePrompt,
  type ChatFn,
  type GraphCheckpoint,
  type GraphRunResult,
  type GraphSpec,
  type NodeExecutor,
  type ToolExecutionContext,
  type ToolRegistry,
  type ToolUseLoopOptions,
} from '@burtson-labs/agent-core';
import { c, glyph } from './ansi';

/** Read-only tool surface for graph nodes. Names must match the core
 *  registry; run_command is deliberately absent — graph runs need zero
 *  permission prompts and zero side effects in v1. */
export const READ_ONLY_TOOLS = ['read_file', 'list_files', 'ls', 'search_code', 'find_directory'];

export interface GraphRunFile {
  version: 1;
  savedAt: string;
  spec: GraphSpec;
  checkpoint: GraphCheckpoint;
  /** Per-node loop prompts — what resume rebuilds executors from. */
  nodePrompts: Record<string, string>;
}

export function graphRunPath(cwd: string): string {
  return path.join(cwd, '.bandit', 'graph-run.json');
}

export function saveRunFile(cwd: string, spec: GraphSpec, checkpoint: GraphCheckpoint, nodePrompts: Record<string, string>): void {
  // Best-effort — persistence must never kill a run.
  try {
    const file: GraphRunFile = { version: 1, savedAt: new Date().toISOString(), spec, checkpoint, nodePrompts };
    fs.mkdirSync(path.dirname(graphRunPath(cwd)), { recursive: true });
    fs.writeFileSync(graphRunPath(cwd), JSON.stringify(file, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/** Load the last run, validating that checkpoint and spec belong together.
 *  Returns null when no run file exists. */
export function loadRunFile(cwd: string): { ok: true; file: GraphRunFile } | { ok: false; error: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(graphRunPath(cwd), 'utf8');
  } catch {
    return null;
  }
  try {
    const file = JSON.parse(raw) as GraphRunFile;
    if (file.version !== 1 || !file.spec || !file.checkpoint) {
      return { ok: false, error: 'run file is not a graph run' };
    }
    if (file.checkpoint.specFingerprint !== graphFingerprint(file.spec)) {
      return { ok: false, error: 'run file is corrupt (checkpoint does not match its own spec)' };
    }
    return { ok: true, file };
  } catch {
    return { ok: false, error: 'run file is not valid JSON' };
  }
}

/** Everything a loop-wrapped node needs from the host to execute. */
export interface LoopNodeHostDeps {
  registry: ToolRegistry;
  ctx: ToolExecutionContext;
  chatFactory: () => ChatFn | Promise<ChatFn>;
  loopOptions: ToolUseLoopOptions;
}

/** Build executors for a spec from its persisted per-node prompts. */
export function executorsFromPrompts(
  nodePrompts: Record<string, string>,
  deps: LoopNodeHostDeps
): Record<string, NodeExecutor> {
  const executors: Record<string, NodeExecutor> = {};
  for (const [id, prompt] of Object.entries(nodePrompts)) {
    executors[id] = wrapLoopAsNode(
      { registry: deps.registry, ctx: deps.ctx, chatFactory: deps.chatFactory, loopOptions: deps.loopOptions },
      defaultNodePrompt(prompt)
    );
  }
  return executors;
}

/** Run a spec live: render graph:* events, persist a run file every settle. */
export async function runSpecLive(opts: {
  cwd: string;
  spec: GraphSpec;
  executors: Record<string, NodeExecutor>;
  nodePrompts: Record<string, string>;
  resumeFrom?: GraphCheckpoint;
  maxConcurrency?: number;
}): Promise<GraphRunResult> {
  const startedAt = Date.now();
  const stamp = (): string => c.dim(`[${String(Date.now() - startedAt).padStart(5, ' ')}ms]`);
  const result = await runGraph(opts.spec, opts.executors, {
    maxConcurrency: opts.maxConcurrency ?? 2,
    resumeFrom: opts.resumeFrom,
    onCheckpoint: (cp) => saveRunFile(opts.cwd, opts.spec, cp, opts.nodePrompts),
    emitEvent: (type, payload) => {
      const p = (payload ?? {}) as { id?: string; label?: string; summary?: string; error?: string; violations?: string[] };
      switch (type) {
        case 'graph:node_start':
          process.stdout.write(`${stamp()} ${c.accent('▶')} ${p.label}\n`);
          break;
        case 'graph:node_done':
          process.stdout.write(`${stamp()} ${c.green(glyph.check)} ${p.label}${p.summary ? c.dim(' — ' + p.summary.split('\n')[0].slice(0, 80)) : ''}\n`);
          break;
        case 'graph:node_failed':
          process.stdout.write(`${stamp()} ${c.red(glyph.cross)} ${p.label} — ${p.error}\n`);
          break;
        case 'graph:node_contract_violation':
          process.stdout.write(`${stamp()} ${c.red('◆')} contract violation on ${p.label}: ${(p.violations ?? []).join('; ')}\n`);
          break;
        case 'graph:node_skipped':
          process.stdout.write(`${stamp()} ${c.dim('↷ skipped ' + (p.label ?? ''))}\n`);
          break;
        case 'graph:node_restored':
          process.stdout.write(`${stamp()} ${c.accent('⟲')} restored ${p.label}${p.summary ? c.dim(' — ' + p.summary.split('\n')[0].slice(0, 60)) : ''}\n`);
          break;
      }
    },
  });
  const done = Object.values(result.nodes).filter((n) => n.state === 'done').length;
  process.stdout.write(
    '\n' +
    (result.status === 'completed' ? c.green(`${glyph.check} graph completed`) : c.red(`${glyph.cross} graph ${result.status}`)) +
    c.dim(` · ${done}/${opts.spec.nodes.length} nodes · ${(result.durationMs / 1000).toFixed(1)}s\n`)
  );
  return result;
}

/** Resume the persisted run: restore done nodes, run the rest. Works for both
 *  demo and planned graphs — executors rebuild from the stored prompts. */
export async function resumeSpecLive(cwd: string, deps: LoopNodeHostDeps): Promise<GraphRunResult | null> {
  const loaded = loadRunFile(cwd);
  if (loaded === null) {
    process.stdout.write(c.dim('No graph run to resume. Start one with: ') + c.cyan('BANDIT_GRAPH=1 bandit graph demo') + c.dim(' or ') + c.cyan('bandit graph plan "…" --run') + '\n');
    return null;
  }
  if (!loaded.ok) {
    process.stdout.write(c.red(`Can't resume: ${loaded.error}\n`));
    return null;
  }
  const { spec, checkpoint, nodePrompts } = loaded.file;
  const missing = spec.nodes.filter((n) => !nodePrompts[n.id]).map((n) => n.id);
  if (missing.length > 0) {
    process.stdout.write(c.red(`Can't resume: run file has no prompts for: ${missing.join(', ')}\n`));
    return null;
  }
  const executors = executorsFromPrompts(nodePrompts, deps);
  return runSpecLive({ cwd, spec, executors, nodePrompts, resumeFrom: checkpoint });
}

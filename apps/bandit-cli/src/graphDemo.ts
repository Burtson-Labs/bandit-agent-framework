/**
 * `bandit graph demo` — the terminal-first proof that the graph runtime runs
 * real work (Phase 8's first slice). Two READ-ONLY scan nodes run in
 * parallel, then a synthesize node folds their results into a project brief:
 *
 *     scan-structure ─┐
 *                     ├─→ synthesize
 *     scan-docs ──────┘
 *
 * Every node is a wrapped ToolUseLoop turn (the same loop the REPL runs) with
 * a read-only capability envelope; synthesize carries a completion contract
 * (non-empty output). Progress renders straight from graph:* events — the
 * exact stream any host consumes — so what you see here is the protocol, not
 * a bespoke UI.
 *
 * Flag-gated (BANDIT_GRAPH=1): the graph runtime ships dark until it earns
 * its way into defaults via the bench.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  createCoreToolRegistry,
  createDefaultLanguageAdapters,
  runGraph,
  wrapLoopAsNode,
  defaultNodePrompt,
  type ChatFn,
  type GraphCheckpoint,
  type GraphSpec,
  type NodeExecutor,
} from '@burtson-labs/agent-core';
import { getModelCapabilities } from '@burtson-labs/stealth-core-runtime';
import { c, glyph } from './ansi';
import { loadConfigFiles, resolveConfig } from './config';
import { CliToolExecutionContext } from './cliToolContext';
import { buildCliChatFn } from './agent/cliChatFn';

/** Read-only tool surface for scan/synthesize nodes. Names must match the
 *  core registry; run_command is deliberately absent — the demo needs zero
 *  permission prompts and zero side effects. */
const READ_ONLY_TOOLS = ['read_file', 'list_files', 'ls', 'search_code', 'find_directory'];

/** The demo's spec — exported so `/graph` (status/inspect/why/retry) can
 *  rebuild the SAME structure and match it against the persisted checkpoint's
 *  fingerprint. Keep node ids/deps stable: changing them orphans checkpoints. */
export function demoGraphSpec(): GraphSpec {
  return {
    nodes: [
      { id: 'scan-structure', label: 'scan structure', envelope: { allowTools: READ_ONLY_TOOLS } },
      { id: 'scan-docs', label: 'scan docs', envelope: { allowTools: READ_ONLY_TOOLS } },
      {
        id: 'synthesize',
        label: 'synthesize brief',
        dependsOn: ['scan-structure', 'scan-docs'],
        envelope: { allowTools: READ_ONLY_TOOLS },
        contract: { outputNonEmpty: true },
      },
    ],
  };
}

/** Where the demo persists its checkpoint for a given workspace. */
export function demoCheckpointPath(cwd: string): string {
  return path.join(cwd, '.bandit', 'graph-demo-checkpoint.json');
}

export async function runGraphDemo(argv: string[], cwd: string): Promise<void> {
  if (!/^(1|true)$/i.test(process.env.BANDIT_GRAPH ?? '')) {
    process.stdout.write(
      c.yellow(`  ${glyph.warn} The graph runtime is experimental and ships behind a flag.\n`) +
      c.dim(`     Run it with: ${c.cyan('BANDIT_GRAPH=1 bandit graph demo')}\n`)
    );
    return;
  }

  const fileConfig = await loadConfigFiles(cwd);
  const resolved = resolveConfig(fileConfig, {});
  const { buildProviderSettings } = await import('./cli');
  const { settings, model } = buildProviderSettings(resolved);
  const modelCaps = getModelCapabilities(model);
  const nativeTools = (settings.kind === 'ollama' || settings.kind === 'bandit' || settings.kind === 'openai-compatible')
    && modelCaps.supportsToolCalling;

  const registry = createCoreToolRegistry();
  const ctx = new CliToolExecutionContext(cwd, createDefaultLanguageAdapters());
  const chatFactory = (): Promise<ChatFn> =>
    buildCliChatFn({ settings, model, pendingImages: undefined, getThink: () => undefined });

  const loopOptions = {
    maxIterations: 6,
    nativeTools,
    nativeToolFailureFallback: true,
    compactToolBlock: modelCaps.tier === 'small',
  };
  const node = (prompt: string): NodeExecutor =>
    wrapLoopAsNode({ registry, ctx, chatFactory, loopOptions }, defaultNodePrompt(prompt));

  const spec: GraphSpec = demoGraphSpec();
  const executors: Record<string, NodeExecutor> = {
    'scan-structure': node(
      'List the top-level files and directories of this project (use list_files/ls) and say in 2-3 lines what kind of project this looks like. Do not modify anything.'
    ),
    'scan-docs': node(
      'Read the README (if present — check the root) and summarize in 2-3 lines what this project claims to do. Do not modify anything.'
    ),
    synthesize: node(
      'Write a crisp 5-line project brief for a new contributor. Base it ONLY on the upstream results below.'
    ),
  };

  // Durability (Phase 5): every settle snapshots to .bandit; `--resume`
  // restores finished nodes and runs only the remainder. Kill the demo
  // mid-run (Ctrl+C) and resume it to see restored nodes come back instantly.
  const checkpointPath = demoCheckpointPath(cwd);
  let resumeFrom: GraphCheckpoint | undefined;
  if (argv.includes('--resume')) {
    try {
      resumeFrom = JSON.parse(await fs.promises.readFile(checkpointPath, 'utf8')) as GraphCheckpoint;
    } catch {
      process.stdout.write(c.dim(`  (no checkpoint at ${path.relative(cwd, checkpointPath)} — starting fresh)\n`));
    }
  }

  const startedAt = Date.now();
  const stamp = (): string => c.dim(`[${String(Date.now() - startedAt).padStart(5, ' ')}ms]`);
  process.stdout.write(
    c.bold(`Graph demo`) + c.dim(` — ${path.basename(cwd)} · model ${model} · 2 parallel scans → synthesize`)
    + (resumeFrom ? c.accent(' · resumed') : '') + '\n\n'
  );

  const result = await runGraph(spec, executors, {
    maxConcurrency: 2,
    resumeFrom,
    onCheckpoint: (cp) => {
      // Best-effort persistence — never let disk trouble kill the run.
      try {
        fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
        fs.writeFileSync(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');
      } catch { /* ignore */ }
    },
    emitEvent: (type, payload) => {
      const p = (payload ?? {}) as { id?: string; label?: string; summary?: string; error?: string; violations?: string[]; status?: string; durationMs?: number };
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

  process.stdout.write('\n');
  if (result.status === 'completed') {
    process.stdout.write(String(result.nodes.synthesize.output ?? '') + '\n\n');
  }
  const doneCount = Object.values(result.nodes).filter((n) => n.state === 'done').length;
  process.stdout.write(
    (result.status === 'completed' ? c.green(`${glyph.check} graph completed`) : c.red(`${glyph.cross} graph ${result.status}`)) +
    c.dim(` · ${doneCount}/${spec.nodes.length} nodes · ${(result.durationMs / 1000).toFixed(1)}s\n`)
  );
}

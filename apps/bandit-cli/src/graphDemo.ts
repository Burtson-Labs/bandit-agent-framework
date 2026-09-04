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
 * (non-empty output). Progress renders straight from graph:* events via the
 * shared runner (graphRun.ts) — the same path planned graphs use — and every
 * settle persists to .bandit/graph-run.json so `bandit graph resume` (or
 * `--resume` here) restores finished nodes instantly.
 *
 * Flag-gated (BANDIT_GRAPH=1): the graph runtime ships dark until it earns
 * its way into defaults via the bench.
 */
import * as path from 'path';
import {
  createCoreToolRegistry,
  createDefaultLanguageAdapters,
  type ChatFn,
  type GraphSpec,
} from '@burtson-labs/agent-core';
import { getModelCapabilities } from '@burtson-labs/stealth-core-runtime';
import { c, glyph } from './ansi';
import { loadConfigFiles, resolveConfig } from './config';
import { CliToolExecutionContext } from './cliToolContext';
import { buildCliChatFn } from './agent/cliChatFn';
import {
  READ_ONLY_TOOLS,
  executorsFromPrompts,
  resumeSpecLive,
  runSpecLive,
  type LoopNodeHostDeps,
} from './graphRun';

// Back-compat re-export: graphPlan and older imports reach READ_ONLY_TOOLS here.
export { READ_ONLY_TOOLS } from './graphRun';

/** The demo's spec. Keep node ids/deps stable: changing them orphans
 *  persisted run files. */
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

/** Per-node prompts — persisted in the run file so resume can rebuild
 *  executors without re-deriving anything. */
export function demoNodePrompts(): Record<string, string> {
  return {
    'scan-structure':
      'List the top-level files and directories of this project (use list_files/ls) and say in 2-3 lines what kind of project this looks like. Do not modify anything.',
    'scan-docs':
      'Read the README (if present — check the root) and summarize in 2-3 lines what this project claims to do. Do not modify anything.',
    synthesize:
      'Write a crisp 5-line project brief for a new contributor. Base it ONLY on the upstream results below.',
  };
}

/** Resolve provider + tool deps the way the REPL does. Shared by demo, plan,
 *  and resume so every graph surface runs identical loop wiring. */
export async function buildGraphHostDeps(cwd: string): Promise<{ deps: LoopNodeHostDeps; model: string }> {
  const fileConfig = await loadConfigFiles(cwd);
  const resolved = resolveConfig(fileConfig, {});
  const { buildProviderSettings } = await import('./cli');
  const { settings, model } = buildProviderSettings(resolved);
  const modelCaps = getModelCapabilities(model);
  const deps: LoopNodeHostDeps = {
    registry: createCoreToolRegistry(),
    ctx: new CliToolExecutionContext(cwd, createDefaultLanguageAdapters()),
    chatFactory: (): Promise<ChatFn> =>
      buildCliChatFn({ settings, model, pendingImages: undefined, getThink: () => undefined }),
    loopOptions: {
      maxIterations: 6,
      nativeTools: (settings.kind === 'ollama' || settings.kind === 'bandit' || settings.kind === 'openai-compatible')
        && modelCaps.supportsToolCalling,
      nativeToolFailureFallback: true,
      compactToolBlock: modelCaps.tier === 'small',
    },
  };
  return { deps, model };
}

export function graphFlagGate(_usage: string): boolean {
  // Graph execution is ON by default (2026-09-04 'make everything use
  // graph' decision). BANDIT_GRAPH=0 is the kill switch.
  return !/^(0|false)$/i.test(process.env.BANDIT_GRAPH ?? '');
}

export async function runGraphDemo(argv: string[], cwd: string): Promise<void> {
  if (!graphFlagGate('graph demo')) return;
  const { deps, model } = await buildGraphHostDeps(cwd);

  if (argv.includes('--resume')) {
    process.stdout.write(c.bold('Graph demo') + c.dim(` — ${path.basename(cwd)} · model ${model} · resumed\n\n`));
    await resumeSpecLive(cwd, deps);
    return;
  }

  const spec = demoGraphSpec();
  const nodePrompts = demoNodePrompts();
  const executors = executorsFromPrompts(nodePrompts, deps);

  process.stdout.write(
    c.bold('Graph demo') + c.dim(` — ${path.basename(cwd)} · model ${model} · 2 parallel scans → synthesize\n\n`)
  );
  const result = await runSpecLive({ cwd, spec, executors, nodePrompts });
  if (result.status === 'completed') {
    process.stdout.write('\n' + String(result.nodes.synthesize.output ?? '') + '\n');
  }
}

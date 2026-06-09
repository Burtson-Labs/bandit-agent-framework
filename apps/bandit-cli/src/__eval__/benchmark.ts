#!/usr/bin/env node
/**
 * Benchmark harness entry point. Runs the same fixture set against multiple
 * models and emits a comparison markdown table (wall time, iterations, tool
 * calls) so you can see which model is faster on which kind of task.
 *
 * Distinct from `eval.ts`: eval answers "did the model behave correctly"
 * with a binary pass/fail; benchmark answers "how efficiently did each
 * model behave" with a cross-model comparison matrix. Reuses the same
 * fixture runner so correctness and performance are measured against the
 * same scenarios.
 *
 * Flags:
 *   --models "a,b,c"       comma-separated list. Each entry is either a bare
 *                          model name (uses --provider) or "provider:model".
 *                          If omitted, uses the single model from config.
 *   --filter <substr>      only run fixtures whose id/description contains
 *   --runs <N>             override runs per fixture (5 is a reasonable
 *                          benchmark default for stability; eval's 3 is
 *                          faster but noisier on perf medians)
 *   --provider <kind>      default provider for entries in --models that
 *                          don't specify one. Defaults to config provider.
 *   --out <path>           markdown output path (default .bandit/benchmark-report.md)
 *   --variant <cli|ext>    system-prompt variant. Defaults to cli.
 *
 * Example:
 *   pnpm benchmark -- --models "bandit-core-1,ollama:gemma3:12b-it-qat" \
 *     --filter apply_edit --runs 5
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadConfigFiles, resolveConfig } from '../config';
import { allFixtures } from './fixtures';
import { runFixtures, type RunnerProvider } from './runner';
import {
  renderBenchmarkLive,
  renderBenchmarkMarkdown,
  type BenchmarkEntry
} from './benchmarkReport';
import { loadWorkspaceFixtures } from './workspaceFixtures';
import type { ProviderSettings } from '@burtson-labs/stealth-core-runtime';
import type { Fixture } from './types';

interface BenchArgs {
  models?: string[];
  filter?: string;
  runs?: number;
  out: string;
  provider?: 'ollama' | 'bandit';
  variant?: 'cli' | 'extension';
  onlyBuiltins?: boolean;
  onlyWorkspace?: boolean;
}

function parseArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = { out: '.bandit/benchmark-report.md' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--models') args.models = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--filter') args.filter = argv[++i];
    else if (a === '--runs') args.runs = parseInt(argv[++i], 10);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--provider') args.provider = argv[++i] as 'ollama' | 'bandit';
    else if (a === '--only-builtins') args.onlyBuiltins = true;
    else if (a === '--only-workspace') args.onlyWorkspace = true;
    else if (a === '--variant') {
      const v = argv[++i];
      if (v !== 'cli' && v !== 'extension') {
        process.stderr.write(`bandit benchmark: --variant must be "cli" or "extension" (got "${v}")\n`);
        process.exit(1);
      }
      args.variant = v;
    }
  }
  return args;
}

/**
 * Parse one entry from --models into a concrete provider+model pair.
 * Accepted shapes:
 *   - "model"                     → defaults to provider + use bare model
 *   - "ollama:model"              → force ollama
 *   - "bandit:bandit-core-1"      → force bandit
 * The split is on the FIRST colon so Ollama tag-style names like
 * "gemma3:12b-it-qat" survive — "ollama:gemma3:12b-it-qat" parses as
 * provider=ollama, model=gemma3:12b-it-qat.
 */
function parseModelSpec(spec: string, defaultProvider: 'ollama' | 'bandit' | 'openai-compatible'): { kind: 'ollama' | 'bandit' | 'openai-compatible'; model: string } {
  const colon = spec.indexOf(':');
  if (colon === -1) return { kind: defaultProvider, model: spec };
  const prefix = spec.slice(0, colon);
  if (prefix === 'ollama' || prefix === 'bandit' || prefix === 'openai-compatible') {
    return { kind: prefix, model: spec.slice(colon + 1) };
  }
  // Prefix is not a provider (e.g. "gemma3:12b") — treat whole string as a
  // bare model name under the default provider.
  return { kind: defaultProvider, model: spec };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  const fileConfig = await loadConfigFiles(cwd);
  const resolved = resolveConfig(fileConfig, { provider: args.provider });

  // If --models wasn't passed, benchmark the single configured model. That
  // still produces a useful report — a single-column perf baseline you can
  // diff against next time.
  const modelSpecs = args.models && args.models.length > 0
    ? args.models
    : [resolved.model];

  const providers: RunnerProvider[] = modelSpecs.map(spec => {
    const parsed = parseModelSpec(spec, resolved.provider);
    const settings: ProviderSettings = {
      kind: parsed.kind,
      apiKey: resolved.apiKey,
      apiUrl: resolved.apiUrl,
      ollamaUrl: resolved.ollamaUrl,
      ollamaModel: parsed.kind === 'ollama' ? parsed.model : undefined,
      ollamaHeaders: parsed.kind === 'ollama' && Object.keys(resolved.ollamaHeaders).length > 0
        ? resolved.ollamaHeaders
        : undefined
    };
    return {
      kind: parsed.kind,
      model: parsed.model,
      settings,
      variant: args.variant ?? 'cli'
    };
  });

  // Fail fast if any bandit provider is selected without an API key — no
  // point running 8 fixtures against 3 models when the first network call
  // will 401.
  for (const provider of providers) {
    if (provider.kind === 'bandit' && !provider.settings.apiKey) {
      process.stderr.write(`bandit benchmark: BANDIT_API_KEY required for model "${provider.model}" (provider=bandit). Aborting.\n`);
      process.exit(1);
    }
  }

  const builtins = args.onlyWorkspace ? [] : allFixtures;
  const workspace = args.onlyBuiltins
    ? { fixtures: [], warnings: [] as string[] }
    : await loadWorkspaceFixtures(cwd);
  for (const warning of workspace.warnings) {
    process.stderr.write(`bandit benchmark: ${warning}\n`);
  }

  const combined = dedupeFixtures([...builtins, ...workspace.fixtures]);
  const fixtures = selectFixtures(combined, args);
  if (fixtures.length === 0) {
    process.stderr.write(`bandit benchmark: no fixtures selected${args.filter ? ` (filter="${args.filter}")` : ''}. Aborting.\n`);
    process.exit(1);
  }

  // Default to runs=5 for benchmarks (5 stable samples beats 3 for median
  // perf numbers). Let --runs override. Clamp passThreshold so honest
  // threshold-based passes remain achievable.
  const runs = args.runs ?? 5;
  const adjusted = fixtures.map(f => ({
    ...f,
    runs,
    passThreshold: f.passThreshold !== undefined ? Math.min(f.passThreshold, runs) : undefined
  }));

  process.stdout.write(`\nBandit benchmark — ${adjusted.length} fixture(s) × ${providers.length} model(s), runs=${runs}\n`);
  for (const p of providers) {
    process.stdout.write(`  • ${p.kind}/${p.model} [variant=${p.variant}]\n`);
  }
  process.stdout.write('\n');

  const entries: BenchmarkEntry[] = [];
  for (const provider of providers) {
    const label = `${provider.kind}/${provider.model}`;
    process.stdout.write(`→ ${label}\n`);
    const report = await runFixtures(adjusted, provider);
    const entry: BenchmarkEntry = { label, report };
    renderBenchmarkLive(entry);
    entries.push(entry);
  }

  const md = renderBenchmarkMarkdown(entries);
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(cwd, args.out);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, md, 'utf8');
  process.stdout.write(`\nbenchmark report: ${path.relative(cwd, outPath) || outPath}\n`);

  // Exit non-zero if any model failed any fixture — so this doubles as a
  // CI-gatable "did any model regress" signal without the caller needing
  // a separate pass/fail parser.
  const anyFailed = entries.some(e =>
    e.report.fixtureResults.some(r => !r.passed && !r.skipped)
  );
  process.exit(anyFailed ? 1 : 0);
}

function selectFixtures(fixtures: Fixture[], args: BenchArgs): Fixture[] {
  if (!args.filter) return fixtures;
  const needle = args.filter.toLowerCase();
  return fixtures.filter(f =>
    f.id.toLowerCase().includes(needle) ||
    f.description.toLowerCase().includes(needle)
  );
}

function dedupeFixtures(fixtures: Fixture[]): Fixture[] {
  const byId = new Map<string, Fixture>();
  for (const fx of fixtures) byId.set(fx.id, fx);
  return Array.from(byId.values());
}

main().catch(err => {
  process.stderr.write(`benchmark harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});

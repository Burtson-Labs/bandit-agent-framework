#!/usr/bin/env node
/**
 * Eval harness entry point.
 *
 * Loads the fixture set, resolves the provider config the same way the CLI
 * does (flags → env → ~/.bandit/config.json → .bandit/config.json), runs
 * every fixture N times, and prints a live pass/fail matrix plus writes a
 * detailed markdown report to `.bandit/eval-report.md` for PR review.
 *
 * Flags:
 *   --filter <substr>   only run fixtures whose id contains the substring
 *   --provider <kind>   override provider (ollama|bandit)
 *   --model <name>      override model
 *   --runs <N>          override the per-fixture run count (default 3)
 *   --out <path>        markdown output path (default .bandit/eval-report.md)
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadConfigFiles, resolveConfig } from '../config';
import { allFixtures } from './fixtures';
import { runFixtures, type RunnerProvider } from './runner';
import { renderLive, renderMarkdown, renderFixtureProgress } from './report';
import { loadWorkspaceFixtures } from './workspaceFixtures';
import type { ProviderSettings } from '@burtson-labs/stealth-core-runtime';
import type { Fixture } from './types';

interface EvalArgs {
  filter?: string;
  provider?: 'ollama' | 'bandit';
  model?: string;
  runs?: number;
  out: string;
  /** When true, only run built-in framework fixtures (skip workspace ones).
   *  Useful in CI to isolate "did a framework change break my own evals"
   *  from "did it break my team's product evals". */
  onlyBuiltins?: boolean;
  /** Mirror of --only-builtins for workspace-only runs. */
  onlyWorkspace?: boolean;
  /** When true, print the discovered fixture set (builtin + workspace) and
   *  exit. No model calls. Lets CI verify loader health cheaply, and lets
   *  authors confirm their .mjs file parsed without waiting for a full run. */
  list?: boolean;
  /** System-prompt variant to run fixtures against. `cli` uses the CLI's
   *  buildSystemPrompt (default); `extension` uses the VS Code extension's
   *  buildExtensionSystemPrompt. Lets us side-by-side the two hosts on the
   *  same fixtures to catch behaviour drift between them. */
  variant?: 'cli' | 'extension';
}

function parseArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = { out: '.bandit/eval-report.md' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--filter') args.filter = argv[++i];
    else if (a === '--provider') args.provider = argv[++i] as 'ollama' | 'bandit';
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--runs') args.runs = parseInt(argv[++i], 10);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--only-builtins') args.onlyBuiltins = true;
    else if (a === '--only-workspace') args.onlyWorkspace = true;
    else if (a === '--list') args.list = true;
    else if (a === '--variant') {
      const v = argv[++i];
      if (v !== 'cli' && v !== 'extension') {
        process.stderr.write(`bandit eval: --variant must be "cli" or "extension" (got "${v}")\n`);
        process.exit(1);
      }
      args.variant = v;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  // --list short-circuits everything else — no config, no provider, no
  // network. This is the cheap path CI uses to confirm fixtures parse.
  if (args.list) {
    const builtins = args.onlyWorkspace ? [] : allFixtures;
    const workspace = args.onlyBuiltins
      ? { fixtures: [], warnings: [] as string[] }
      : await loadWorkspaceFixtures(cwd);
    for (const w of workspace.warnings) process.stdout.write(`  ! ${w}\n`);
    const combined = dedupeFixtures([...builtins, ...workspace.fixtures]);
    const fixtures = selectFixtures(combined, args);
    process.stdout.write(`${fixtures.length} fixture(s) discovered (builtins: ${builtins.length}, workspace: ${workspace.fixtures.length})\n`);
    for (const fx of fixtures) {
      const source = allFixtures.includes(fx) ? 'builtin' : 'workspace';
      process.stdout.write(`  ${fx.id.padEnd(40)}  [${source}]  ${fx.description}\n`);
    }
    return;
  }

  const fileConfig = await loadConfigFiles(cwd);
  const resolved = resolveConfig(fileConfig, {
    provider: args.provider,
    model: args.model
  });

  if (resolved.provider === 'bandit' && !resolved.apiKey) {
    process.stderr.write('bandit eval: BANDIT_API_KEY required for provider=bandit. Aborting.\n');
    process.exit(1);
  }

  const settings: ProviderSettings = {
    kind: resolved.provider,
    apiKey: resolved.apiKey,
    apiUrl: resolved.apiUrl,
    ollamaUrl: resolved.ollamaUrl,
    ollamaModel: resolved.provider === 'ollama' ? resolved.model : undefined,
    ollamaHeaders: resolved.provider === 'ollama' && Object.keys(resolved.ollamaHeaders).length > 0
      ? resolved.ollamaHeaders
      : undefined
  };

  const provider: RunnerProvider = {
    kind: resolved.provider,
    model: resolved.model,
    settings,
    variant: args.variant ?? 'cli'
  };

  // Discover workspace fixtures alongside the built-in set unless the caller
  // explicitly scoped to one side. Warnings from the loader surface up top so
  // authors see "your .bandit/evals/foo.mjs was skipped" without having to
  // scroll past a full run report to find it.
  const builtins = args.onlyWorkspace ? [] : allFixtures;
  const workspace = args.onlyBuiltins
    ? { fixtures: [], warnings: [] as string[] }
    : await loadWorkspaceFixtures(cwd);

  for (const warning of workspace.warnings) {
    process.stderr.write(`bandit eval: ${warning}\n`);
  }

  const combined = dedupeFixtures([...builtins, ...workspace.fixtures]);
  const fixtures = selectFixtures(combined, args);
  if (fixtures.length === 0) {
    const scope = args.filter ? ` matched filter "${args.filter}"` : '';
    process.stderr.write(`bandit eval: no fixtures${scope}. `);
    if (!args.filter) {
      process.stderr.write(`Add fixtures under ${cwd}/.bandit/evals/ (*.mjs|cjs|js) or use --only-builtins.\n`);
    } else {
      process.stderr.write('\n');
    }
    process.exit(1);
  }

  if (workspace.fixtures.length > 0) {
    process.stdout.write(`  ${workspace.fixtures.length} workspace fixture(s) loaded from .bandit/evals/\n`);
  }

  // Apply --runs override uniformly so a CI invocation with --runs=1 can
  // race through the full set, while a local run keeps the N=3 default.
  // When a fixture declared passThreshold: 2 and the caller drops to runs: 1,
  // the threshold becomes mathematically unreachable and every run failures
  // regardless of actual behaviour — clamp threshold to runs to keep the
  // math honest.
  const adjusted = args.runs !== undefined
    ? fixtures.map(f => {
        const runs = args.runs!;
        const passThreshold = f.passThreshold !== undefined
          ? Math.min(f.passThreshold, runs)
          : undefined;
        return { ...f, runs, passThreshold };
      })
    : fixtures;

  process.stdout.write(`\nRunning ${adjusted.length} fixture(s) against ${provider.kind}/${provider.model} [variant=${provider.variant}]…\n\n`);
  const report = await runFixtures(adjusted, provider, {
    onFixtureComplete: renderFixtureProgress
  });
  renderLive(report);

  const md = renderMarkdown(report);
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(cwd, args.out);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, md, 'utf8');
  process.stdout.write(`\nmarkdown report: ${path.relative(cwd, outPath) || outPath}\n`);

  const failed = report.fixtureResults.filter(r => !r.passed && !r.skipped).length;
  process.exit(failed > 0 ? 1 : 0);
}

function selectFixtures(fixtures: Fixture[], args: EvalArgs): Fixture[] {
  if (!args.filter) return fixtures;
  const needle = args.filter.toLowerCase();
  return fixtures.filter(f =>
    f.id.toLowerCase().includes(needle) ||
    f.description.toLowerCase().includes(needle)
  );
}

/**
 * When a workspace fixture declares the same id as a builtin, the workspace
 * version wins. That's the migration path for a team that wants to override
 * a framework fixture with a tighter product-specific version: just drop in
 * a fixture with the same id and it replaces the builtin. Mirrors how skill
 * loading handles .md vs legacy .json collisions.
 */
function dedupeFixtures(fixtures: Fixture[]): Fixture[] {
  const byId = new Map<string, Fixture>();
  for (const fx of fixtures) {
    byId.set(fx.id, fx);  // later entries (workspace > builtin) replace
  }
  return Array.from(byId.values());
}

main().catch(err => {
  process.stderr.write(`eval harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});

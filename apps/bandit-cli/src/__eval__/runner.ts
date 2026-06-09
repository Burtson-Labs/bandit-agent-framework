/**
 * Fixture runner. Given a fixture + a resolved provider config, spins up a
 * sandbox workspace, runs the actual tool-use loop against the configured
 * model, captures every tool call via emitEvent, and evaluates the trace
 * against the fixture's assertions. Repeats `fixture.runs` times and reports
 * pass/fail based on `passThreshold`.
 *
 * The goal is to match what the REAL CLI does as closely as possible:
 *   - Same skill registry (default + workspace)
 *   - Same system prompt (imported from ../systemPrompt)
 *   - Same tool-use loop with the same max-iterations default
 *   - Same language adapters the CLI ships with
 *
 * What's deliberately different:
 *   - No permission gate (eval runs auto-allow)
 *   - No hooks (they're per-workspace and out of scope for behavioural evals)
 *   - No mention expansion, no semantic context, no session persistence —
 *     those are well-covered by the smoke test at the mechanical level.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ToolUseLoop,
  createDefaultSkillRegistry,
  createDefaultLanguageAdapters,
  registerWorkspaceSkills,
  type ChatFn,
  type ToolLoopMessage
} from '@burtson-labs/agent-core';
import { createProvider, type ProviderSettings, buildExtensionSystemPrompt } from '@burtson-labs/stealth-core-runtime';
import { CliToolExecutionContext } from '../cliToolContext';
import { buildSystemPrompt } from '../systemPrompt';
import { evaluateRun } from './assertions';
import type {
  EvalReport,
  Fixture,
  FixtureResult,
  RunResult,
  ToolCallTrace
} from './types';

export interface RunnerProvider {
  kind: 'ollama' | 'bandit' | 'openai-compatible';
  model: string;
  settings: ProviderSettings;
  /** System-prompt variant to use for the agent loop. `cli` is the
   *  default and reflects what terminal users see. `extension` swaps in
   *  the VS Code extension's identity + operational prompt so we can
   *  run the same fixtures under both hosts and compare. */
  variant?: 'cli' | 'extension';
}

/**
 * Run a single fixture N times and report pass/fail.
 *
 * The sandbox workspace is recreated per run so state from a previous run
 * (e.g. a file the model wrote the first time) never influences the next
 * run — each attempt starts from the same ground truth the fixture defined.
 */
export async function runFixture(fixture: Fixture, provider: RunnerProvider): Promise<FixtureResult> {
  if (fixture.onlyProviders && !fixture.onlyProviders.includes(provider.kind)) {
    return {
      fixture,
      runs: [],
      passed: true,
      passRate: `skipped`,
      skipped: `fixture only runs against providers: ${fixture.onlyProviders.join(', ')}`
    };
  }

  const totalRuns = fixture.runs ?? 3;
  const threshold = fixture.passThreshold ?? Math.ceil(totalRuns / 2) + (totalRuns % 2 === 0 ? 0 : 0);
  // For N=3 that's 2, for N=1 that's 1 — majority-pass.

  const runs: RunResult[] = [];
  for (let i = 1; i <= totalRuns; i++) {
    const run = await runOnce(fixture, provider, i);
    runs.push(run);
  }

  const passCount = runs.filter(r => r.passed).length;
  return {
    fixture,
    runs,
    passed: passCount >= threshold,
    passRate: `${passCount}/${totalRuns}`
  };
}

async function runOnce(fixture: Fixture, provider: RunnerProvider, runNumber: number): Promise<RunResult> {
  const started = Date.now();
  const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), `bandit-eval-${fixture.id}-`));

  try {
    await applySetup(sandbox, fixture);

    const skillRegistry = createDefaultSkillRegistry();
    await registerWorkspaceSkills(
      skillRegistry,
      (pattern: string, cwd?: string) => listFilesGlob(pattern, cwd ?? sandbox),
      p => fs.promises.readFile(p, 'utf8'),
      sandbox
    ).catch(() => 0);

    const activeSkills = skillRegistry.resolveActiveSkills(fixture.prompt);
    const { registry } = skillRegistry.buildToolRegistryWithMap(activeSkills);

    // Sanity check: the registry produced by the skill path MUST include
    // the tools the system prompt tells the model to use. If this ever
    // fails, some skill manifest got trimmed and the extension will
    // silently hit `tool-not-found` — exactly the pburg-bowl regression
    // on Apr 21 2026 where apply_edit had been dropped from core-skill.
    // The eval used to defensively merge createCoreToolRegistry() in
    // here, which masked that bug; we removed the merge so the eval
    // exercises the same registration path as the extension.
    const REQUIRED_CORE_TOOLS = ['read_file', 'write_file', 'apply_edit', 'replace_range', 'list_files', 'search_code', 'run_command'];
    const missing = REQUIRED_CORE_TOOLS.filter(name => !registry.get(name));
    if (missing.length > 0) {
      throw new Error(
        `Eval runner: core tools missing from skill-resolved registry: ${missing.join(', ')}. ` +
        `This means a skill manifest dropped a tool the system prompt still references. ` +
        `Fix the skill manifest (likely packages/agent-core/src/tools/skills/core-skill.ts).`
      );
    }

    const memory = fixture.setup?.memory ?? '';
    const skillInstructions = activeSkills
      .filter(s => s.instructions)
      .map(s => `### ${s.name}\n${s.instructions}`)
      .join('\n\n');

    // Variant selection. The CLI path uses buildSystemPrompt and appends
    // memory + skill instructions. The extension path uses the shared
    // buildExtensionSystemPrompt — note that the extension's prompt has
    // its own operational-hints section, so we still append skills and
    // memory but we do NOT also layer the CLI prompt on top.
    let corePrompt: string;
    if (provider.variant === 'extension') {
      corePrompt = buildExtensionSystemPrompt({
        providerKind: provider.kind,
        modelId: provider.model
      });
      if (memory) corePrompt = `${corePrompt}\n\n## Project Memory\n\n${memory}`;
    } else {
      corePrompt = buildSystemPrompt(memory);
    }
    const systemPrompt = skillInstructions
      ? `${corePrompt}\n\n## Skill Instructions\n\n${skillInstructions}`
      : corePrompt;

    const toolCtx = new CliToolExecutionContext(sandbox, createDefaultLanguageAdapters());
    const chat = await buildChat(provider);

    const maxIterations = fixture.maxIterations ?? 8;
    const loop = new ToolUseLoop(registry, toolCtx, { maxIterations });

    const toolCalls: ToolCallTrace[] = [];
    let order = 0;
    let currentIteration = 0;

    const emitEvent = (type: string, payload?: unknown): void => {
      if (type === 'tool_loop:llm_start') {
        const p = payload as { iteration?: number };
        if (typeof p?.iteration === 'number') currentIteration = p.iteration;
      } else if (type === 'tool_loop:tool_execute') {
        const p = payload as { name?: string; params?: Record<string, string>; rawSnippet?: string };
        if (p?.name) {
          toolCalls.push({
            name: p.name,
            params: { ...(p.params ?? {}) },
            order: order++,
            iteration: currentIteration,
            isError: false,
            rawCallSnippet: p.rawSnippet
          });
        }
      } else if (type === 'tool_loop:tool_result') {
        const p = payload as { name?: string; isError?: boolean; outputSnippet?: string };
        const last = [...toolCalls].reverse().find(c => c.name === p?.name);
        if (last) {
          last.isError = !!p?.isError;
          if (p?.outputSnippet) last.outputSnippet = p.outputSnippet;
        }
      }
    };

    const seedMessages: ToolLoopMessage[] = [
      ...(fixture.priorMessages ?? []),
      { role: 'user', content: fixture.prompt }
    ];

    const result = await loop.runWithMessages(seedMessages, chat, systemPrompt, { emitEvent });

    const evalResult = evaluateRun(toolCalls, result.iterations, result.finalResponse, fixture.assertions);

    return {
      runNumber,
      passed: evalResult.passed,
      failureReasons: evalResult.reasons,
      toolCalls,
      iterations: result.iterations,
      hitLimit: result.hitLimit,
      finalResponse: result.finalResponse,
      wallTimeMs: Date.now() - started
    };
  } catch (err) {
    return {
      runNumber,
      passed: false,
      failureReasons: [`runner error: ${err instanceof Error ? err.message : String(err)}`],
      toolCalls: [],
      iterations: 0,
      hitLimit: false,
      finalResponse: '',
      wallTimeMs: Date.now() - started,
      error: err instanceof Error ? err.stack : String(err)
    };
  } finally {
    await fs.promises.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function applySetup(root: string, fixture: Fixture): Promise<void> {
  const setup = fixture.setup;
  if (!setup) return;

  for (const [relPath, content] of Object.entries(setup.files ?? {})) {
    const abs = path.join(root, relPath);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content, 'utf8');
  }

  if (setup.skills) {
    const skillsDir = path.join(root, '.bandit', 'skills');
    await fs.promises.mkdir(skillsDir, { recursive: true });
    for (const [name, content] of Object.entries(setup.skills)) {
      const ext = name.endsWith('.md') || name.endsWith('.json') ? '' : '.md';
      await fs.promises.writeFile(path.join(skillsDir, `${name}${ext}`), content, 'utf8');
    }
  }

  if (setup.memory) {
    await fs.promises.writeFile(path.join(root, 'BANDIT.md'), setup.memory, 'utf8');
  }
}

/**
 * Lightweight glob implementation for eval sandboxes. The CliToolExecutionContext
 * has its own (fast-glob-backed) implementation, but that resolves relative to
 * cwd set at construction time — we need to control the search root per-call
 * so the workspace-skills loader finds files even when the sandbox isn't the
 * process cwd. Keeping this minimal: only the two patterns the skill loader
 * actually asks for need to work.
 */
async function listFilesGlob(pattern: string, cwd: string): Promise<string[]> {
  const match = pattern.match(/^(.*?)\/(\*|\*\.md|\*\.json|\*\/SKILL\.md)$/);
  if (!match) return [];
  const [, relDir, leaf] = match;
  const absDir = path.join(cwd, relDir);
  try {
    if (leaf === '*/SKILL.md') {
      const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
      const results: string[] = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const candidate = path.join(relDir, e.name, 'SKILL.md');
        try {
          await fs.promises.access(path.join(cwd, candidate));
          results.push(candidate);
        } catch { /* SKILL.md absent is the common case */ }
      }
      return results;
    }
    const entries = await fs.promises.readdir(absDir);
    const ext = leaf.replace('*', '');
    return entries.filter(n => n.endsWith(ext)).map(n => path.join(relDir, n));
  } catch {
    return [];
  }
}

async function buildChat(provider: RunnerProvider): Promise<ChatFn> {
  const driver = await createProvider(provider.settings);
  return async function* (messages: ToolLoopMessage[]) {
    for await (const chunk of driver.chat({
      model: provider.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
      temperature: 0.2
    })) {
      const text = chunk.message?.content ?? '';
      if (text) yield text;
      if (chunk.done) break;
    }
  };
}

export interface RunFixturesOptions {
  /** Fires after each fixture resolves. Lets callers stream a live
   *  pass/fail line to stdout instead of waiting for the whole run
   *  to finish — crucial for a 9-fixture run at ~40s per fixture, where
   *  the prior "render everything at the end" behaviour meant 6 minutes
   *  of silence. */
  onFixtureComplete?: (result: FixtureResult, progress: { done: number; total: number }) => void;
  /** Fires once at the start, before any fixture runs. Intended for a
   *  banner ("Running N fixtures…"). */
  onStart?: (info: { total: number; provider: RunnerProvider }) => void;
}

/** Run a set of fixtures end-to-end and return the aggregate report. */
export async function runFixtures(
  fixtures: Fixture[],
  provider: RunnerProvider,
  options: RunFixturesOptions = {}
): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  options.onStart?.({ total: fixtures.length, provider });
  const results: FixtureResult[] = [];
  for (const fixture of fixtures) {
    const result = await runFixture(fixture, provider);
    results.push(result);
    options.onFixtureComplete?.(result, { done: results.length, total: fixtures.length });
  }
  return {
    provider: provider.kind,
    model: provider.model,
    variant: provider.variant ?? 'cli',
    fixtureResults: results,
    totalWallTimeMs: Date.now() - started,
    startedAt
  };
}

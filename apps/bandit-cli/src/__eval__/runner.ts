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
 *   - No interactive permission gate: tools are confined to the sandbox and anything outside
 *     it is auto-denied with a tool error (never awaited); each run has a wall-clock cap
 *   - No hooks (they're per-workspace and out of scope for behavioural evals)
 *   - No mention expansion, no semantic context, no session persistence —
 *     those are well-covered by the smoke test at the mechanical level.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ToolUseLoop,
  ToolRegistry,
  createDefaultSkillRegistry,
  createDefaultLanguageAdapters,
  registerWorkspaceSkills,
  type ChatFn,
  type ToolLoopMessage
} from '@burtson-labs/agent-core';
import {
  createProvider,
  getModelCapabilities,
  getModelBehaviorProfile,
  queryOllamaModelCapabilities,
  registerModelCapabilities,
  resolveOllamaRuntimeOptions,
  resolvePreferredToolProtocol,
  type ProviderSettings,
  buildExtensionSystemPrompt
} from '@burtson-labs/stealth-core-runtime';
import { EvalSandboxContext } from './sandboxContext';
import { buildSystemPrompt } from '../systemPrompt';
import { evaluateRun } from './assertions';
import { writeRunTrace } from './traceOut';
import type {
  EvalReport,
  EvalRuntimeInfo,
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
  /** When set, each run's full transcript is written here as a canonical training example. */
  traceOut?: string;
  /** Tools removed from every fixture's registry (eval --exclude-tools). */
  excludeTools?: string[];
  /** Wall-clock cap per run in ms (eval --run-timeout); default 300 s. Nothing may hang an eval. */
  runTimeoutMs?: number;
  /** run_command / watch_command calls whose command line matches are refused (eval --command-deny). */
  commandDeny?: RegExp;
  /** Test seam: use this chat function instead of building one from `settings`. */
  chat?: ChatFn;
}

export const DEFAULT_RUN_TIMEOUT_MS = 300_000;
/** A single model call that streams more than this is degenerate (repetition); stop it. */
const MAX_CHARS_PER_CALL = 60_000;
/** Compaction budget for providers whose window we do not control — same constant as the CLI. */
const HOSTED_NUM_CTX = 32768;

/**
 * How production would drive this model: tool channel, context window, per-model loop
 * limits. Resolved once per provider, after registering what Ollama reports about the
 * model — the CLI does the same probe at startup (cli.ts probeOllamaCapabilities). Without
 * it a model that has no built-in profile (qwen3:8b, gpt-oss:20b, qwen3-coder:30b, any
 * fine-tune) fell back to an 8192-token window, smaller than the system prompt plus the
 * tool schemas, and the benchmark measured prompt truncation instead of the model.
 */
export interface ModelRuntime extends EvalRuntimeInfo {
  messageTokenBudget: number;
  outputBudgetTokens: number;
  maxParallelTools: number;
  nativeToolFailureFallback: boolean;
  compactToolBlock: boolean;
  supportsVision: boolean;
}

const runtimeByProvider = new WeakMap<RunnerProvider, Promise<ModelRuntime>>();

export function resolveModelRuntime(provider: RunnerProvider): Promise<ModelRuntime> {
  let pending = runtimeByProvider.get(provider);
  if (!pending) {
    pending = buildModelRuntime(provider);
    runtimeByProvider.set(provider, pending);
  }
  return pending;
}

async function buildModelRuntime(provider: RunnerProvider): Promise<ModelRuntime> {
  if (provider.kind === 'ollama' && !provider.chat) {
    const base = (provider.settings.ollamaUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    const probed = await queryOllamaModelCapabilities(provider.model, base);
    // Built-in profiles still win inside getModelCapabilities; this only fills the gap for
    // models the table does not know.
    if (probed) registerModelCapabilities(provider.model, probed);
  }
  const caps = getModelCapabilities(provider.model);
  const behavior = getModelBehaviorProfile(provider.model);
  const numCtx = provider.kind === 'ollama' ? resolveOllamaRuntimeOptions(provider.model).num_ctx : undefined;
  return {
    nativeTools: caps.supportsToolCalling && resolvePreferredToolProtocol(provider.model) === 'native-tools',
    numCtx,
    tier: caps.tier,
    messageTokenBudget: Math.floor((numCtx ?? HOSTED_NUM_CTX) * 0.75),
    outputBudgetTokens: behavior.context.outputBudgetTokens,
    maxParallelTools: behavior.reliability.maxParallelTools,
    nativeToolFailureFallback: behavior.protocol.nativeToolFailureFallback !== false,
    compactToolBlock: caps.tier === 'small',
    supportsVision: caps.supportsVision
  };
}

/**
 * The system prompt and native tool schemas are sent on every call. When they alone do
 * not fit the window the model will be loaded with, Ollama drops the oldest messages
 * (the user's request goes first) and every result is an artifact of that. Returns a
 * message when the run must not go ahead. Estimate: 4 chars per token, which
 * under-counts for this prompt (measured 4.4), so the check errs towards running.
 */
export function contextWindowProblem(systemPromptChars: number, toolSchemaChars: number, numCtx: number | undefined): string | null {
  if (!numCtx) return null;
  const needed = Math.ceil((systemPromptChars + toolSchemaChars) / 4);
  if (needed <= numCtx * 0.85) return null;
  return `the system prompt and tool schemas need about ${needed} tokens but the model would be loaded with a ${numCtx}-token ` +
    'context window (num_ctx), so the conversation would be truncated before the model sees it. ' +
    'Register a capability profile for this model or raise its context window; results from this configuration would not measure the model.';
}

const COMMAND_TOOLS = new Set(['run_command', 'watch_command']);

/** Wrap command tools so denied command lines return an error instead of running. */
export function withCommandDeny(registry: ToolRegistry, deny: RegExp): ToolRegistry {
  const wrapped = registry.getAll().map(tool => {
    if (!COMMAND_TOOLS.has(tool.name)) return tool;
    const guarded = Object.create(tool) as typeof tool;
    guarded.execute = async (params, ctx) => {
      const line = [params.cmd, params.command, params.args].filter(Boolean).join(' ');
      deny.lastIndex = 0;
      if (deny.test(line)) {
        return { output: 'ERROR: blocked in this sandbox: remote, deploy, publish, global-install and network-mutating commands are not allowed here.', isError: true };
      }
      return tool.execute(params, ctx);
    };
    return guarded;
  });
  return new ToolRegistry().registerAll(wrapped);
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
  let denials: string[] = [];

  try {
    if (fixture.sourceDir) {
      execFileSync('git', ['clone', '--quiet', '--no-hardlinks', fixture.sourceDir, sandbox], { stdio: 'ignore' });
      for (const remote of execFileSync('git', ['-C', sandbox, 'remote'], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
        execFileSync('git', ['-C', sandbox, 'remote', 'remove', remote], { stdio: 'ignore' });
      }
    }
    await applySetup(sandbox, fixture);
    const runtime = await resolveModelRuntime(provider);

    const skillRegistry = createDefaultSkillRegistry();
    await registerWorkspaceSkills(
      skillRegistry,
      (pattern: string, cwd?: string) => listFilesGlob(pattern, cwd ?? sandbox),
      p => fs.promises.readFile(p, 'utf8'),
      sandbox
    ).catch(() => 0);

    const activeSkills = skillRegistry.resolveActiveSkills(fixture.prompt);
    let { registry } = skillRegistry.buildToolRegistryWithMap(activeSkills);

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

    const excluded = new Set([...(fixture.excludeTools ?? []), ...(provider.excludeTools ?? [])]);
    if (excluded.size > 0) {
      const kept = registry.getAll().filter(tool => !excluded.has(tool.name));
      registry = new ToolRegistry().registerAll(kept);
    }
    if (provider.commandDeny) registry = withCommandDeny(registry, provider.commandDeny);

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
      // Same options the CLI passes, so a large-tier model gets the trimmed prompt it gets
      // in production instead of the small-model one.
      corePrompt = buildSystemPrompt(memory, {
        modelId: provider.model,
        supportsVision: runtime.supportsVision,
        userGoal: fixture.prompt
      });
    }
    const systemPrompt = skillInstructions
      ? `${corePrompt}\n\n## Skill Instructions\n\n${skillInstructions}`
      : corePrompt;

    const toolSchemaChars = runtime.nativeTools ? JSON.stringify(registry.buildNativeToolsSchema()).length : 0;
    const windowProblem = contextWindowProblem(systemPrompt.length, toolSchemaChars, runtime.numCtx);
    if (windowProblem) throw new Error(windowProblem);

    const toolCtx = new EvalSandboxContext(sandbox, createDefaultLanguageAdapters());
    denials = toolCtx.denials;
    const rawChat = provider.chat ?? await buildChat(provider);
    const abort = new AbortController();
    const timeoutMs = provider.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    let timedOut = false;
    let degenerate = false;
    // Count every streamed char so the run carries an approx output-token
    // figure (chars/4, tool markup included — it's real generated cost).
    let chunkChars = 0;
    const chat: typeof rawChat = async function* (messages, tools, options) {
      let callChars = 0;
      for await (const chunk of rawChat(messages, tools, options)) {
        if (abort.signal.aborted) return;
        chunkChars += chunk.length;
        callChars += chunk.length;
        yield chunk;
        if (callChars > MAX_CHARS_PER_CALL) {
          degenerate = true;
          return;
        }
      }
    };

    const maxIterations = fixture.maxIterations ?? 8;
    // Production tool channel and per-model loop limits (see resolveModelRuntime): benching
    // bandit-core-2 on the text XML block it never sees in real turns made it
    // answer "I don't have access to your file system"; qwen3-coder's Ollama
    // template outright 500s (EOF) when XML markup streams through content.
    const loop = new ToolUseLoop(registry, toolCtx, {
      maxIterations,
      nativeTools: runtime.nativeTools,
      nativeToolFailureFallback: runtime.nativeToolFailureFallback,
      outputBudgetTokens: runtime.outputBudgetTokens,
      maxParallelTools: runtime.maxParallelTools,
      compactToolBlock: runtime.compactToolBlock
    });

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

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
        reject(new Error(`run exceeded the ${Math.round(timeoutMs / 1000)} s wall-clock cap`));
      }, timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([
      loop.runWithMessages(seedMessages, chat, systemPrompt, {
        emitEvent,
        signal: abort.signal,
        messageTokenBudget: runtime.messageTokenBudget
      }),
      deadline
    ]).finally(() => clearTimeout(timer));

    const finalFiles: Record<string, string | null> = {};
    for (const rel of Object.keys(fixture.assertions.finalFiles ?? {})) {
      finalFiles[rel] = await fs.promises.readFile(path.join(sandbox, rel), 'utf8').catch(() => null);
    }
    const evalResult = evaluateRun(toolCalls, result.iterations, result.finalResponse, fixture.assertions, finalFiles);
    // Auto-denied out-of-workspace access and runaway generations fail the run, visibly.
    for (const d of toolCtx.denials) {
      evalResult.passed = false;
      evalResult.reasons.push(`permission auto-denied (non-interactive): ${d} is outside the workspace`);
    }
    if (degenerate) {
      evalResult.passed = false;
      evalResult.reasons.push(`a single model call streamed over ${MAX_CHARS_PER_CALL} chars (degenerate output); cut off`);
    }
    if (timedOut) {
      evalResult.passed = false;
      evalResult.reasons.push(`run exceeded the ${Math.round(timeoutMs / 1000)} s wall-clock cap`);
    }

    if (provider.traceOut) {
      await writeRunTrace(provider.traceOut, {
        fixtureId: fixture.id,
        runNumber,
        model: provider.model,
        systemPrompt,
        tools: registry.buildNativeToolsSchema(),
        messages: result.messages,
        hitLimit: result.hitLimit,
        passed: evalResult.passed,
        failureReasons: evalResult.reasons,
        workspaceRoot: sandbox
      }).catch(err => process.stderr.write(`bandit eval: trace-out failed: ${err instanceof Error ? err.message : String(err)}\n`));
    }

    return {
      runNumber,
      passed: evalResult.passed,
      failureReasons: evalResult.reasons,
      toolCalls,
      iterations: result.iterations,
      hitLimit: result.hitLimit,
      finalResponse: result.finalResponse,
      wallTimeMs: Date.now() - started,
      approxTokens: Math.round(chunkChars / 4)
    };
  } catch (err) {
    return {
      runNumber,
      passed: false,
      failureReasons: [
        `runner error: ${err instanceof Error ? err.message : String(err)}`,
        ...denials.map(d => `permission auto-denied (non-interactive): ${d} is outside the workspace`)
      ],
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
  return async function* (messages: ToolLoopMessage[], tools) {
    for await (const chunk of driver.chat({
      model: provider.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
      temperature: 0.2,
      // Native-tools mode: the loop passes schemas on every call; forward
      // them so the provider routes to Ollama's native `tools` field and
      // translates returned tool_calls back into inline markup — the same
      // path the REPL uses (cliChatFn types this `unknown` for the same
      // structural-compat reason).
      tools: tools as never
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
  /** Fixtures run in parallel up to this many at once (default 1). Runs of one fixture stay sequential. */
  concurrency?: number;
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
  const results: FixtureResult[] = new Array(fixtures.length);
  let done = 0;
  let next = 0;
  const workers = Math.max(1, Math.min(options.concurrency ?? 1, fixtures.length));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < fixtures.length) {
      const index = next++;
      const result = await runFixture(fixtures[index], provider);
      results[index] = result;
      done++;
      options.onFixtureComplete?.(result, { done, total: fixtures.length });
    }
  }));
  const runtime = await resolveModelRuntime(provider);
  return {
    provider: provider.kind,
    model: provider.model,
    variant: provider.variant ?? 'cli',
    fixtureResults: results,
    totalWallTimeMs: Date.now() - started,
    startedAt,
    runtime: { nativeTools: runtime.nativeTools, numCtx: runtime.numCtx, tier: runtime.tier }
  };
}

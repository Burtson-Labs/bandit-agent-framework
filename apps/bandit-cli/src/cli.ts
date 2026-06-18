#!/usr/bin/env node
/**
 * bandit — terminal host for the Bandit agent framework.
 *
 * Usage:
 * bandit "explain the auth flow" one-shot: run a single prompt
 * bandit REPL: interactive session
 * bandit --resume <id> resume a prior session
 * bandit --session <id> start (or continue) a named session
 * bandit --help show usage
 *
 * Environment:
 * BANDIT_PROVIDER "ollama" (default) or "bandit"
 * BANDIT_MODEL e.g. "gemma3:12b"
 * BANDIT_API_KEY required when provider=bandit
 * BANDIT_API_URL override for the Bandit API
 * OLLAMA_URL Ollama endpoint (default http://localhost:11434)
 * BANDIT_MAX_ITERATIONS default 20
 * BANDIT_AUTO_APPROVE if "1"/"true", skip write-approval prompts
 * NO_COLOR disable ANSI colors
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import * as cp from 'child_process';
import {
  createDefaultSkillRegistry,
  createDefaultLanguageAdapters,
  createToolUseLoop,
  registerWorkspaceSkills,
  planSkill,
  interactionSkill,
  McpClientPool,
  getAllMcpAgentTools,
  fingerprintServerConfig,
  redactSecretsString,
  type ChatFn,
  type ToolLoopMessage,
  type SkillRegistry
} from '@burtson-labs/agent-core';
import {
  createProvider,
  getModelCapabilities,
  resolveDefaultMaxIterations,
  getModelBehaviorProfile,
  registerModelCapabilities,
  clearModelBehaviorOverrides,
  registerModelBehaviorConfig,
  queryModelsDevCapabilities,
  queryOpenAICompatibleModelInfo,
  queryOllamaModelCapabilities,
  resolveOllamaRuntimeOptions,
  resolvePreferredToolProtocol,
  checkOllamaLoadedContext,
  type ProviderKind,
  type ProviderSettings
} from '@burtson-labs/stealth-core-runtime';
import { PasteBuffer } from './input/pasteBuffer';
import { createInkLineInterface, type InkLineInterface } from './input/inkInterface';
import { CliToolExecutionContext, expandHome } from './cliToolContext';
import { readClipboardImage } from './clipboardImage';
import { openFilePicker } from './filePicker';
import { pdfReadTool } from './pdfTool';
import { c, glyph, banner, launchBanner, divider, skillLine, toolLine, errorLine, setActiveTheme, linkify, THEME_NAMES, supportsTrueColor, supportsBlockArt, downsampleTruecolorTo256 } from './ansi';
import { Spinner, StreamFooter, renderTodoTree } from './spinner';
import { renderDiff, renderAppliedDiff } from './diff';
import { resolveLang, highlightCode } from './syntaxHighlight';
import { SessionStore } from './session';
import { buildSystemPrompt } from './systemPrompt';
import { promptPermission, formatDenialReason } from './permissionPrompt';
import { promptAskUser } from './askUserPrompt';
import { looksLikeYesNoQuestion } from './heuristics/yesNoDetect';
import {
  type StreamStrippingState,
  flushStreamChunkBuffer,
  consumeStreamChunk,
  createStreamStrippingState
} from './streaming/streamStripping';
import { consumeTablesInChunk, flushTableState } from './terminal/tableRender';
import { consumeMarkdownInChunk, flushMarkdownState } from './terminal/markdownRender';
import { fuzzyMatchWorkspaceFiles } from './input/fileCompleter';
import { buildCliChatFn } from './agent/cliChatFn';
import { loadConfigFiles, resolveConfig, describeConfig, saveTheme, readTavilyKey, type ConfigOverrides, type ResolvedConfig } from './config';
import { initTelemetry, resolveTelemetryConfig, telemetryStartTurn, telemetryEvent, telemetryEndTurn, telemetryEndTurnAwait } from './telemetry/otlp';
import { notifyCli, type CliNotification } from './notifications';
import {
  expandMentions,
  loadCombinedMemory,
  loadHookSettings,
  persistAllowEntry,
  runHooks,
  buildTodoWriteTool,
  buildWebFetchTool,
  buildWebSearchTool,
  buildRememberTool,
  buildReadMemoryTool,
  buildTestRunTool,
  registerMcpServersFromDisk,
  loadApprovedMcpFingerprints,
  approveMcpFingerprint,
  loadMcpToolCache,
  saveMcpToolEntry,
  pruneMcpToolCache,
  revokeMcpFingerprint,
  persistMcpActivation,
  addMcpServerToConfig,
  buildGitHubServerConfig,
  looksLikeGitHubToken,
  buildSlackServerConfig,
  buildGitLabServerConfig,
  buildGmailServerConfig,
  buildCustomServerConfig,
  buildTaskTool,
  buildCheckTaskTool,
  buildListTasksTool,
  InMemoryBackgroundTaskStore,
  type BackgroundTaskStore,
  type BackgroundTaskRecord,
  TodoStore,
  SessionPermissionStore,
  evaluatePermission,
  mergePolicies,
  openTurnLog,
  previewText,
  listInstalledOllamaModels,
  suggestOllamaMatch,
  CheckpointStore,
  evaluateSecurityGuard,
  type HookSettings
} from '@burtson-labs/host-kit';
import {
  findSlashCommand,
  type SlashContext
} from './slashCommands';
import { writeInsightsReport } from '@burtson-labs/host-kit';

interface CliArgs {
  prompt: string | null;
  help: boolean;
  version: boolean;
  resume: string | null;
  session: string | null;
  overrides: ConfigOverrides;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prompt: null,
    help: false,
    version: false,
    resume: null,
    session: null,
    overrides: {}
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
    else if (a === '--resume') args.resume = argv[++i] ?? null;
    else if (a === '--session') args.session = argv[++i] ?? null;
    else if (a === '--provider') {
      const next = argv[++i];
      if (next === 'ollama' || next === 'bandit' || next === 'openai-compatible') args.overrides.provider = next;
    }
    else if (a === '--model') args.overrides.model = argv[++i] ?? undefined;
    else if (a === '--api-key') args.overrides.apiKey = argv[++i] ?? undefined;
    else if (a === '--api-url') args.overrides.apiUrl = argv[++i] ?? undefined;
    else if (a === '--ollama-url') args.overrides.ollamaUrl = argv[++i] ?? undefined;
    else if (a === '--openai-base-url') args.overrides.openaiBaseUrl = argv[++i] ?? undefined;
    else if (a === '--openai-api-key') args.overrides.openaiApiKey = argv[++i] ?? undefined;
    else if (a === '--openai-model') args.overrides.openaiModel = argv[++i] ?? undefined;
    else if (a === '--ink') process.env.BANDIT_INK_INPUT = '1';
    else if (a === '--no-ink') process.env.BANDIT_INK_INPUT = '0';
    else positional.push(a);
  }
  if (positional.length > 0) args.prompt = positional.join(' ');
  return args;
}

function printUsage(): void {
  process.stdout.write(`${banner('bandit', 'terminal host for the Bandit agent framework')}

${c.bold('Usage')}
  bandit "<prompt>"           Run a single prompt to completion
  bandit                      Start an interactive REPL
  bandit --resume <id>        Resume a prior session (see /session list)
  bandit --session <id>       Start / continue a named session
  bandit --help               Show this message
  bandit --version            Show version
  bandit --no-ink             Fall back to the legacy readline input (or set BANDIT_INK_INPUT=0)

${c.bold('Provider flags (override env + config files)')}
  --provider <ollama|bandit|openai-compatible>
  --model <name>
  --ollama-url <url>          e.g. https://ollama.example.com
  --api-key <key>             for provider=bandit
  --api-url <url>             for provider=bandit
  --openai-base-url <url>     for provider=openai-compatible — e.g. http://localhost:1234/v1
  --openai-api-key <key>      bearer token for the openai-compatible endpoint
  --openai-model <name>       model id (provider-specific naming)

${c.bold('Config files (precedence: flag > env > workspace > global)')}
  ~/.bandit/config.json       global user defaults (good home for API keys)
  .bandit/config.json         workspace-local (commit-safe without secrets)
  .bandit/config.local.json   workspace-local, typically .gitignored
  Shape: { "provider", "model", "ollama": { "url", "headers" }, "bandit": { "apiKey", "apiUrl" }, "openai": { "baseUrl", "apiKey", "model", "headers" } }

${c.bold('Environment')}
  BANDIT_PROVIDER        ollama (default) | bandit | openai-compatible
  BANDIT_MODEL           model name
  BANDIT_API_KEY         required when provider=bandit
  BANDIT_API_URL         override Bandit API URL
  OLLAMA_URL             Ollama endpoint (default: http://localhost:11434)
  OPENAI_BASE_URL        e.g. http://localhost:1234/v1, https://api.together.xyz/v1
  OPENAI_API_KEY         bearer token (LM Studio / llama.cpp can usually skip)
  OPENAI_MODEL           upstream-specific model id
  BANDIT_MAX_ITERATIONS  tool-use loop cap (default: 20, or 40 for Kimi/bandit-logic-2)
  BANDIT_AUTO_APPROVE    "1" to skip write-approval prompts
  NO_COLOR               disable ANSI color output

${c.bold('Inside the REPL')}
  /help                       list slash commands
  /doctor                     check setup, permissions, context, and next actions
  /clear                      reset conversation
  /config                     show effective config (secrets redacted)
  /model <name>               switch model
  /skills                     list loaded skills
  /skill new <name>           scaffold a new markdown skill in .bandit/skills
  /session list|resume|new    manage sessions
  /memory                     show auto-loaded BANDIT.md / CLAUDE.md
  /plan <goal>                produce a plan without burning LLM tokens
  /exit                       quit

${c.bold('Tips')}
  • ${c.cyan('@src/foo.ts')} in your prompt auto-inlines the file contents
  • Drop ${c.cyan('.bandit/skills/*.md')} into your workspace for custom skills (see ${c.cyan('/skill new')})
  • Drop ${c.cyan('.bandit/settings.json')} for PreToolUse / PostToolUse / Stop hooks
  • Drop ${c.cyan('.bandit/model-profiles.json')} to tune behavior profiles for custom local models
`);
}

async function loadWorkspaceModelBehaviorProfiles(workspaceRoot: string): Promise<void> {
  clearModelBehaviorOverrides();
  const configPath = path.join(workspaceRoot, '.bandit', 'model-profiles.json');
  let raw: string;
  try {
    raw = await fs.promises.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(c.yellow(`  ${glyph.warn} could not read .bandit/model-profiles.json: ${err instanceof Error ? err.message : String(err)}\n`));
    }
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(c.yellow(`  ${glyph.warn} ignoring .bandit/model-profiles.json: invalid JSON (${err instanceof Error ? err.message : String(err)})\n`));
    return;
  }

  const result = registerModelBehaviorConfig(parsed);
  if (result.errors.length > 0) {
    process.stderr.write(c.yellow(`  ${glyph.warn} ignoring .bandit/model-profiles.json: ${result.errors.join('; ')}\n`));
    return;
  }
  if (result.warnings.length > 0) {
    process.stderr.write(c.yellow(`  ${glyph.warn} .bandit/model-profiles.json loaded with warnings: ${result.warnings.slice(0, 2).join('; ')}${result.warnings.length > 2 ? '…' : ''}\n`));
  } else if (process.env.BANDIT_DEBUG) {
    process.stderr.write(c.dim(`  ${glyph.info} loaded ${result.entries.length} model behavior profile override${result.entries.length === 1 ? '' : 's'}\n`));
  }
}

function permissionTitle(name: string): string {
  if (name === 'run_command') return 'Run a shell command';
  if (name === 'write_file') return 'Write a file';
  if (name === 'apply_edit') return 'Apply a targeted edit';
  if (name === 'replace_range') return 'Replace a line range';
  if (name === 'apply_patch') return 'Apply a patch';
  if (name === 'task') return 'Spawn a subagent';
  if (name.startsWith('git_')) return 'Run a Git operation';
  if (name === 'test_run' || name === 'run_tests') return 'Run tests';
  if (name === 'web_fetch' || name === 'web_search') return 'Fetch external context';
  if (name === 'remember') return 'Update project memory';
  return `Use ${name}`;
}

function permissionRisk(name: string, params: Record<string, string>): string {
  if (name === 'write_file' || name === 'apply_edit' || name === 'replace_range' || name === 'apply_patch') {
    return 'Modifies files. Review the preview before approving.';
  }
  if (name === 'run_command') {
    const full = `${params.cmd ?? ''} ${params.args ?? ''}`.trim();
    if (/\b(rm|dd|mkfs|chmod|chown|sudo)\b|\b--force\b|\b-f\b/.test(full)) {
      return 'High impact shell command. Check the command and working directory carefully.';
    }
    if (/\b(npm|pnpm|yarn|bun|pip|cargo|go)\b.*\b(install|add|update|upgrade)\b/i.test(full)) {
      return 'May change dependencies or install packages.';
    }
    if (/^git\s+(push|commit|reset|checkout|clean|rebase|merge)\b/i.test(full)) {
      return 'Changes Git state or history. Confirm this is intended.';
    }
    return 'Runs in your shell with your local permissions.';
  }
  if (name === 'task') return 'Starts a focused agent with its own context and tool calls.';
  if (name.startsWith('git_')) return 'Reads or changes Git state depending on the operation.';
  if (name === 'web_fetch' || name === 'web_search') return 'May contact the network and include fetched text in context.';
  return 'Bandit is asking before using this capability.';
}

function renderPermissionContext(name: string, params: Record<string, string>, cwd: string, displayPrimary: string, primary: string): void {
  const title = permissionTitle(name);
  process.stdout.write(c.accent('╭── ') + c.yellow(c.bold(`${glyph.warn} ACTION NEEDED`)) + c.accent(' · ') + c.bold(title) + '\n');
  const target = displayPrimary || primary;
  if (target) {
    const cols = process.stdout.columns || 80;
    const targetLine = target.length > cols - 8 ? target.slice(0, cols - 11) + '...' : target;
    process.stdout.write(c.accent('│ ') + c.dim('target: ') + c.cyan(targetLine) + '\n');
  }
  if (name === 'run_command') {
    const rawCwd = params.cwd ? expandHome(params.cwd) : cwd;
    const absCwd = path.isAbsolute(rawCwd) ? rawCwd : path.resolve(cwd, rawCwd);
    const displayCwd = absCwd.startsWith(os.homedir() + path.sep)
      ? '~/' + absCwd.slice(os.homedir().length + 1)
      : absCwd;
    process.stdout.write(c.accent('│ ') + c.dim('cwd:    ') + c.cyan(displayCwd) + '\n');
  }
  process.stdout.write(c.accent('│ ') + c.dim('risk:   ') + permissionRisk(name, params) + '\n');
  process.stdout.write(c.accent('│ ') + c.dim('scope:  ') + c.dim('once = only this call · session = all ') + c.cyan(name) + c.dim(' calls until exit') + '\n');
  process.stdout.write(c.accent('│ ') + c.dim('        ') + c.dim('always = save this target · deny + note = tell Bandit what to try instead') + '\n');
}

interface ProviderBundle {
  settings: ProviderSettings;
  model: string;
  kind: ProviderKind;
  /** True when the effective model was picked by the user (flag/env/config).
   * Drives the auto-switch behavior at startup — if true, a missing model
   * errors out; if false, we silently pick the closest installed variant. */
  modelWasExplicit: boolean;
  config: ResolvedConfig;
}

/**
 * Turn a ResolvedConfig into the ProviderSettings the runtime consumes.
 * Also enforces the "bandit provider requires an api key" invariant.
 */
function buildProviderSettings(cfg: ResolvedConfig): ProviderBundle {
  const kind = cfg.provider;
  if (kind === 'bandit' && !cfg.apiKey) {
    throw new Error('BANDIT_API_KEY (or bandit.apiKey in ~/.bandit/config.json) is required when provider=bandit');
  }
  if (kind === 'openai-compatible' && !cfg.openaiBaseUrl) {
    throw new Error('OPENAI_BASE_URL (or openai.baseUrl in ~/.bandit/config.json) is required when provider=openai-compatible. Examples: http://localhost:1234/v1 (LM Studio), http://localhost:8080/v1 (llama.cpp / vLLM), https://api.together.xyz/v1, https://openrouter.ai/api/v1, https://api.openai.com/v1.');
  }
  if (kind === 'openai-compatible' && !cfg.model) {
    throw new Error('--openai-model (or OPENAI_MODEL / openai.model / --model) is required when provider=openai-compatible. Each upstream uses its own model id (e.g. "meta-llama/Llama-3.3-70B-Instruct-Turbo" on Together, "openai/gpt-4o" on OpenRouter, your local model name on LM Studio).');
  }
  const settings: ProviderSettings = {
    kind,
    apiKey: cfg.apiKey,
    apiUrl: cfg.apiUrl,
    ollamaUrl: cfg.ollamaUrl,
    ollamaModel: kind === 'ollama' ? cfg.model : undefined,
    ollamaHeaders: kind === 'ollama' && Object.keys(cfg.ollamaHeaders).length > 0 ? cfg.ollamaHeaders : undefined,
    openaiBaseUrl: kind === 'openai-compatible' ? cfg.openaiBaseUrl : undefined,
    openaiApiKey: kind === 'openai-compatible' ? cfg.openaiApiKey : undefined,
    openaiModel: kind === 'openai-compatible' ? cfg.model : undefined,
    openaiHeaders: kind === 'openai-compatible' && Object.keys(cfg.openaiHeaders).length > 0 ? cfg.openaiHeaders : undefined
  };
  return {
    settings,
    model: cfg.model,
    kind,
    modelWasExplicit: cfg.modelWasExplicit,
    config: cfg
  };
}

type OllamaCheck =
  | { ok: true; model: string; autoSwitched?: boolean; fromModel?: string }
  | { ok: false; message: string };

/**
 * Validate the configured Ollama model is actually pulled locally.
 *
 * If the model is missing and `allowAutoSwitch` is true (i.e. the user did NOT
 * pick the model explicitly), we auto-pick the closest installed match so the
 * user doesn't have to know about `-it-qat` / `-it-q4_K_M` suffix variants.
 * If the user DID set BANDIT_MODEL, we fail with suggestions instead.
 */
async function validateOllamaModel(
  model: string,
  ollamaUrl: string,
  allowAutoSwitch: boolean
): Promise<OllamaCheck> {
  const base = (ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const models = await listInstalledOllamaModels(base);
  if (models.length === 0) {
    // listInstalledOllamaModels returns [] on network failure OR empty
    // library. Probe /api/tags directly so we can distinguish and give
    // the user a useful error.
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) {
        return { ok: false, message: `Ollama responded ${res.status} ${res.statusText} at ${base}. Is it running? Try: ollama serve` };
      }
      // Empty library.
      return {
        ok: false,
        message: `No models pulled on ${base}.\n  ${c.cyan('ollama pull ' + model)}   pull the requested model`
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Could not reach Ollama at ${base}: ${msg}\nIs Ollama running? Try: ${c.cyan('ollama serve')}` };
    }
  }
  const installed = models.map((m) => m.name);
  if (installed.some((n) => n === model || n.startsWith(`${model}:`))) {
    return { ok: true, model };
  }
  const suggestions = suggestOllamaMatch(model, installed);
  if (allowAutoSwitch && suggestions.length > 0) {
    return { ok: true, model: suggestions[0], autoSwitched: true, fromModel: model };
  }
  const lines = [
    `Model "${model}" is not pulled on ${base}.`,
    suggestions.length
      ? `Close matches you have:\n  ${suggestions.map((s) => c.accent(s)).join('\n  ')}`
      : `You have these models installed:\n  ${installed.slice(0, 10).map((s) => c.accent(s)).join('\n  ')}`,
    '',
    'Options:',
    `  ${c.cyan('ollama pull ' + model)}   pull the requested model`,
    `  ${c.cyan('BANDIT_MODEL=<name> bandit ...')}   use a different model`,
    `  ${c.cyan('/model')}                        browse installed models in the REPL`
  ];
  return { ok: false, message: lines.join('\n') };
}

// suggestOllamaModels previously lived here — moved to
// @burtson-labs/host-kit (ollamaModels.ts) so the VS Code extension
// and CLI give identical match rankings.

// buildSystemPrompt lives in ./systemPrompt.ts so the eval harness can import
// the exact prompt the user sees without triggering cli.ts's main() side-effect.

/**
 * A 'getLine' function — reads a single line of user input. In one-shot
 * mode we create a fresh readline; in REPL mode the host injects a
 * resolver that hooks into the main readline interface so stdin isn't
 * consumed by two listeners simultaneously (which would cause a typed
 * "2" to fire the permission answer AND re-trigger as a new prompt).
 *
 * `bypassQueue` flag (added 2026-05-26): sub-flows like the permission
 * picker's "deny + note" follow-up need FRESH user input, not whatever
 * was sitting in the lineQueue from earlier mid-turn typing. Without
 * the flag, replGetLine() would happily consume a queued "also do Y"
 * as the denial reason and the actual typed note would land in the
 * queue as a new prompt. Callers that want fresh input pass true;
 * the default (no flag) preserves the original queue-then-fresh
 * fallthrough used by the normal prompt cycle.
 */
export type GetLineFn = (opts?: { bypassQueue?: boolean }) => Promise<string>;



const defaultGetLine: GetLineFn = () => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.once('line', (line) => { rl.close(); resolve(line); });
});

async function loadSkills(cwd: string): Promise<SkillRegistry> {
  const registry = createDefaultSkillRegistry();
  // The ask_user tool only makes sense with an interactive surface to render
  // the prompt on, so register it only for TTY sessions. Piped/CI runs keep
  // the tool out of the prompt entirely (the wired callback is also TTY-gated).
  if (process.stdin.isTTY) {
    registry.register(interactionSkill);
  }
  const tmpCtx = new CliToolExecutionContext(cwd, createDefaultLanguageAdapters());
  await registerWorkspaceSkills(
    registry,
    (pattern, dir) => tmpCtx.listFiles(pattern, dir),
    (p) => fs.promises.readFile(p, 'utf-8'),
    cwd
  ).catch(() => 0);
  return registry;
}

/**
 * Per-file entry in the session-scoped read cache. `readAt` lets the
 * formatter render "(read 4m ago)" relative to the new turn's
 * timestamp; `mtimeMs` snapshots the file's mtime AT read time so a
 * later turn can detect whether the file changed on disk since the
 * cached read (we mark stale entries explicitly so the model knows to
 * re-read instead of trusting its in-context copy); `bytes` shows
 * size so the model can decide between "I already have this" and
 * "I have a stale read of a now-bigger file".
 */
interface RecentReadEntry {
  readAt: number;
  mtimeMs: number;
  bytes: number;
}

/**
 * Render the "## Already read this session" block that gets appended
 * to the system prompt. Returns empty string when the cache is empty
 * so the prompt assembly drops the section cleanly. Caps at 12 most-
 * recent entries to keep the block bounded on long sessions.
 *
 * Each line is stat-checked against the current mtime; if the file
 * changed on disk since the cached read OR the file no longer exists,
 * we drop the entry (re-read will populate it fresh on next call).
 * Otherwise the line is "- path (read N ago, X chars)".
 */
function buildRecentReadsAddendum(cache: Map<string, RecentReadEntry> | undefined): string {
  if (!cache || cache.size === 0) return '';
  const now = Date.now();
  const entries: { path: string; readAt: number; bytes: number; label: string }[] = [];
  for (const [absPath, entry] of cache) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      // File was deleted / moved. Drop the cache entry so future
      // recall doesn't claim we have content for a path that no
      // longer exists.
      cache.delete(absPath);
      continue;
    }
    if (Math.abs(stat.mtimeMs - entry.mtimeMs) > 1) {
      // File changed since we cached. Drop so the model re-reads
      // instead of trusting the stale in-context copy.
      cache.delete(absPath);
      continue;
    }
    const ageMs = now - entry.readAt;
    const ageLabel = ageMs < 60_000
      ? `${Math.max(1, Math.round(ageMs / 1000))}s ago`
      : ageMs < 3_600_000
        ? `${Math.round(ageMs / 60_000)}m ago`
        : `${Math.round(ageMs / 3_600_000)}h ago`;
    const sizeLabel = entry.bytes >= 1024
      ? `${(entry.bytes / 1024).toFixed(1)}K chars`
      : `${entry.bytes} chars`;
    entries.push({
      path: absPath,
      readAt: entry.readAt,
      bytes: entry.bytes,
      label: `- \`${absPath}\` (read ${ageLabel}, ${sizeLabel}, unchanged on disk)`
    });
  }
  if (entries.length === 0) return '';
  entries.sort((a, b) => b.readAt - a.readAt);
  const top = entries.slice(0, 12);
  return [
    '## Already read this session',
    '',
    'You already have these files\' contents in this session\'s context. DO NOT call `read_file` on them again — re-reading wastes a full LLM round-trip on data you already have. They are marked unchanged on disk; if you suspect a change, re-read explicitly. Entries automatically drop when the file changes on disk.',
    '',
    top.map((e) => e.label).join('\n')
  ].join('\n');
}

interface RunOptions {
  prompt: string;
  skillRegistry: SkillRegistry;
  cwd: string;
  settings: ProviderSettings;
  model: string;
  conversation: ToolLoopMessage[];
  memoryBlock: string;
  todoStore: TodoStore;
  hookSettings: HookSettings;
  permissionStore: SessionPermissionStore;
  /** User-configured custom repo roots. Forwarded into the tool
   * context so find_directory can scan them in addition to the
   * built-in clone parents. */
  customRepoRoots?: string[];
  /** Tavily web-search BYOK key (resolved from env or
   *  ~/.bandit/config.json `tools.tavily.apiKey`). Undefined means the
   *  web_search tool returns "not configured" and the agent falls back
   *  to web_fetch with a known URL. */
  tavilyApiKey?: string;
  /** Mid-turn message-injection callback forwarded to the underlying
   *  ToolUseLoop. The host wires this to its backgroundStore so
   *  completed subagent synopses get fed to the parent's conversation
   *  AS THEY COMPLETE — eliminating the poll-loop wedge where the
   *  parent burned iterations on `check_task(bg-id)` waiting for
   *  background work to finish. See `pendingBackgroundInjections` at
   *  REPL scope. Omit in one-shot mode (no background tasks possible). */
  drainExternalMessages?: () => ToolLoopMessage[] | undefined;
  /** Optional line reader. When running inside a REPL, caller passes a
   * function that hooks the main readline so stdin isn't double-consumed.
   * One-shot mode can omit this — defaultGetLine opens a throwaway rl. */
  getLine?: GetLineFn;
  /** Optional handle to the REPL's readline interface. When present the
   * permission picker pauses it during raw-mode input so readline and
   * the picker don't compete for keystrokes, and resumes it afterward.
   * One-shot callers omit this and the picker falls back to a throwaway
   * readline for the Tab-follow-up flow. */
  rl?: readline.Interface;
  /** Optional getter for the session-level thinking-mode override.
   * Read on every chat request so `/think on` takes effect mid-session
   * without needing to rebuild the provider. undefined → runtime
   * default wins. */
  getThink?: () => boolean | undefined;
  /** Optional getter for the session-level co-author toggle .
   * Read once per turn when the system prompt is built so `/coauthor
   * on|off` and `BANDIT_NO_COAUTHOR=1` take effect on the next prompt
   * without restarting the CLI. Default true at the call site when
   * omitted. */
  getCoauthor?: () => boolean;
  /** Optional getter for the session-level watchdog override .
   * Read on every chat request so `/watchdog off` / `/watchdog 120s`
   * take effect on the next call without rebuilding the chat closure.
   * `undefined` returned → fall through to the auto-scale formula. */
  getWatchdogMs?: () => number | undefined;
  /** Session-scoped read-cache shared across turns. The REPL declares a
   *  single Map at startup and passes it on every runPrompt call; this
   *  function appends successful `read_file` results so the model can
   *  see "## Already read this session" in its system context next
   *  turn and skip redundant reads of files it just consumed. Captured
   *  2026-05-25 on a local React refactor where bandit-logic spent
   *  iter 1 re-reading the same 4 files turn 1 had read 6 minutes
   *  prior — wasted ~30s of prefill on cached content. Omit in
   *  one-shot mode (no cross-turn benefit there). */
  recentReads?: Map<string, RecentReadEntry>;
  /** Callback invoked when the agent's `switch_model` tool fires.
   * Let the REPL mutate its own model state so the NEXT prompt uses
   * the new model without the user having to type `/model <name>`.
   * One-shot callers can omit this — the tool will still "succeed"
   * but its effect won't persist past the current turn. */
  onModelSwitch?: (next: string) => void;
  /** Per-chunk token-delta callback so the REPL can keep a running
   * session total across turns (its status bar reads from it). The
   * value is approximate (chars/4) — same convention the spinner +
   * footer use. Optional; one-shot mode can ignore it. */
  onTokenDelta?: (deltaTokens: number) => void;
  /** Host notification hook. The REPL wires this to desktop/bell
   * preferences; one-shot runs can omit it. */
  notify?: (notification: CliNotification) => void;
  /** Long-lived background-task store. When present, the `task` tool
   * honors run_in_background="true" by spawning the subagent detached
   * and returning a task id immediately, and the registry also gets
   * `check_task` + `list_tasks` tools so the agent can poll on demand.
   * Lives at the REPL level so tasks survive across turns; one-shot
   * callers don't pass this (no point — the process exits before any
   * background work could finish). */
  backgroundStore?: BackgroundTaskStore;
  /** Long-lived MCP client pool. When present, the runner enumerates
   * every connected server's tools at the start of the turn and
   * registers them in the per-turn ToolRegistry as `<server>.<tool>`.
   * Servers spawn lazily on first invocation (see McpClientPool); a
   * failed-to-spawn server logs and is skipped — never blocks the
   * loop. Lives at the REPL level so processes survive across turns. */
  mcpPool?: McpClientPool;
  /** Cooperative cancellation. When the host aborts this signal the
   * tool-use loop drops out of its current iteration, returns whatever
   * it has, and the REPL prints `[cancelled]` instead of a final
   * response. Wired to the Esc keypress in the REPL so users can stop
   * a runaway turn without killing the process. */
  signal?: AbortSignal;
}

// One-shot Ollama context-length check guard. Module-scoped so the
// flag persists across runPrompt() invocations within a single
// `bandit` process — each new node process starts with this `false`,
// which is the right behavior (one tip per session). Catches the
// canonical first-install gotcha: user installed Ollama,
// OLLAMA_CONTEXT_LENGTH unset, model loads at 4K, our framework
// prompt + tool results overflow → super slow / poor responses. Tip
// fires after the first tool_loop:llm_response (model is loaded by
// then, so /api/ps can report its actual context_length).
let ollamaContextChecked = false;

// Module-level singleton so the REPL keypress handler (in `repl()`) can
// pause the same spinner that `runPrompt()` is rendering. Safe because
// the REPL serialises turns via `activeTurnController` — only one
// runPrompt is in flight at a time, and oneShot is a single-turn
// process. If concurrent runPrompts ever land, this needs to become
// per-turn instead.
const spinner = new Spinner();

async function runPrompt(opts: RunOptions): Promise<string> {
  const { prompt, skillRegistry, cwd, settings, model, conversation, memoryBlock, todoStore, hookSettings, permissionStore } = opts;
  const getLine = opts.getLine ?? defaultGetLine;
  const replRl = opts.rl;

  // Plan checklist rendering. The model's todo list is committed to
  // scrollback as a styled block each time it MEANINGFULLY changes, so
  // the user sees a persistent, evolving checklist where the work is
  // happening — not an ephemeral overlay that vanishes at turn end. A
  // dedupe guard skips no-op rewrites (the model re-sending an unchanged
  // list). Reset per turn so the current plan re-commits once on the
  // first update of a new turn.
  let lastTodoChecklist = '';
  const commitTodoChecklist = (): void => {
    const items = todoStore.snapshot();
    if (items.length === 0) return;
    // Turn-view path: hand the plan to ink's live region so it updates IN
    // PLACE (no re-committed scrollback block on every todo_write). This is
    // the durable version of the committed-checklist approximation.
    const ink = replRl as unknown as InkLineInterface | undefined;
    if (ink?.isTurnMode?.()) {
      ink.setTurnPlan?.(items.map((t) => ({ status: t.status, content: t.content })));
      return;
    }
    const cols = process.stdout.columns || 80;
    const done = items.filter((t) => t.status === 'done').length;
    const rows = renderTodoTree(
      items.map((t) => ({ status: t.status, content: t.content })),
      cols
    );
    const header = c.dim(`  ${glyph.bullet} plan · ${done}/${items.length} done`);
    const block = [header, ...rows].join('\n');
    if (block === lastTodoChecklist) return;
    lastTodoChecklist = block;
    // note() clears the live dock, commits the block to scrollback, and
    // lets the next spinner tick repaint the status line below it.
    spinner.note(block);
  };
  spinner.setComposer('');

  const expanded = await expandMentions(prompt, cwd);
  for (const m of expanded.mentions) {
    if (!m.ok) {
      process.stdout.write(c.yellow(`  ${glyph.warn} could not inline @${m.path}\n`));
    }
  }

  // Forensic transcript — writes to .bandit/turns/ so we can audit what the
  // agent actually tried on failed runs.
  const turnLog = await openTurnLog(cwd).catch(() => null);
  await turnLog?.append({ type: 'user-prompt', prompt: previewText(prompt) });
  const turnId = turnLog
    ? (path.basename(turnLog.filePath).replace(/\.jsonl$/, ''))
    : `turn-${Date.now()}`;
  const checkpointStore = new CheckpointStore({ workspaceRoot: cwd });
  // Pre-edit content per path so we can create a checkpoint on
  // successful write_file / apply_edit / replace_range. Captured in tool_execute
  // (before the tool has run), persisted in tool_result.
  const pendingEditBefore = new Map<string, string>();
  // Holds the absolute path of the most-recent read_file call so the
  // matching tool_result can populate opts.recentReads after we
  // confirm the read succeeded. Cleared whenever a new read_file
  // fires; if results arrive out of order in a parallel batch the
  // last-writer-wins behavior just under-populates the cache (no
  // correctness risk — we just miss a cache entry).
  let pendingReadPath: string | null = null;
  const pendingEditAfter = new Map<string, string>();

  const activeSkills = skillRegistry.resolveActiveSkills(expanded.prompt);
  const { registry, toolToSkill } = skillRegistry.buildToolRegistryWithMap(activeSkills);
  registry.register(buildTodoWriteTool(todoStore));
  registry.register(buildWebFetchTool());
  // Web search — Tavily-backed. Free tier at https://tavily.com.
  // BYOK: env TAVILY_API_KEY wins, then persisted /tavily key from
  // ~/.bandit/config.json. Tool reports "not configured" if neither is
  // set so the model knows to fall back to web_fetch with a URL.
  // Re-read fresh each turn (readTavilyKey) so a key saved in the IDE or via
  // /tavily lands without a CLI restart; fall back to the boot-resolved value.
  registry.register(buildWebSearchTool({ apiKey: readTavilyKey() ?? opts.tavilyApiKey }));
  registry.register(buildRememberTool());
  registry.register(buildReadMemoryTool());
  registry.register(buildTestRunTool());
  registry.register(pdfReadTool);

  // MCP tools — enumerated lazily on first turn after a server is
  // configured. Each connected server contributes `<server>.<tool>`
  // entries to the registry. Failures (server didn't spawn, listTools
  // errored) are isolated by the pool — those servers contribute zero
  // tools and the loop continues. The user's prompt is passed so
  // servers configured with `activation: "on-mention"` only register
  // when their triggers appear in the text — keeps prompt budget
  // small for users with many configured servers. See
  // packages/agent-core/src/mcp/activation.ts.
  if (opts.mcpPool && opts.mcpPool.list().length > 0) {
    try {
      const mcpTools = await getAllMcpAgentTools(opts.mcpPool, expanded.prompt);
      for (const tool of mcpTools) registry.register(tool);
    } catch (err) {
      // Defensive: getAllMcpAgentTools is supposed to handle per-server
      // errors internally, but any pool-wide blowup shouldn't kill the
      // turn. Log to stderr (visible in --debug) and continue with
      // native tools only.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mcp] tool enumeration failed: ${msg}\n`);
    }
  }

  // Conversational model switching. Before this tool existed, asking
  // "switch me to bandit-logic" got a response like "type /model
  // bandit-logic at the next prompt" — which left the user on the
  // prior model until they manually re-ran the slash command. Now the
  // agent can fulfill that intent directly and the REPL picks up the
  // new model on the next turn via onModelSwitch. No-ops gracefully
  // when the caller didn't wire onModelSwitch (one-shot mode).
  registry.register({
    name: 'switch_model',
    description:
      'Switch the active model used by subsequent prompts in this CLI session. Call this whenever the user conversationally asks to change, swap, or try a different model (e.g. "switch to bandit-logic", "let\'s try qwen3.6:27b", "use gemma4:26b for the next one"). The switch takes effect on the NEXT user prompt — do NOT re-invoke within the same turn. On hosted-Bandit provider the model name is trusted verbatim; on Ollama an exact installed tag is required.',
    parameters: [
      { name: 'model', description: 'Exact model name/tag to switch to (e.g. "bandit-logic", "gemma4:26b", "qwen3.6:27b").', required: true }
    ],
    async execute(params) {
      const next = String(params?.model ?? '').trim();
      if (!next) {
        return { output: 'error: switch_model requires a non-empty `model` argument.', isError: true };
      }
      if (opts.onModelSwitch) {
        opts.onModelSwitch(next);
        return {
          output: `Model switched to \`${next}\`. Your next prompt will use it. (This turn continues on the prior model.)`,
          isError: false
        };
      }
      return {
        output: `No model switcher wired for this session (likely one-shot mode). Run \`/model ${next}\` in the REPL to switch manually.`,
        isError: false
      };
    }
  });

  const toolCtx = new CliToolExecutionContext(cwd, createDefaultLanguageAdapters(), {
    customRepoRoots: opts.customRepoRoots,
    // Wire ask_user → the interactive form, but only for TTY sessions; in
    // piped/CI runs the tool degrades to "ask in plain text" (ctx callback
    // absent), matching the TTY gate on the interactionSkill registration.
    requestUserInput: process.stdin.isTTY && replRl
      ? (req) => promptAskUser(req.questions, { rl: replRl as unknown as { pause?: () => void; resume?: () => void; isPaused?: () => boolean; isTurnMode?: () => boolean }, readLine: getLine })
      : undefined
  });

  const modelCaps = getModelCapabilities(model);
  // Per-model loop cap: an explicit BANDIT_MAX_ITERATIONS wins; otherwise the
  // shared resolver picks a model-aware default (thorough models like
  // bandit-logic-2 / qwen3.6 get more rounds than a small local model).
  const maxIterations = process.env.BANDIT_MAX_ITERATIONS
    ? Number(process.env.BANDIT_MAX_ITERATIONS)
    : resolveDefaultMaxIterations(model, modelCaps.tier);
  const behaviorProfile = getModelBehaviorProfile(model);
  // Same compaction budget as the VS Code extension: 75% of the
  // model's num_ctx reserved for rolling tool history. For the
  // hosted Bandit path we use a conservative 32k budget (Bandit
  // Core 1 has 131k native but most turns stay under that).
  const numCtx = settings.kind === 'ollama'
    ? resolveOllamaRuntimeOptions(model).num_ctx
    : 32768;
  const messageTokenBudget = Math.floor(numCtx * 0.75);
  // Use native tool calling when the model advertises it. Moves the
  // ~1000-1800 token tool schema out of the system prompt and into
  // Ollama's `tools` field so the model's chat template serializes
  // them in its native (much more compact) format.
  // Mirror the IDE's gate: on the bandit cloud path the gateway
  // forwards `tools: [...]` to upstream Ollama via AdditionalProperties,
  // so qwen3.6/bandit-logic gets the proper chat-template framing.
  // openai-compatible servers (vLLM, LM Studio, llama.cpp, OpenRouter…)
  // take the same OpenAI-shape `tools` array natively. Models without a
  // hand-tuned profile default to native-with-text-fallback when the
  // capability probe detected tool support (resolvePreferredToolProtocol).
  const nativeTools = (settings.kind === 'ollama' || settings.kind === 'bandit' || settings.kind === 'openai-compatible')
    && modelCaps.supportsToolCalling
    && resolvePreferredToolProtocol(model) === 'native-tools';
  const nativeToolFailureFallback = behaviorProfile.protocol.nativeToolFailureFallback !== false;
  const outputBudgetTokens = behaviorProfile.context.outputBudgetTokens;
  const maxParallelTools = behaviorProfile.reliability.maxParallelTools;

  // Thinking display state — buffers reasoning deltas from the
  // provider's structured `thinking` field while the spinner is still
  // animating, flushes as one dim+italic block with a visible leader
  // the moment real content starts flowing. Any further thinking that
  // arrives after content starts (rare — usually thinking comes first)
  // renders inline dim+italic since the spinner is already out of the way.
  const thinkingBuffer: string[] = [];
  let thinkingFlushed = false;
  // Running char counter for the turn — bumped by BOTH content chunks
  // (the `tool_loop:llm_chunk` handler below) AND thinking chunks (the
  // onThinking callback we hand to buildChat). Without thinking
  // contribution the spinner's token count would freeze at 0 for the
  // entire reasoning phase on bandit-logic / Qwen 3.6 / DeepSeek-R1,
  // then jump only once content started flowing — which is what made
  // the spinner look like "rate is changing but count is stuck."
  // Declared here (before buildChat) so the closure captures the same
  // ref the content-chunk handler later uses; moved up from its
  // historical home further down for the same reason.
  let turnChunkChars = 0;

  const chat = await buildCliChatFn({
    settings,
    model,
    pendingImages: expanded.images,
    getThink: opts.getThink ?? (() => undefined),
    onThinking: (chunk) => {
      // Always buffer — the flush decision happens in the chunk
      // handler below where we also own spinner lifecycle.
      thinkingBuffer.push(chunk);
      // Thinking tokens count toward the running token total too —
      // for reasoning models the model can spend 90%+ of a turn in
      // the thinking channel. Same /4 approximation we use for
      // content chunks. We only push to the spinner here; the
      // StreamFooter is declared below this callback site (TDZ) AND
      // hasn't been started yet during the thinking-only phase
      // anyway. When content starts flowing the content-chunk
      // handler resyncs both spinner + footer from the same
      // cumulative turnChunkChars counter, so nothing drifts.
      turnChunkChars += chunk.length;
      spinner.setTokens(Math.floor(turnChunkChars / 4));
    },
    // getter for the active turn's AbortSignal so Esc can
    // interrupt a chat call that's hung at first-token (no chunks
    // flowing → the existing `signal.aborted` check inside the
    // for-await loop never runs because it only fires between chunks).
    // The chat closure races iter.next() against this signal so abort
    // unblocks the call immediately.
    getAbortSignal: () => opts.signal,
    // getter for the session-level watchdog override. Read
    // on every chat call so `/watchdog off` flips the next request's
    // window without restarting the REPL.
    getWatchdogMs: opts.getWatchdogMs
  });

  let lastAnnouncedSkill: string | null = null;
  const toolStartedAt = new Map<string, number>();
  const footer = new StreamFooter();

  /** Render the accumulated thinking as a single framed block, clear
   * the buffer, and mark it flushed. Safe to call even when the
   * buffer is empty — no-op in that case. Caller must ensure the
   * spinner is already stopped so the leader/separator don't get
   * overwritten by a spinner redraw tick. */
  const flushThinking = () => {
    if (thinkingFlushed || thinkingBuffer.length === 0) return;
    const body = thinkingBuffer.join('').trim();
    thinkingBuffer.length = 0;
    thinkingFlushed = true;
    if (!body) return;
    // Two-space indent the body so the dim block visually sets apart
    // from the main response. Newlines inside thinking keep their
    // indent. Trailing blank line separates reasoning from the answer.
    const indented = body.replace(/\n/g, '\n  ');
    process.stdout.write(
      '\n' + c.dim('  ' + c.accent('⟡') + ' reasoning') +
      '\n' + c.dim(c.italic('  ' + indented)) +
      '\n\n'
    );
  };

  // picker serialization mutex. When the model emits 2+
  // parallel tool calls in one iteration the loop fires beforeToolExecute
  // concurrently for each. Each call rendered its own picker header
  // and registered its own keypress listener — they collided on stdin
  // and only the LAST-registered picker actually received keystrokes,
  // leaving earlier ones as ghost menus the user couldn't answer. The
  // mutex chains pickers so they queue cleanly: each waiter awaits the
  // previous chain link before opening its own picker. After acquiring
  // the lock, we also re-evaluate the policy — if a prior picker
  // granted "allow session" (which earlier made tool-broad), the
  // queued ones auto-pass without needing a redundant prompt.
  let pickerChain: Promise<void> = Promise.resolve();

  // Shared gate — applies to the main loop and Task-spawned subagents.
  // Order: hooks (shell-script guardrails) → permission policy (user prompt).
  const beforeToolExecute = async ({ name, params }: { name: string; params: Record<string, string> }) => {
    const primary = params.path ?? params.pattern ?? params.cmd ?? params.url ?? params.query ?? '';
    // Display variant — for run_command, show "cmd args" so the user
    // sees the FULL command line they're approving, not just "npx".
    // Storage key (`primary`) stays scope-narrow so "always allow" on
    // npx covers every npx call, but the picker text reveals exactly
    // what's about to run. Symptom this fixes: user saw "permission:
    // run_command npx" and approved blind, then the model was running
    // `npx create-vite@latest my-app --template react` — they
    // had no way to know.
    const displayPrimary = name === 'run_command' && params.cmd
      ? `${params.cmd}${params.args ? ' ' + params.args : ''}`
      : primary;

    // 0. Built-in security guard (opt-in, off by default). First line of
    // defense against the model footgunning a catastrophic command — runs
    // before the user's own hooks. No-op unless `security.guard.enabled`.
    const guard = evaluateSecurityGuard({ name, params }, hookSettings.security?.guard, { workspaceRoot: cwd });
    if (!guard.allow) {
      const reason = `security guard blocked ${guard.reason ?? 'a dangerous call'}`;
      await turnLog?.append({
        type: 'permission-denied',
        name,
        primary: previewText(primary),
        displayPrimary: previewText(displayPrimary),
        source: 'security-guard',
        reason: previewText(reason)
      });
      process.stdout.write(c.red(`  ${glyph.cross} security guard blocked ${name}: ${guard.reason ?? 'dangerous call'}\n`));
      return { allow: false, reason };
    }

    // 1. Hooks
    const hookResults = await runHooks('PreToolUse', hookSettings, { toolName: name, primary }, cwd);
    const blocker = hookResults.find(r => r.exitCode !== 0);
    if (blocker) {
      // Redact before reason is used ANYWHERE downstream — hook stdout
      // /stderr is user-controlled (their shell script), so a validation
      // hook that echoes an API key would otherwise land in terminal
      // scrollback AND .bandit/turns/*.jsonl in plaintext. The single
      // wrap here covers the printed line, the turn log entry, and the
      // value returned to the caller. (2026-05-26 wiring audit)
      const rawReason = (blocker.stderr.trim() || blocker.stdout.trim()) || `PreToolUse hook exited ${blocker.exitCode}`;
      const reason = redactSecretsString(rawReason);
      await turnLog?.append({
        type: 'permission-denied',
        name,
        primary: previewText(primary),
        displayPrimary: previewText(displayPrimary),
        source: 'hook',
        reason: previewText(reason)
      });
      process.stdout.write(c.red(`  ${glyph.cross} PreToolUse blocked ${name}: ${reason}\n`));
      return { allow: false, reason };
    }

    // 2. Permission policy — BANDIT_AUTO_APPROVE short-circuits it.
    if (/^(1|true)$/i.test(process.env.BANDIT_AUTO_APPROVE ?? '')) {
      return { allow: true };
    }
    const merged = mergePolicies(
      {
        allow: hookSettings.permissions?.allow ?? [],
        deny: hookSettings.permissions?.deny ?? [],
        ask: hookSettings.permissions?.ask ?? []
      },
      permissionStore.toPolicy()
    );
    // For run_command the wider form (cmd + args) is what users want
    // their `run_command:git *` / `run_command:rm *` patterns to match
    // against. Other tools get the narrow primary as before.
    const primaryFull = name === 'run_command' && params.cmd
      ? `${params.cmd}${params.args ? ' ' + params.args : ''}`.trim()
      : undefined;
    const decision = evaluatePermission(name, primary, merged, primaryFull);
    if (decision === 'deny') {
      await turnLog?.append({
        type: 'permission-denied',
        name,
        primary: previewText(primary),
        displayPrimary: previewText(displayPrimary),
        source: 'policy',
        reason: `denied by permission policy (${name}${primary ? `:${primary}` : ''})`
      });
      process.stdout.write(c.red(`  ${glyph.cross} denied: ${name}${primary ? ' ' + primary : ''}\n`));
      return { allow: false, reason: `denied by permission policy (${name}${primary ? `:${primary}` : ''})` };
    }
    if (decision === 'ask') {
      // acquire the picker mutex before rendering anything.
      // Concurrent beforeToolExecute calls chain here, so only one
      // picker UI is on screen at a time. Each waiter holds onto its
      // `release` so the next can run when the picker resolves.
      const myTurn = pickerChain;
      let releaseLock: () => void = () => {};
      pickerChain = new Promise<void>((resolve) => { releaseLock = resolve; });
      await myTurn;
      try {
        // After acquiring the lock, re-check the policy — a prior
        // picker may have granted `session` or `always` for this tool
        // (session grants are tool-broad earlier), in which
        // case we'd be prompting the user redundantly. If the policy
        // now says allow, skip the picker entirely.
        const refreshedPolicy = mergePolicies(
          {
            allow: hookSettings.permissions?.allow ?? [],
            deny: hookSettings.permissions?.deny ?? [],
            ask: hookSettings.permissions?.ask ?? []
          },
          permissionStore.toPolicy()
        );
        const refreshed = evaluatePermission(name, primary, refreshedPolicy, primaryFull);
        if (refreshed === 'allow') {
          await turnLog?.append({
            type: 'permission-decision',
            name,
            primary: previewText(primary),
            displayPrimary: previewText(displayPrimary),
            choice: 'already-allowed',
            source: 'session-or-policy'
          });
          return { allow: true };
        }
        if (refreshed === 'deny') {
          await turnLog?.append({
            type: 'permission-denied',
            name,
            primary: previewText(primary),
            displayPrimary: previewText(displayPrimary),
            source: 'policy',
            reason: `denied by permission policy (${name}${primary ? `:${primary}` : ''})`
          });
          process.stdout.write(c.red(`  ${glyph.cross} denied: ${name}${primary ? ' ' + primary : ''}\n`));
          return { allow: false, reason: `denied by permission policy (${name}${primary ? `:${primary}` : ''})` };
        }
      // pause the misleading "running <tool>…" spinner that
      // the tool_loop:tool_execute event already started. While the
      // permission prompt is open the tool is NOT running — it's
      // waiting for the user. Leaving the spinner spinning made users
      // think the command was already in flight and they had no
      // action to take (transcript 2026-05-22: user waited 12 minutes
      // before typing "you there?"). The next event will restart the
      // spinner with the right state after permission resolves.
      spinner.stop();
      process.stdout.write('\n');
      renderPermissionContext(name, params, cwd, displayPrimary, primary);
      await turnLog?.append({
        type: 'permission-request',
        name,
        primary: previewText(primary),
        displayPrimary: previewText(displayPrimary),
        risk: permissionRisk(name, params)
      });
      opts.notify?.({
        kind: 'approval',
        title: 'Bandit needs approval',
        message: `${name}${displayPrimary ? ` ${displayPrimary}` : ''}`
      });
      // For write_file, render a unified diff preview so the user can see
      // what the agent intends to write before approving.
      if (name === 'write_file' && params.path && params.content !== undefined) {
        // Expand leading ~/ before resolving — the actual tool runs through
        // expandHome in cliToolContext, but the permission preview reads
        // the file directly. Without this, ~-paths fall into path.resolve
        // which prepends cwd, leaving us with /cwd/~/foo (never exists),
        // and the card lies "(new file)" for an actual destructive overwrite.
        const expanded = expandHome(params.path);
        const absPath = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
        const rel = path.relative(cwd, absPath) || params.path;
        let before = '';
        try { before = await fs.promises.readFile(absPath, 'utf-8'); } catch { /* new file */ }
        const isNew = before === '';
        process.stdout.write(c.accent('│ ') + c.bold(isNew ? 'new file' : 'diff') + c.accent(': ') + c.cyan(rel) + '\n');
        const diff = isNew
          ? params.content.split('\n').slice(0, 40).map(line => c.green(`+ ${line}`)).join('\n')
          : renderDiff(before, params.content, 40, rel);
        for (const line of diff.split('\n')) process.stdout.write(c.accent('│ ') + line + '\n');
      } else if (name === 'apply_edit' && params.path && params.find && params.replace !== undefined) {
        // Same diff treatment for targeted edits — compute the would-be file
        // content by running the find/replace locally, then diff against the
        // file on disk so the approval card shows exactly what's about to
        // change (no full-file rewrite, just the touched region). expandHome
        // mirrors cliToolContext so the preview reads the same file the tool
        // will actually edit — without this, ~-paths fail the readFile and
        // the card prints a bogus "(file does not exist yet)" warning that
        // sends small models into a re-read/retry loop.
        const expanded = expandHome(params.path);
        const absPath = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
        const rel = path.relative(cwd, absPath) || params.path;
        let before = '';
        try { before = await fs.promises.readFile(absPath, 'utf-8'); } catch { /* apply_edit on missing file — the tool itself will reject */ }
        const after = params.replace_all === 'true'
          ? before.split(params.find).join(params.replace)
          : before.replace(params.find, params.replace);
        process.stdout.write(c.accent('│ ') + c.bold('diff') + c.accent(': ') + c.cyan(rel) + '\n');
        const diff = before ? renderDiff(before, after, 40, rel) : c.dim('(file does not exist yet — apply_edit will fail)');
        for (const line of diff.split('\n')) process.stdout.write(c.accent('│ ') + line + '\n');
      } else if (name === 'replace_range' && params.path && params.start_line && params.content !== undefined) {
        const expanded = expandHome(params.path);
        const absPath = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
        const rel = path.relative(cwd, absPath) || params.path;
        let before = '';
        try { before = await fs.promises.readFile(absPath, 'utf-8'); } catch { /* replace_range on missing file — the tool itself will reject */ }
        const eol = before.includes('\r\n') ? '\r\n' : '\n';
        const lines = before.split(eol);
        const startLine = parseInt(params.start_line, 10);
        const endLine = params.end_line !== undefined && params.end_line !== ''
          ? parseInt(params.end_line, 10)
          : startLine;
        let preview = c.dim('(invalid line range — replace_range will reject)');
        if (before && Number.isFinite(startLine) && Number.isFinite(endLine) && startLine >= 1 && endLine >= startLine - 1 && startLine <= lines.length + 1 && endLine <= lines.length) {
          const replacementLines = params.content === '' ? [] : params.content.split(/\r?\n/);
          const after = [
            ...lines.slice(0, startLine - 1),
            ...replacementLines,
            ...lines.slice(Math.max(startLine - 1, endLine))
          ].join(eol);
          preview = renderDiff(before, after, 40, rel);
        } else if (!before) {
          preview = c.dim('(file does not exist yet — replace_range will fail)');
        }
        process.stdout.write(c.accent('│ ') + c.bold('diff') + c.accent(': ') + c.cyan(`${rel}:${params.start_line}-${params.end_line ?? params.start_line}`) + '\n');
        for (const line of preview.split('\n')) process.stdout.write(c.accent('│ ') + line + '\n');
      } else {
        process.stdout.write(c.accent('│ ') + c.dim('review the request, then choose below') + '\n');
      }
      let result;
      try {
        result = await promptPermission({ rl: replRl, readLine: getLine });
      } catch {
        // Ctrl+C or aborted picker — treat as deny so we never silently
        // approve a tool call on user interruption.
        await turnLog?.append({
          type: 'permission-denied',
          name,
          primary: previewText(primary),
          displayPrimary: previewText(displayPrimary),
          source: 'cancelled',
          reason: 'user cancelled permission prompt'
        });
        return { allow: false, reason: 'user cancelled permission prompt' };
      }
      if (result.choice === 'session') {
        // session grants are now TOOL-broad, not path-narrow.
        // Original from a real bandit-cli run where
        // the agent was patching 17 implicit-any errors across 6 files
        // and the picker re-prompted on each new path even after the
        // user had hit "allow session" — the narrow `apply_edit:path-A`
        // grant didn't cover the next `apply_edit:path-B` call. The
        // intent of "allow session" was always "stop asking me about
        // this kind of call this session", not "this exact target." If
        // the user really wants the narrow lock-in, "always (save)"
        // still persists `tool:path` to disk.
        permissionStore.grant(name);
        await turnLog?.append({
          type: 'permission-decision',
          name,
          primary: previewText(primary),
          displayPrimary: previewText(displayPrimary),
          choice: 'session'
        });
        process.stdout.write(c.green(`  ${glyph.check} allowed ${name} for this session\n`));
      } else if (result.choice === 'always') {
        permissionStore.grant(name, primary);
        await persistAllowEntry(cwd, primary ? `${name}:${primary}` : name).catch(() => undefined);
        await turnLog?.append({
          type: 'permission-decision',
          name,
          primary: previewText(primary),
          displayPrimary: previewText(displayPrimary),
          choice: 'always'
        });
        process.stdout.write(c.green(`  ${glyph.check} saved allow rule for ${name}${primary ? `:${primary}` : ''}\n`));
      } else if (result.choice === 'deny') {
        const reason = formatDenialReason(result, name, primary);
        await turnLog?.append({
          type: 'permission-denied',
          name,
          primary: previewText(primary),
          displayPrimary: previewText(displayPrimary),
          source: 'user',
          reason: previewText(reason),
          notes: result.notes ? previewText(result.notes) : undefined
        });
        process.stdout.write(c.yellow(`  ${glyph.warn} denied ${name}; Bandit will revise the plan\n`));
        return { allow: false, reason };
      } else {
        await turnLog?.append({
          type: 'permission-decision',
          name,
          primary: previewText(primary),
          displayPrimary: previewText(displayPrimary),
          choice: 'once'
        });
        process.stdout.write(c.green(`  ${glyph.check} allowed once\n`));
      }
      } finally {
        // release the picker mutex so the next queued
        // beforeToolExecute (parallel tool call this iteration) can
        // open its own picker. ALWAYS releases, even on early returns
        // / throws above, so a Ctrl+C in the picker doesn't leave the
        // chain wedged forever.
        releaseLock();
      }
    }

    return { allow: true };
  };

  // Register the Task tool so the model can delegate scoped work to a
  // subagent. When a backgroundStore is wired in, the agent can also
  // pass run_in_background="true" to spawn detached subagents — the
  // tool returns a task id immediately, and the REPL injects the
  // synopsis as a system message on the next turn. We also register
  // check_task + list_tasks here so the agent can inspect on demand.
  if (opts.backgroundStore) {
    registry.register(buildCheckTaskTool(opts.backgroundStore));
    registry.register(buildListTasksTool(opts.backgroundStore));
  }
  // Holder for the parent's system prompt, populated below once
  // skillInstructions are folded in. The task tool reads this lazily
  // at subagent-spawn time so subagents inherit the EXACT prompt the
  // CLI is using this turn — no hand-rolled fork. fix for
  // subagent stall.
  const parentPromptHolder: { current: string | undefined } = { current: undefined };
  registry.register(buildTaskTool({
    chat,
    parentRegistry: registry,
    ctx: toolCtx,
    backgroundStore: opts.backgroundStore,
    beforeToolExecute,
    parentSystemPrompt: () => parentPromptHolder.current,
    // v1.7.338: pass the parent's per-turn AbortSignal so Stop / Esc
    // cascades down to spawned subagents. Without this, hitting Esc
    // aborted the parent loop but background subagents kept running
    // their own loops — UI stayed "N running", the only recovery was
    // killing the process. Getter rather than value so each subagent
    // spawn picks up the CURRENT turn's controller (the controller is
    // replaced on every new prompt; if we cached one at registration
    // time it'd already be stale by the second turn).
    getParentSignal: () => opts.signal,
    subagentLoopOptions: () => ({
      nativeTools,
      nativeToolFailureFallback,
      messageTokenBudget,
      maxParallelTools,
      outputBudgetTokens
    }),
    onEvent: (type, payload) => {
      if (type === 'task:start') {
        const p = payload as { goal: string };
        spinner.stop();
        process.stdout.write(c.magenta(`  ${glyph.spark} subagent: `) + c.dim(p.goal) + '\n');
      } else if (type === 'subagent:task:spawn') {
        // Telemetry: subagent system-prompt size +
        // inheritance source captured at spawn time. Lets us correlate
        // a later stall/watchdog with what we actually sent.
        const p = payload as {
          taskId?: string;
          systemPromptChars?: number;
          inheritedFromParent?: boolean;
          nativeTools?: boolean;
          registryToolCount?: number;
        };
        process.stdout.write(c.dim(`  ↳ spawn: prompt=${p?.systemPromptChars ?? '?'}c inherited=${p?.inheritedFromParent ?? '?'} nativeTools=${p?.nativeTools ?? '?'} tools=${p?.registryToolCount ?? '?'}\n`));
        void turnLog?.append({
          type: 'subagent-spawn',
          taskId: p?.taskId,
          systemPromptChars: p?.systemPromptChars,
          inheritedFromParent: p?.inheritedFromParent,
          nativeTools: p?.nativeTools,
          registryToolCount: p?.registryToolCount
        });
      } else if (type === 'task:done') {
        const p = payload as { iterations: number; hitLimit: boolean };
        process.stdout.write(c.dim(`  ${glyph.check} subagent done (${p.iterations} iter${p.hitLimit ? ', hit limit' : ''})\n`));
      } else if (type === 'subagent:tool_loop:tool_execute') {
        const p = payload as { name?: string; params?: Record<string, string> };
        const name = p?.name ?? '';
        const primary = p?.params?.path ?? p?.params?.pattern ?? p?.params?.cmd ?? p?.params?.url ?? p?.params?.query ?? '';
        process.stdout.write(c.dim(`    ↳ ${name}${primary ? ' ' + primary : ''}\n`));
        void turnLog?.append({
          type: 'subagent-tool-execute',
          name,
          params: p?.params ? Object.fromEntries(Object.entries(p.params).map(([k, v]) => [k, previewText(v)])) : {}
        });
      } else if (type === 'subagent:tool_loop:tool_result') {
        const p = payload as { name?: string; isError?: boolean; outputLength?: number; outputSnippet?: string };
        void turnLog?.append({
          type: 'subagent-tool-result',
          name: p?.name,
          isError: !!p?.isError,
          outputLength: p?.outputLength,
          outputSnippet: p?.outputSnippet
        });
      } else if (type === 'subagent:tool_loop:tool_error') {
        const p = payload as { name?: string; error?: string };
        void turnLog?.append({ type: 'subagent-tool-error', name: p?.name, error: p?.error });
      } else if (type === 'subagent:tool_loop:tool_blocked') {
        const p = payload as { name?: string; reason?: string };
        void turnLog?.append({ type: 'subagent-tool-blocked', name: p?.name, reason: p?.reason });
      }
    }
  }));

  // State for live token streaming. `buffer` holds bytes we can't yet
  // commit to stdout because they might be the start of a suppressed
  // block opener; `suppress` is non-null while we're inside one
  // (tool_call markup or a <think> reasoning block). Reset per-
  // iteration in the llm_start handler so a malformed/unterminated
  // block in one iteration doesn't silence the next one.
  const streamState: StreamStrippingState = createStreamStrippingState();
  // (turnChunkChars was historically declared here — moved up to before
  // buildChat so the onThinking callback can also bump it. See the
  // declaration + thinking-counter wiring there.)

  const loop = createToolUseLoop(registry, toolCtx, {
    maxIterations,
    beforeToolExecute,
    // Per-model output budget — drives the serialise-batch gate for
    // parallel write/edit calls. Strong models (large tier) get a
    // generous 8K budget which never trips on real workloads; small
    // (4B) and medium (12B–27B) get tier-tuned ceilings so a 4-file
    // parallel write of ~7 KB each falls back to one-at-a-time
    // execution. Hosted Bandit gateway models route through this
    // same path — their `large` tier budget effectively disables
    // the gate.
    outputBudgetTokens,
    maxParallelTools,
    nativeToolFailureFallback,
    // Small-tier models get the compact text tool block (~11 KB vs the
    // ~27 KB full XML) — the difference between fitting the default
    // model's num_ctx and silently truncating the prompt head.
    compactToolBlock: modelCaps.tier === 'small',
    emitEvent: async (type, payload) => {
      telemetryEvent(type, payload);
      if (type === 'tool_loop:llm_start') {
        spinner.startThinking();
        // Reset streaming state on every new LLM call — each iteration
        // gets its own fresh stream buffer so a prior iteration's
        // unterminated tool_call doesn't bleed across.
        streamState.buffer = '';
        streamState.suppress = null;
        streamState.wroteAnyChunk = false;
        streamState.tableBuffer = '';
        streamState.inTable = false;
        streamState.markdownBuffer = '';
        streamState.inCodeFence = false;
        streamState.tableInCodeFence = false;
        // Also reset the reasoning display — each LLM call gets its
        // own thinking block (thinking tied to one turn's prompt).
        thinkingBuffer.length = 0;
        thinkingFlushed = false;
        // capture prompt size at the start of every LLM
        // call so we can correlate huge prompts with watchdog/stall
        // failures in the trace.
        const sp = payload as {
          iteration?: number;
          messageCount?: number;
          promptCharsTotal?: number;
          systemPromptChars?: number;
          thinkOverride?: boolean;
        };
        void turnLog?.append({
          type: 'llm-start',
          iteration: sp?.iteration,
          messageCount: sp?.messageCount,
          promptCharsTotal: sp?.promptCharsTotal,
          systemPromptChars: sp?.systemPromptChars,
          thinkOverride: sp?.thinkOverride
        });
      }
      if (type === 'tool_loop:llm_retry') {
        const p = payload as { iteration?: number; attempt?: number; maxAttempts?: number; delayMs?: number; reason?: string };
        spinner.stop();
        process.stdout.write(
          c.dim(
            `  ${glyph.info} upstream hiccup — retrying ${p?.attempt ?? '?'} of ${p?.maxAttempts ?? '?'} ` +
            `in ${Math.round((p?.delayMs ?? 0) / 1000)}s`
          ) +
          (p?.reason ? c.dim(` (${p.reason})`) : '') +
          '\n'
        );
        void turnLog?.append({
          type: 'llm-retry',
          iteration: p?.iteration,
          attempt: p?.attempt,
          maxAttempts: p?.maxAttempts,
          delayMs: p?.delayMs,
          reason: p?.reason
        });
        spinner.startThinking();
      }
      if (type === 'tool_loop:native_tool_fallback') {
        const p = payload as { iteration?: number; reason?: string };
        spinner.stop();
        process.stdout.write(
          c.dim(`  ${glyph.info} native tool call failed upstream — retrying this step with Bandit's text tool protocol`) +
          (p?.reason ? c.dim(` (${p.reason})`) : '') +
          '\n'
        );
        void turnLog?.append({
          type: 'native-tool-fallback',
          iteration: p?.iteration,
          reason: p?.reason
        });
        spinner.startThinking();
      }
      if (type === 'tool_loop:empty_retry') {
        const p = payload as { iteration?: number; attempt?: number; reasoningOnly?: boolean; narratedButNoAction?: boolean };
        void turnLog?.append({
          type: 'empty-retry',
          iteration: p?.iteration,
          attempt: p?.attempt,
          reasoningOnly: p?.reasoningOnly,
          narratedButNoAction: p?.narratedButNoAction
        });
      }
      if (type === 'tool_loop:thinking_off_recovery') {
        const p = payload as { iteration?: number; reason?: string };
        spinner.stop();
        process.stdout.write(
          c.dim(`  ${glyph.info} reasoning-mode stalled — retrying without thinking`) + '\n'
        );
        void turnLog?.append({
          type: 'thinking-off-recovery',
          iteration: p?.iteration,
          reason: p?.reason
        });
        spinner.startThinking();
      }
      if (type === 'tool_loop:prefill_recovery') {
        const p = payload as { iteration?: number; prefix?: string };
        spinner.stop();
        process.stdout.write(
          c.dim(`  ${glyph.info} prefilling tool envelope to break reasoning stall`) + '\n'
        );
        void turnLog?.append({
          type: 'prefill-recovery',
          iteration: p?.iteration,
          prefix: p?.prefix
        });
        spinner.startThinking();
      }
      if (type === 'tool_loop:batch_serialized') {
        const p = payload as { iteration?: number; toolCount?: number; estimatedTokens?: number; budgetTokens?: number; threshold?: number; reason?: string };
        spinner.stop();
        process.stdout.write(
          c.dim(
            `  ${glyph.info} heavy tool batch serialized — ` +
            `${p?.toolCount ?? '?'} calls estimated at ${p?.estimatedTokens ?? '?'} tokens ` +
            `(budget ${p?.budgetTokens ?? '?'}, threshold ${p?.threshold ?? '?'})`
          ) + '\n'
        );
        void turnLog?.append({
          type: 'batch-serialized',
          iteration: p?.iteration,
          toolCount: p?.toolCount,
          estimatedTokens: p?.estimatedTokens,
          budgetTokens: p?.budgetTokens,
          threshold: p?.threshold,
          reason: p?.reason
        });
        spinner.startThinking();
      }
      // Live token streaming. Chunks arrive from streamAndAggregate as
      // the model generates; this subscriber writes CLEAN text to
      // stdout (stripping <tool_call>...</tool_call> markup and buffering
      // partial tags across chunk boundaries). On first clean byte we
      // stop the spinner so the user sees tokens appear where the
      // animation was. `wroteAnyChunk` tells the REPL not to re-print
      // the final response — it's already on screen.
      if (type === 'tool_loop:llm_chunk') {
        const p = payload as { chunk?: string };
        if (typeof p?.chunk === 'string' && p.chunk.length > 0) {
          // Count every byte — cumulative across all iterations in the
          // turn. Includes tool-call markup chars because those are
          // real tokens the model generated on the user's clock /
          // rate limit, even though we don't render them to stdout.
          turnChunkChars += p.chunk.length;
          const approxTokens = Math.floor(turnChunkChars / 4);
          spinner.setTokens(approxTokens);
          footer.setTokens(approxTokens);
          opts.onTokenDelta?.(Math.floor(p.chunk.length / 4));
          const stripped = consumeStreamChunk(streamState, p.chunk);
          const tableConsumed = consumeTablesInChunk(streamState, stripped);
          const clean = consumeMarkdownInChunk(streamState, tableConsumed);
          if (clean.length > 0) {
            if (!streamState.wroteAnyChunk) {
              // Spinner dies on first real byte — from here on the
              // persistent StreamFooter below the cursor carries the
              // live token count + elapsed timer until the response
              // finalizes. Both are cumulative across the turn, so
              // the footer keeps counting even across iterations.
              spinner.stop();
              // Flush any buffered reasoning BEFORE the streaming
              // banner so the block order reads:
              // ⟡ reasoning …
              // ⚡ streaming…
              // <response>
              // → ~N tokens · Ns
              // This is where the spinner-collision fix lands — the
              // spinner is guaranteed stopped here, so the dim block
              // writes cleanly with no redraw thrash.
              flushThinking();
              footer.start();
              streamState.wroteAnyChunk = true;
            }
            process.stdout.write(clean);
          }
        }
      }
      if (type === 'tool_loop:llm_response') {
        spinner.stop();
        footer.stop();
        // Edge case: the model emitted ONLY thinking and/or a tool
        // call with no prose content — the first-content flush never
        // ran, so any buffered reasoning would vanish silently. Flush
        // here as a last chance so the user still sees the reasoning
        // that led to the tool call.
        flushThinking();
        const p = payload as {
          iteration?: number;
          response?: string;
          responseLength?: number;
          hasToolCallMarkup?: boolean;
          endsWithFenceClose?: boolean;
          llmDurationMs?: number;
        };
        void turnLog?.append({
          type: 'llm-response',
          iteration: p?.iteration,
          responseLength: p?.responseLength,
          hasToolCallMarkup: p?.hasToolCallMarkup,
          endsWithFenceClose: p?.endsWithFenceClose,
          llmDurationMs: p?.llmDurationMs,
          responsePreview: previewText(p?.response ?? '')
        });
        // First-response Ollama context check. Only fires on Ollama
        // and only once per session. Non-blocking; if the model is
        // loaded at <8K context AND we asked for more, surface a
        // one-time tip so first-time users don't sit through slow
        // turns wondering what's wrong.
        if (!ollamaContextChecked && settings.kind === 'ollama') {
          ollamaContextChecked = true;
          const requested = resolveOllamaRuntimeOptions(model).num_ctx;
          const baseUrl = settings.ollamaUrl ?? 'http://localhost:11434';
          void checkOllamaLoadedContext(baseUrl, model, requested)
            .then((check) => {
              if (check.underweight && check.loadedContext !== null) {
                process.stdout.write(
                  '\n' +
                  c.yellow(`  ${glyph.warn} Ollama loaded ${model} with only ${check.loadedContext} context (requested ${check.requestedContext}).`) + '\n' +
                  c.dim('     Bandit prompts will overflow and feel slow. Restart Ollama with a higher window:') + '\n' +
                  c.dim('     ') + c.cyan(check.suggestionCommand) + '\n' +
                  c.dim('     Or set OLLAMA_CONTEXT_LENGTH in your shell rc so it persists across reboots.') + '\n\n'
                );
              }
            })
            .catch(() => { /* best-effort UX hint, never fail the turn */ });
        }
      }
      if (type === 'tool_loop:tool_calls') {
        spinner.stop();
        footer.stop();
        const p = payload as { iteration?: number; tools?: string[] };
        void turnLog?.append({ type: 'tool-calls', iteration: p?.iteration, tools: p?.tools ?? [] });
      }
      if (type === 'tool_loop:tool_execute') {
        const p = payload as { name?: string; params?: Record<string, string> };
        const name = p?.name ?? '';
        void turnLog?.append({ type: 'tool-execute', name, params: p?.params ? Object.fromEntries(Object.entries(p.params).map(([k, v]) => [k, previewText(v)])) : {} });
        const skillId = name ? toolToSkill.get(name) : undefined;
        const skillName = skillId ? activeSkills.find(s => s.id === skillId)?.name : undefined;
        if (skillId && skillId !== lastAnnouncedSkill && skillName) {
          process.stdout.write(skillLine(skillName) + '\n');
          lastAnnouncedSkill = skillId;
        }
        const primary = p?.params?.path ?? p?.params?.pattern ?? p?.params?.cmd ?? p?.params?.url ?? p?.params?.query ?? '';
        // Stop the previous spinner phase BEFORE printing the tool line so
        // the line clear `\r\x1b[2K` from the spinner's last render doesn't
        // collide with our write. Then print the tool line + restart the
        // spinner with a tool-flavored label so the user sees a continuous
        // animation while the tool actually runs. Without this restart the
        // animation goes silent between `tool_calls` and the next
        // `llm_start` — a 30s osascript timeout looks like a complete
        // freeze on screen even though work is happening.
        spinner.stop();
        process.stdout.write(toolLine(name, primary) + '\n');
        spinner.start(`running ${name}…`);
        toolStartedAt.set(name, Date.now());
        // Capture pre-edit state for checkpoints.
        if ((name === 'write_file' || name === 'apply_edit' || name === 'replace_range') && p?.params?.path) {
          const absPath = path.isAbsolute(p.params.path) ? p.params.path : path.resolve(cwd, p.params.path);
          try {
            const before = await fs.promises.readFile(absPath, 'utf-8');
            pendingEditBefore.set(absPath, before);
          } catch {
            pendingEditBefore.set(absPath, '');
          }
          // For write_file we know the `after` from params.content; for
          // apply_edit/replace_range we'll read post-write in tool_result.
          if (name === 'write_file' && p.params.content !== undefined) {
            pendingEditAfter.set(absPath, p.params.content);
          } else {
            pendingEditAfter.set(absPath, '');
          }
        }
        // Pre-stage the read path for the recent-reads cache. We stash
        // the absolute path keyed by the tool name so the matching
        // tool_result handler can populate the cache without having
        // to re-resolve the params (params shape isn't guaranteed
        // to land on the tool_result payload — some loops only echo
        // name + isError + outputLength). Edits to the SAME path also
        // invalidate the cache entry (the file just changed), keeping
        // the "unchanged on disk" annotation honest.
        if (name === 'read_file' && p?.params?.path && opts.recentReads) {
          const absPath = path.isAbsolute(p.params.path) ? p.params.path : path.resolve(cwd, p.params.path);
          pendingReadPath = absPath;
        }
        if ((name === 'write_file' || name === 'apply_edit' || name === 'replace_range' || name === 'apply_patch') && p?.params?.path && opts.recentReads) {
          const absPath = path.isAbsolute(p.params.path) ? p.params.path : path.resolve(cwd, p.params.path);
          opts.recentReads.delete(absPath);
        }
      }
      if (type === 'tool_loop:tool_result') {
        const p = payload as { name?: string; isError?: boolean; outputLength?: number; outputSnippet?: string };
        const name = p?.name ?? '';
        const started = toolStartedAt.get(name);
        const duration = started ? Date.now() - started : 0;
        // Commit the updated plan to scrollback the moment the model
        // rewrites the todo list, so the checklist is visible and
        // persistent right where the work is happening.
        if (name === 'todo_write' && !p?.isError) commitTodoChecklist();
        // Recent-reads cache populate. Successful read_file results
        // get stashed so the next turn's system prompt can show
        // "## Already read this session" and the model skips the
        // redundant read. We stat the file fresh here to capture the
        // mtime AT cache time — that's the value we'll compare on
        // each subsequent turn's stat-check to detect on-disk changes.
        if (name === 'read_file' && !p?.isError && pendingReadPath && opts.recentReads) {
          try {
            const stat = fs.statSync(pendingReadPath);
            opts.recentReads.set(pendingReadPath, {
              readAt: Date.now(),
              mtimeMs: stat.mtimeMs,
              bytes: p?.outputLength ?? stat.size
            });
          } catch { /* file vanished between read and stat — ignore */ }
        }
        pendingReadPath = null;
        // outputSnippet (first ~280 chars) is what makes errors diagnosable
        // after the fact — a `node wrapper.js` timeout gets logged with its
        // actual stderr, not just "isError: true, length: 586".
        void turnLog?.append({
          type: 'tool-result',
          name,
          isError: !!p?.isError,
          durationMs: duration,
          outputLength: p?.outputLength,
          outputSnippet: p?.outputSnippet
        });
        await runHooks('PostToolUse', hookSettings, { toolName: name, durationMs: duration }, cwd);
        // Persist a checkpoint for successful write/apply/range edits so the
        // REPL's /rewind can restore them.
        if ((name === 'write_file' || name === 'apply_edit' || name === 'replace_range') && !p?.isError) {
          const [absPath] = [...pendingEditBefore.keys()].slice(-1);
          if (absPath) {
            const before = pendingEditBefore.get(absPath) ?? '';
            let after = pendingEditAfter.get(absPath) ?? '';
            if (name === 'apply_edit' || name === 'replace_range') {
              try { after = await fs.promises.readFile(absPath, 'utf-8'); } catch { /* file gone */ }
            }
            if (before !== after) {
              // Claude-style APPLIED diff — the durable record of what
              // actually landed, shown on EVERY successful edit (not just
              // gated ones, unlike the pre-approval preview). On by default
              // now (with the rest of the turn-view work); opt out with
              // BANDIT_TURN_VIEW=0.
              if (process.env.BANDIT_TURN_VIEW !== '0') {
                const relPath = path.relative(cwd, absPath) || absPath;
                const verb = name === 'write_file' ? 'Wrote' : 'Updated';
                const rendered = renderAppliedDiff(relPath, before, after, { verb });
                if (rendered) process.stdout.write(rendered + '\n');
              }
              try {
                const entry = await checkpointStore.create({
                  turnId,
                  tool: name as 'write_file' | 'apply_edit' | 'replace_range',
                  absolutePath: absPath,
                  before,
                  after,
                  iteration: 0
                });
                process.stdout.write(c.dim(`  ${glyph.check} checkpoint ${entry.id} (${entry.relPath})\n`));
              } catch {
                // Best-effort — don't fail the turn on checkpoint write.
              }
            }
            pendingEditBefore.delete(absPath);
            pendingEditAfter.delete(absPath);
          }
        }
      }
      if (type === 'tool_loop:tool_error') {
        const p = payload as { name?: string; error?: string };
        void turnLog?.append({ type: 'tool-error', name: p?.name, error: p?.error });
        process.stdout.write(errorLine(p.name ?? '', p.error ?? '') + '\n');
      }
      if (type === 'tool_loop:tool_blocked') {
        const p = payload as { name?: string; reason?: string };
        void turnLog?.append({ type: 'tool-blocked', name: p?.name, reason: p?.reason });
      }
      if (type === 'tool_loop:compacted') {
        const p = payload as { iteration?: number; messagesCompacted?: number; beforeTokens?: number; afterTokens?: number };
        void turnLog?.append({
          type: 'compacted',
          iteration: p?.iteration,
          messagesCompacted: p?.messagesCompacted,
          beforeTokens: p?.beforeTokens,
          afterTokens: p?.afterTokens
        });
      }
      if (type === 'tool_loop:goal_anchor') {
        const p = payload as { iteration?: number; goalPreview?: string; refire?: boolean; postAggressiveCompaction?: boolean };
        void turnLog?.append({
          type: 'goal-anchor',
          iteration: p?.iteration,
          refire: !!p?.refire,
          postAggressiveCompaction: !!p?.postAggressiveCompaction,
          goalPreview: p?.goalPreview
        });
      }
      if (type === 'tool_loop:hallucinated_tool_result') {
        const p = payload as { iteration?: number; responsePreview?: string };
        void turnLog?.append({ type: 'hallucinated-tool-result', iteration: p?.iteration, responsePreview: p?.responsePreview });
      }
      if (type === 'tool_loop:fired_and_forgotten_nudge') {
        const p = payload as { iteration?: number; backgroundSpawns?: number };
        void turnLog?.append({ type: 'fired-and-forgotten-nudge', iteration: p?.iteration, backgroundSpawns: p?.backgroundSpawns });
      }
      if (type === 'tool_loop:announce_intent_nudge') {
        const p = payload as { iteration?: number; responsePreview?: string };
        void turnLog?.append({ type: 'announce-intent-nudge', iteration: p?.iteration, responsePreview: p?.responsePreview });
      }
      if (type === 'tool_loop:iteration_cap_extended') {
        // surface the extension to the user. Fires from the
        // cap-check at the top of an iteration AFTER the prior
        // iteration's `tool_loop:llm_response` already stopped the
        // spinner, so writing directly to stdout is safe — no
        // pause/resume dance needed.
        const p = payload as {
          iteration?: number;
          previousMax?: number;
          newMax?: number;
          extension?: number;
          hardCap?: number;
        };
        process.stdout.write(
          c.dim(
            `  ${glyph.spark} iteration cap extended (${p?.previousMax} → ${p?.newMax}, ` +
            `${p?.extension}/2 extensions) — model is making progress, letting it continue\n`
          )
        );
        void turnLog?.append({
          type: 'iteration-cap-extended',
          iteration: p?.iteration,
          previousMax: p?.previousMax,
          newMax: p?.newMax,
          extension: p?.extension,
          hardCap: p?.hardCap
        });
      }
    }
  });

  const skillInstructions = activeSkills
    .filter((s) => s.instructions)
    .map((s) => `### ${s.name}\n${s.instructions}`)
    .join('\n\n');
  const coauthorForPrompt = opts.getCoauthor?.() ?? true;
  const promptOpts = {
    coauthor: coauthorForPrompt,
    supportsVision: modelCaps.supportsVision,
    modelId: model,
    userGoal: opts.prompt
  };
  // Build the session-scoped "already read this session" addendum from
  // the host's read-cache. Caps at 12 entries (LRU) so the addendum
  // doesn't bloat the system prompt on long sessions — most-recent
  // reads are the most relevant. Mtime-check each entry to surface
  // staleness; the model decides whether to trust the cached copy
  // (unchanged) or re-read (mtime moved since we captured it).
  const recentReadsBlock = buildRecentReadsAddendum(opts.recentReads);
  const baseSystemPrompt = buildSystemPrompt(memoryBlock, promptOpts);
  const systemPrompt = [
    baseSystemPrompt,
    recentReadsBlock ? recentReadsBlock : '',
    skillInstructions ? `## Skill Instructions\n\n${skillInstructions}` : ''
  ].filter(Boolean).join('\n\n');

  // hand the parent's full prompt to any subagent that
  // spawns this turn. Subagents now inherit identity / tool-call
  // format / operational hints verbatim instead of rolling their own.
  parentPromptHolder.current = systemPrompt;

  const seeded: ToolLoopMessage[] = [...conversation, { role: 'user', content: expanded.prompt }];
  try {
    const result = await loop.runWithMessages(seeded, chat, systemPrompt, {
      messageTokenBudget,
      nativeTools,
      signal: opts.signal,
      // Mid-turn injection — the host passes a queue-drain callback so
      // completed background subagents land in the parent's conversation
      // AS THEY COMPLETE instead of forcing the parent to poll
      // check_task in a loop. See cli.ts's `pendingBackgroundInjections`
      // wiring at REPL scope where the actual queue lives.
      drainExternalMessages: opts.drainExternalMessages
    });
    await turnLog?.append({
      type: 'final-response',
      iterations: result.iterations,
      hitLimit: result.hitLimit,
      finalPreview: previewText(result.finalResponse),
      logPath: turnLog.filePath
    });
    // Stop hooks fire once per turn after the assistant finalizes.
    await runHooks('Stop', hookSettings, {}, cwd);
    // Keep only user/assistant turns so the conversation file stays clean.
    const nextConversation = result.messages.filter(m => m.role !== 'system');
    conversation.length = 0;
    conversation.push(...nextConversation);
    const trimmed = result.finalResponse.trim();
    // Small models (gemma4:e4b, qwen 4B, etc) sometimes produce an empty
    // final response after a tool result on multi-step prompts. Without a
    // diagnostic the user sees a blank line and thinks the CLI hung.
    if (!trimmed && result.iterations > 0) {
      const msg = c.yellow(
        `${glyph.warn} The model returned no answer after the last tool call.\n` +
        `   This can happen with smaller models on multi-step prompts.\n` +
        `   Try: ${c.cyan('/model gemma4:26b')} (or any larger model), or rephrase the request as a single step.`
      );
      process.stdout.write(`\n${msg}\n\n`);
      return trimmed;
    }
    // Live-streaming path: if the llm_chunk subscriber already wrote the
    // final iteration's content to stdout, don't re-print it — that
    // would duplicate the whole response. Just emit a trailing blank
    // line so the divider lands cleanly. Otherwise (no streaming
    // happened — e.g. provider returned a single blob, non-stream
    // mode, tool_loop errored mid-stream) write the cleaned text
    // normally so the user still sees something.
    if (streamState.wroteAnyChunk) {
      // Drain any in-flight markdown table that didn't see a closing
      // line before the stream ended — render it now so the user sees
      // the box rather than having the rows silently dropped. Then
      // run any drained text through the markdown renderer (the table
      // tail can be box-drawing chars OR raw markdown if it disqualified
      // mid-render) and finally flush any partial trailing line that
      // never received its newline so the last sentence isn't truncated.
      // Drain order matters: stream-chunk buffer first (held-back
      // partial-tag bytes), then table renderer (in-flight rows),
      // then markdown line transform on whatever drained, then any
      // partial trailing line. Skipping the first drain is what
      // caused trailing chars like "po" / "Th" / "Re" to vanish from
      // the end of streamed responses — .
      const stripTail = flushStreamChunkBuffer(streamState);
      const tableTail = consumeTablesInChunk(streamState, stripTail) + flushTableState(streamState);
      const mdTail = consumeMarkdownInChunk(streamState, tableTail) + flushMarkdownState(streamState);
      if (mdTail.length) process.stdout.write(mdTail);
      process.stdout.write('\n\n');
    } else {
      process.stdout.write(`\n${cleanFinalResponse(trimmed)}\n\n`);
    }
    return trimmed;
  } finally {
    // Belt-and-suspenders: always stop the spinner and the streaming
    // status footer, even on error. Without this, a provider failure
    // (404, network) leaves "thinking…" or "⚡ streaming" on screen.
    spinner.stop();
    footer.stop();
  }
}

// Per-chunk sanitization in the provider can miss control tokens split across
// streaming chunk boundaries (e.g. "</start" + "_of_turn>"). Strip again on
// the fully aggregated response before showing it to the user.
const CONTROL_TOKEN_CLEANUP_REGEX = /<\/?(?:end_of_turn|start_of_turn)>|<\|(?:eot_id|start_header_id|end_header_id|begin_of_text)\|>/g;

/**
 * LaTeX arrows / operators the model occasionally emits in prose
 * ("Idea $\rightarrow$ Design $\rightarrow$ Ship"). Math-mode delimiters
 * ($...$ or \( \)) render as raw text in the terminal and look like
 * garbage. Replace the most common ones with Unicode glyphs so the
 * prose stays readable. We deliberately don't try to be a full LaTeX
 * renderer — just handle the arrows / ops that show up in agent
 * output. on bandit-core-1 turn output.
 */
const LATEX_GLYPH_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\$\s*\\rightarrow\s*\$/g, '→'],
  [/\$\s*\\leftarrow\s*\$/g, '←'],
  [/\$\s*\\Rightarrow\s*\$/g, '⇒'],
  [/\$\s*\\Leftarrow\s*\$/g, '⇐'],
  [/\$\s*\\leftrightarrow\s*\$/g, '↔'],
  [/\$\s*\\uparrow\s*\$/g, '↑'],
  [/\$\s*\\downarrow\s*\$/g, '↓'],
  [/\$\s*\\to\s*\$/g, '→'],
  [/\$\s*\\times\s*\$/g, '×'],
  [/\$\s*\\cdot\s*\$/g, '·'],
  [/\$\s*\\approx\s*\$/g, '≈'],
  [/\$\s*\\neq\s*\$/g, '≠'],
  [/\$\s*\\leq\s*\$/g, '≤'],
  [/\$\s*\\geq\s*\$/g, '≥'],
  [/\$\s*\\infty\s*\$/g, '∞']
];
function cleanFinalResponse(text: string): string {
  let out = text.replace(CONTROL_TOKEN_CLEANUP_REGEX, '');
  for (const [pattern, replacement] of LATEX_GLYPH_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out.trim();
}

/**
 * Interactive first-run theme picker. Renders the theme list with a
 * live preview block, lets the user pick with arrow keys + Enter.
 * Returns the chosen theme name or null on cancel/non-TTY (caller
 * falls back to the dark default). Saves to ~/.bandit/config.json
 * via saveTheme on the caller side once a pick is returned.
 *
 * Mirrors the pattern in filePicker.ts: raw mode, line-count tracking
 * for clean redraw, no save/restore cursor (which drifts on scroll).
 */
async function runFirstRunThemePicker(): Promise<string | null> {
  if (!process.stdout.isTTY) return null;
  const themes: Array<{ id: string; label: string; tag?: string }> = [
    { id: 'dark', label: 'Dark mode', tag: 'default' },
    { id: 'light', label: 'Light mode' },
    { id: 'dark-cb', label: 'Dark mode (colorblind-friendly)' },
    { id: 'light-cb', label: 'Light mode (colorblind-friendly)' },
    { id: 'dark-ansi', label: 'Dark mode (ANSI 16-color only)' },
    { id: 'light-ansi', label: 'Light mode (ANSI 16-color only)' }
  ];
  const wasRaw = process.stdin.isRaw === true;
  process.stdin.setRawMode?.(true);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.resume();
  process.stdout.write('\x1b[?25l'); // hide cursor

  let selected = 0;
  let lastDrawnLines = 0;
  process.stdout.write('\n');
  process.stdout.write(c.bold('  Welcome to Bandit') + c.dim(' — pick a theme that reads cleanly in your terminal') + '\n');
  process.stdout.write(c.dim('  (you can change this later with /theme; everything respects NO_COLOR)') + '\n\n');

  const erase = () => {
    if (lastDrawnLines <= 0) return;
    process.stdout.write('\r\x1b[2K');
    for (let i = 1; i < lastDrawnLines; i++) process.stdout.write('\x1b[A\x1b[2K');
    lastDrawnLines = 0;
  };

  const render = () => {
    erase();
    const lines: string[] = [];
    for (let i = 0; i < themes.length; i++) {
      const t = themes[i];
      const marker = i === selected ? c.accent('▸') : ' ';
      const label = i === selected ? c.bold(t.label) : c.dim(t.label);
      const tag = t.tag ? c.dim(`  (${t.tag})`) : '';
      lines.push(`  ${marker} ${i + 1}. ${label}${tag}`);
    }
    lines.push('');
    // Live preview using the currently-selected theme. Apply temporarily,
    // emit the preview, restore the previous active theme so the picker
    // chrome itself stays in the original (default-dark) palette.
    setActiveTheme(themes[selected].id);
    lines.push(c.dim('  Preview:'));
    lines.push(`    ${c.green('✓ build succeeded')}  ${c.red('✗ test failed')}  ${c.yellow('⚠ deprecated')}  ${c.accent('› bandit')}`);
    setActiveTheme('dark');
    lines.push('');
    lines.push(c.dim('  ↑↓ navigate  ·  Enter pick  ·  Esc to use default (Dark)'));
    process.stdout.write(lines.join('\n'));
    lastDrawnLines = lines.length;
  };

  return await new Promise<string | null>((resolve) => {
    const cleanup = () => {
      erase();
      process.stdout.write('\x1b[?25h');
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode?.(wasRaw);
    };
    const onKey = (_str: string | undefined, key: readline.Key | undefined) => {
      if (!key) return;
      if (key.name === 'up') {
        selected = (selected - 1 + themes.length) % themes.length;
        render();
      } else if (key.name === 'down') {
        selected = (selected + 1) % themes.length;
        render();
      } else if (key.name === 'return') {
        cleanup();
        process.stdout.write(c.dim(`  ${glyph.check} theme: ${c.accent(themes[selected].label)}\n\n`));
        resolve(themes[selected].id);
      } else if (key.name === 'escape') {
        cleanup();
        process.stdout.write(c.dim(`  ${glyph.check} using default (Dark)\n\n`));
        resolve('dark');
      } else if (/^[1-6]$/.test(key.name ?? '')) {
        const idx = parseInt(key.name!, 10) - 1;
        if (idx < themes.length) {
          cleanup();
          process.stdout.write(c.dim(`  ${glyph.check} theme: ${c.accent(themes[idx].label)}\n\n`));
          resolve(themes[idx].id);
        }
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        resolve(null);
      }
    };
    process.stdin.on('keypress', onKey);
    render();
  });
}

async function oneShot(prompt: string, cwd: string, session: SessionStore, overrides: ConfigOverrides): Promise<void> {
  const fileConfig = await loadConfigFiles(cwd);
  const resolved = resolveConfig(fileConfig, overrides);
  // Telemetry: same opt-in init as the REPL so `bandit "prompt"` one-shots also
  // emit a turn trace + usage metrics. Silent (no banner line) to keep scripted
  // output clean; no-op when telemetry is off. runPrompt's emitEvent funnel
  // already feeds telemetryEvent, so child spans/tokens populate once the turn
  // is bracketed below.
  initTelemetry(resolveTelemetryConfig({ telemetry: fileConfig.telemetry, banditApiKey: resolved.apiKey }));
  const bundle = buildProviderSettings(resolved);
  let { settings, model } = bundle;
  const { kind, modelWasExplicit } = bundle;
  // Pre-flight the Ollama model so we don't 404 mid-prompt. If the user
  // didn't specify BANDIT_MODEL, silently swap to the closest installed
  // variant so common suffix differences (-it-qat, -it-q4_K_M) Just Work.
  if (kind === 'ollama') {
    const check = await validateOllamaModel(model, settings.ollamaUrl ?? '', !modelWasExplicit);
    if (!check.ok) {
      process.stderr.write(c.red('✗ ') + check.message + '\n');
      process.exit(1);
    }
    if (check.autoSwitched) {
      // Only surface the switch when the user explicitly asked for a specific
      // model. In the common "no BANDIT_MODEL / no config" case the default
      // is an opinionated pick — silently using whatever they have installed
      // is the right behavior; the notice would just be noise.
      if (modelWasExplicit) {
        process.stdout.write(c.dim(`${glyph.info} ${check.fromModel} not pulled — using ${c.accent(check.model)} instead\n`));
      }
      model = check.model;
      settings.ollamaModel = check.model;
    }
  }
  const skillRegistry = await loadSkills(cwd);
  const hookSettings = await loadHookSettings(cwd);
  const memory = await loadCombinedMemory(cwd);
  const todoStore = new TodoStore();
  const permissionStore = new SessionPermissionStore();
  const sendNotification = (notification: CliNotification): void => {
    notifyCli(resolved.notifications, notification);
  };

  await session.init();
  if (!session.currentId) await session.startNew();
  const conversation = await session.readConversation();

  const startedAt = Date.now();
  let response: string;
  telemetryStartTurn(prompt, model);
  try {
    response = await runPrompt({
      prompt,
      skillRegistry,
      cwd,
      settings,
      model,
      conversation,
      memoryBlock: memory.content,
      todoStore,
      hookSettings,
      permissionStore,
      customRepoRoots: resolved.repoRoots,
      tavilyApiKey: resolved.tavilyApiKey,
      notify: sendNotification
    });
    sendNotification({
      kind: 'complete',
      title: 'Bandit turn complete',
      message: prompt.slice(0, 160),
      durationMs: Date.now() - startedAt
    });
    await telemetryEndTurnAwait();
  } catch (err) {
    sendNotification({
      kind: 'error',
      title: 'Bandit turn failed',
      message: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt
    });
    await telemetryEndTurnAwait({ error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  await session.replace(conversation);
  // runPrompt already wrote the response (streamed live or as a final
  // blob) to stdout before returning — no duplicate print needed.
  void response;
}

async function repl(cwd: string, session: SessionStore, overrides: ConfigOverrides): Promise<void> {
  // Paint the launch banner IMMEDIATELY so the user sees something within
  // ~20ms of hitting `bandit` even when subsequent async work (config
  // load, Ollama model pre-flight, skill discovery, conversation rehydrate)
  // takes a couple seconds on cold starts. Previously the banner waited
  // for all that to finish and the terminal looked frozen.
  const bootStartedAt = Date.now();

  // Stdout diagnostic. Wraps `process.stdout.write` so we can spot any
  // mystery byte that escapes between prompts (Mark reported a stray
  // `s` appearing in the prompt area "all the time" with no
  // corresponding submission — see 2026-05-26 notes). Off by default;
  // set BANDIT_DEBUG_STDOUT=1 to capture. Output lands in
  // .bandit/stdout-trace.log as one JSON line per write so the
  // timestamps and call-site stack frames can be diff'd against the
  // observed terminal output. Wrap is installed exactly once.
  if (process.env.BANDIT_DEBUG_STDOUT === '1') {
    try {
      const traceDir = path.join(cwd, '.bandit');
      fs.mkdirSync(traceDir, { recursive: true });
      const tracePath = path.join(traceDir, 'stdout-trace.log');
      const traceStream = fs.createWriteStream(tracePath, { flags: 'a' });
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array, encodingOrCb?: unknown, cb?: unknown): boolean => {
        const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        const stack = new Error().stack?.split('\n').slice(2, 4).join(' | ') ?? '';
        try {
          traceStream.write(JSON.stringify({ t: Date.now(), len: str.length, head: str.slice(0, 80), stack }) + '\n');
        } catch { /* trace failure shouldn't break stdout */ }
        return originalWrite(chunk as never, encodingOrCb as never, cb as never);
      }) as typeof process.stdout.write;
      process.stdout.write(c.dim(`[debug] stdout trace → ${path.relative(cwd, tracePath)}\n`));
    } catch {
      // Trace setup failed — silent, don't break the REPL.
    }
  }
  // Cumulative token estimate across every turn in this REPL session.
  // Surfaced in the status bar above the prompt so the user always sees
  // how much they've burned without having to type /usage. Approximated
  // as chars/4 — same convention as the per-turn StreamFooter counter.
  let sessionTokenTotal = 0;
  // Session-scoped recent-reads cache. Populated per-turn by runPrompt's
  // tool_result handler; consumed at the start of each new turn to
  // render the "## Already read this session" addendum in the system
  // prompt. In-memory only — no cross-session persistence; a fresh
  // bandit launch starts with an empty cache by design (the file's
  // content might have changed since prior sessions ended).
  const sessionRecentReads = new Map<string, RecentReadEntry>();
  // Background-task store. Lives at the REPL level so tasks survive
  // across turns. Subagents spawned via task(run_in_background="true")
  // record into this store; completed tasks get their synopses
  // injected into the next prompt automatically by
  // drainBackgroundCompletions() below. Status bar reads the running
  // count.
  const backgroundStore: BackgroundTaskStore = new InMemoryBackgroundTaskStore();

  // MCP client pool — session-scoped, persists across turns so a
  // server we spawn for the first prompt stays connected for the
  // rest of the REPL session. Loaded from ~/.bandit/mcp-servers.json
  // (global) + .bandit/mcp-servers.json (workspace, takes precedence).
  // No config files = empty pool = zero behavior change.
  //
  // Trust gate: spawning an MCP server is unrestricted code execution
  // via child_process. Before each first-spawn we consult the persisted
  // approval list (~/.bandit/mcp-trust.json); if the fingerprint is
  // already approved, allow. Otherwise inline-prompt the user with
  // yes / always / no. "Always" persists the approval to disk so
  // the next session doesn't re-prompt.
  const approvedFingerprints = await loadApprovedMcpFingerprints();
  const mcpPool = new McpClientPool({
    resolveAuthToken: (kind) => {
      // Hand the pool's URL-transport branch the Bandit Cloud API key
      // it needs to attach `X-API-Key` to requests aimed at hosted
      // MCP servers (mcp.burtson.ai etc.). Resolution chain matches
      // the chat engine's: env BANDIT_API_KEY → ~/.bandit/config.json
      // `bandit.apiKey`. Returning undefined for any other `kind` keeps
      // the surface conservative; new strategies (oauth-bandit, etc.)
      // light up here without a breaking change.
      if (kind === 'bandit-api-key') return resolved.apiKey;
      return undefined;
    },
    trustGate: async (params) => {
      // URL-transport servers (Streamable HTTP / mcp.burtson.ai) get a
      // different prompt body — `url` + `auth method` instead of
      // `command + args + envKeys`. The picker behavior (y/a/n with
      // raw stdin) is identical so we share the loop below.
      const { name } = params;
      const isUrl = params.kind === 'url';
      // Compute the same fingerprint the pool will use, then check
      // the persisted approval file. If approved, allow silently.
      const fingerprint = isUrl
        ? fingerprintServerConfig(name, { url: params.url, auth: params.authKind === 'bandit-api-key' ? 'bandit' : undefined })
        : fingerprintServerConfig(name, {
            command: params.command,
            args: params.args,
            env: Object.fromEntries(params.envKeys.map((k) => [k, '']))
          });
      if (approvedFingerprints.has(fingerprint)) return true;

      // Turn-view mode keeps ink MOUNTED with the stdout capture active,
      // so the raw y/a/n prompt below would be swallowed into <Static>
      // and the spinner sink would repaint over it. Do exactly what the
      // permission picker does: pause (unmount + suspend the capture via
      // onPauseInTurn) for the prompt, resume after. On the default path
      // ink is already paused for the turn, so isTurnMode() is false and
      // this is a no-op.
      const trustInk = rl as InkLineInterface;
      const trustInTurn = trustInk?.isTurnMode?.() === true;
      if (trustInTurn) trustInk.pause();

      // The trust gate fires mid-turn while ink is paused for the
      // agent. Earlier shapes of this gate resumed ink to use the
      // composer as the input mechanism — that painted a fresh ink
      // frame which snapshotted into scrollback when we re-paused
      // for the rest of the turn, leaving stray composer boxes
      // littered through the conversation. We now do exactly what
      // the permission picker does: stay paused, write the info
      // directly to stdout (lands cleanly at the cursor, above
      // where the next ink mount will land), show a one-line
      // y/a/n picker, and read a single keystroke via a transient
      // readline keypress listener.
      //
      // Adding a keypress listener also flips my pause()'s data
      // listener into sub-flow mode (it sees listenerCount('keypress')
      // > 0 and stays out of the way) so we don't double-handle
      // bytes and don't leak the keystroke into the type-ahead
      // buffer.
      spinner.pauseFor(300_000);

      process.stdout.write('\n' + c.yellow(`  ${glyph.warn} MCP trust check`) + '\n');
      process.stdout.write(c.dim('     server:  ') + c.cyan(name) + '\n');
      if (params.kind === 'url') {
        process.stdout.write(c.dim('     url:     ') + c.cyan(params.url) + '\n');
        process.stdout.write(c.dim('     auth:    ') + c.cyan(params.authKind) + '\n');
        process.stdout.write(c.dim('     Bandit is about to open a Streamable HTTP connection to this remote server.') + '\n\n');
      } else {
        process.stdout.write(c.dim('     command: ') + c.cyan(`${params.command}${params.args.length ? ' ' + params.args.join(' ') : ''}`) + '\n');
        if (params.envKeys.length) {
          process.stdout.write(c.dim('     env keys: ') + c.cyan(params.envKeys.join(', ')) + '\n');
        }
        process.stdout.write(c.dim('     Bandit is about to spawn this child process.') + '\n\n');
      }
      process.stdout.write(
        '     ' +
        c.accent('[y]') + c.dim(' allow once    ') +
        c.accent('[a]') + c.dim(' always allow    ') +
        c.accent('[n]') + c.dim(' deny    ') +
        c.dim('(Esc to cancel)  > ')
      );

      readline.emitKeypressEvents(process.stdin);
      const stdinWasRaw = process.stdin.isRaw === true;
      if (process.stdin.isTTY && !stdinWasRaw) {
        try { process.stdin.setRawMode?.(true); } catch { /* non-fatal */ }
      }

      const answer = await new Promise<'y' | 'a' | 'n'>((resolve) => {
        const onKey = (_str: string, key: { name?: string; ctrl?: boolean; sequence?: string } | undefined) => {
          if (!key) return;
          if (key.ctrl && key.name === 'c') {
            process.stdin.off('keypress', onKey);
            process.stdout.write(c.dim('\n     ↷ cancelled\n'));
            resolve('n');
            return;
          }
          if (key.name === 'escape') {
            process.stdin.off('keypress', onKey);
            process.stdout.write(c.dim('\n     ↷ cancelled\n'));
            resolve('n');
            return;
          }
          if (key.name === 'y' || key.name === 'a' || key.name === 'n') {
            process.stdin.off('keypress', onKey);
            const label = key.name === 'y' ? 'allow once'
              : key.name === 'a' ? 'always allow'
                : 'deny';
            process.stdout.write(c.cyan(key.name) + c.dim(` (${label})\n\n`));
            resolve(key.name);
            return;
          }
          // Ignore any other key — the gate stays open until the
          // user picks one of the three documented choices.
        };
        process.stdin.on('keypress', onKey);
      });

      if (process.stdin.isTTY && !stdinWasRaw) {
        try { process.stdin.setRawMode?.(false); } catch { /* non-fatal */ }
      }

      // Re-mount the turn view + reinstall the stdout capture (via
      // onResumeInTurn) now that the prompt is answered. Both returns
      // below are after this, so it always runs.
      if (trustInTurn) trustInk.resume();

      if (answer === 'a') {
        await approveMcpFingerprint(fingerprint).catch(() => { /* best effort */ });
        approvedFingerprints.add(fingerprint);
        return true;
      }
      return answer === 'y';
    },
    // Persist each server's tool list after first successful spawn so
    // the next session can prime the pool from disk and skip the
    // enumeration spawn entirely. That's what stops the trust prompt
    // from firing on prompts that don't use MCP at all.
    onToolsDiscovered: (name, fingerprint, tools) => {
      void saveMcpToolEntry(name, fingerprint, tools);
    }
  });
  // Prime the pool with each server's cached tool list. The first
  // turn no longer has to spawn just to enumerate — discoverTools
  // returns the cached list instantly. The trust gate (and the spawn
  // it guards) only fires when the agent actually calls a tool via
  // pool.callTool, which is the point: "ask when it needs to use MCP."
  //
  // Defined as a closure because `/mcp reload` must run the SAME prime:
  // registerMcpServersFromDisk re-register()s every server, and
  // register() disposes the prior entry — dropping its in-memory
  // cachedTools. Without re-priming, a post-reload prompt that doesn't
  // mention a trigger word hits getAllMcpAgentTools' first-spawn gate
  // (no cache + not mentioned → skip) and the server's tools silently
  // fail to register, so the model sees "<server>.<tool> not registered"
  // and falls back to shell. Re-priming from disk after reload restores
  // the cached tool list so registration survives a reload.
  const primeMcpDiscoveryCacheFromDisk = async (): Promise<void> => {
    if (mcpPool.list().length === 0) return;
    try {
      const cache = await loadMcpToolCache();
      const activeFingerprints = new Set<string>();
      for (const snap of mcpPool.snapshot()) {
        const fingerprint = fingerprintServerConfig(snap.name, snap.config);
        activeFingerprints.add(fingerprint);
        const cached = cache.get(fingerprint);
        if (cached) mcpPool.primeDiscoveryCache(snap.name, fingerprint, cached);
      }
      // Drop entries for servers that no longer exist or whose config
      // has changed — the file grows unbounded otherwise.
      void pruneMcpToolCache(activeFingerprints);
    } catch {
      // Cache miss / read failure is non-fatal; pool falls back to a
      // live spawn on first discoverTools.
    }
  };

  const mcpRegistered = await registerMcpServersFromDisk(cwd, mcpPool);
  await primeMcpDiscoveryCacheFromDisk();
  if (mcpRegistered > 0) {
    process.stdout.write(c.dim(`[mcp] ${mcpRegistered} server${mcpRegistered === 1 ? '' : 's'} configured (lazy connect on first use)\n`));
  } else {
    // Zero-servers visibility — until this lands the failure mode is
    // silent: the user runs `/mcp google connect` (succeeds), expects
    // Gmail tools, gets a confused "I don't have a Google MCP" from
    // the agent because the OAuth handshake didn't write the server
    // stanza. Now surface the gap with a one-liner pointing at the
    // global config. If the user has a Bandit cloud key set we hint
    // at `/mcp google connect` since that's the most likely intent.
    const homeMcpPath = path.join(os.homedir(), '.bandit', 'mcp-servers.json');
    // Cheap signal — if the user has a Bandit cloud key via env or
    // CLI flag, they're more likely to want the Google MCP path than
    // a bare config-paste suggestion. fileConfig isn't loaded yet at
    // this point in REPL boot, so this misses a config-file-only key;
    // worth accepting in exchange for not reshuffling boot order.
    const hasCloudKey = Boolean(process.env.BANDIT_API_KEY || overrides.apiKey);
    const hint = hasCloudKey
      ? `${c.cyan('/mcp google connect')} to register the Burtson MCP server, or paste a config at ${c.cyan(homeMcpPath)}`
      : `paste a config at ${c.cyan(homeMcpPath)} (see docs/integration-playlist/mcp-roadmap.md)`;
    process.stdout.write(c.dim(`[mcp] no servers configured — ${hint}\n`));
  }
  /**
   * Pull every completed/failed/cancelled background task that the
   * agent hasn't seen yet, mark them consumed, and prepend their
   * synopses to the user's prompt as a synthetic system-style
   * preamble. The agent sees something like:
   *
   * [Background tasks completed since last turn]
   * - bg123 (12.3s, 4 iter): <synopsis>
   *
   * <original user prompt>
   *
   * Returns the original prompt unchanged when no completions are
   * pending — the common case mid-conversation.
   */
  const drainBackgroundCompletions = (userPrompt: string): string => {
    const ready = backgroundStore.list().filter((t) => !t.consumed && t.status !== 'running');
    if (ready.length === 0) return userPrompt;
    const lines: string[] = ['[Background tasks completed since last turn]'];
    for (const t of ready) {
      const seconds = ((t.endedAt ?? Date.now()) - t.startedAt) / 1000;
      const head = `- ${t.id} · ${t.status} (${seconds.toFixed(1)}s, ${t.iterations} iter) · "${t.goal.slice(0, 80)}${t.goal.length > 80 ? '…' : ''}"`;
      if (t.status === 'completed' && t.synopsis) {
        lines.push(`${head}\n${t.synopsis}`);
      } else if (t.status === 'failed' && t.error) {
        lines.push(`${head}\n  error: ${t.error}`);
      } else {
        lines.push(head);
      }
      backgroundStore.markConsumed(t.id);
    }
    return `${lines.join('\n\n')}\n\n${userPrompt}`;
  };
  // Print a CLI status line each time a background task hits a
  // terminal state, so the user sees movement without staring at the
  // status bar. We print on the next safe stdout write — between
  // prompt cycles — by stashing the message and flushing on the next
  // status-bar render. (Direct stdout writes from an async listener
  // would race with readline's prompt redraw.)
  const pendingBackgroundNotices: string[] = [];
  // Mid-turn injection queue (v1.7.336). When a background subagent
  // completes WHILE the parent loop is still iterating, the synopsis
  // gets queued here and the loop drains it at the start of its next
  // iteration via `drainExternalMessages`. Eliminates the poll-loop
  // wedge — was burning 30+ check_task calls across 15 iterations
  // waiting for 3 subagents to finish when it could have just been
  // notified at each completion.
  //
  // markConsumed is called eagerly when we inject so the next-user-turn
  // `drainBackgroundCompletions` doesn't deliver the same synopsis a
  // second time. Failed and cancelled tasks also inject — the parent
  // needs to know about failures to decide whether to re-spawn or
  // synthesize without that subagent's data.
  const pendingBackgroundInjections: ToolLoopMessage[] = [];
  const enqueueBackgroundCompletion = (record: BackgroundTaskRecord): void => {
    if (record.consumed) return;
    const seconds = ((record.endedAt ?? Date.now()) - record.startedAt) / 1000;
    const title = record.goal.length > 60 ? record.goal.slice(0, 57).trim() + '…' : record.goal;
    let body: string;
    if (record.status === 'completed') {
      body = `[Background task "${title}" completed in ${seconds.toFixed(1)}s, ${record.iterations} iter]\n${record.synopsis ?? '(no synopsis)'}`;
    } else if (record.status === 'failed') {
      body = `[Background task "${title}" FAILED after ${seconds.toFixed(1)}s, ${record.iterations} iter]\nError: ${record.error ?? 'unknown error'}\n\nDecide whether to retry this scope, work around it, or proceed without that subagent's findings.`;
    } else if (record.status === 'cancelled') {
      body = `[Background task "${title}" cancelled after ${seconds.toFixed(1)}s, ${record.iterations} iter]`;
    } else {
      return; // 'running' shouldn't reach here, defensive
    }
    pendingBackgroundInjections.push({ role: 'user', content: body });
    backgroundStore.markConsumed(record.id);
  };
  backgroundStore.on('complete', enqueueBackgroundCompletion);
  backgroundStore.on('failed', enqueueBackgroundCompletion);
  backgroundStore.on('cancelled', enqueueBackgroundCompletion);
  // Auto-resume after the LAST outstanding background subagent
  // settles — feeds the drained synopses into a fresh turn without
  // waiting for the user to prompt. Guards: no active turn, no REPL
  // worker running, empty lineQueue, no subagents still running, at
  // least one unconsumed task to drain.
  const maybeAutoResumeAfterBackground = () => {
    if (activeTurnController) return;
    if (workerRunning) return;
    if (lineQueue.length > 0) return;
    if (backgroundStore.listByStatus('running').length > 0) return;
    const unread = backgroundStore.list().filter((t) => !t.consumed && t.status !== 'running');
    if (unread.length === 0) return;
    process.stdout.write(
      '\n' + c.dim(`  ${glyph.spark} resuming — ${unread.length} background subagent${unread.length === 1 ? '' : 's'} ready\n`)
    );
    lineQueue.push('(continuing after background subagent results)');
    void drainQueue();
  };
  backgroundStore.on('complete', (record) => {
    pendingBackgroundNotices.push(
      c.dim(`  ${glyph.check} background task ${record.id} completed`)
    );
    sendNotification({
      kind: 'background',
      title: 'Bandit background task complete',
      message: `${record.id}: ${record.goal.slice(0, 160)}`
    });
    maybeAutoResumeAfterBackground();
  });
  backgroundStore.on('failed', (record) => {
    pendingBackgroundNotices.push(
      c.red(`  ${glyph.cross} background task ${record.id} failed: ${record.error ?? 'unknown'}`)
    );
    sendNotification({
      kind: 'error',
      title: 'Bandit background task failed',
      message: `${record.id}: ${record.error ?? record.goal}`
    });
    maybeAutoResumeAfterBackground();
  });
  backgroundStore.on('cancelled', (record) => {
    pendingBackgroundNotices.push(
      c.dim(`  ${glyph.bullet} background task ${record.id} cancelled`)
    );
    maybeAutoResumeAfterBackground();
  });
  // Cached git branch for the status bar — updated lazily on the first
  // status-bar render and refreshed every ~30s. Avoids spawning a
  // git child process on every prompt cycle which would be visible
  // input lag on slow disks.
  let cachedGitBranch: string | null = null;
  let gitBranchCheckedAt = 0;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cliVersion = (require('../package.json') as { version: string }).version;
  // Fire-and-forget npm registry check on boot. When a newer version
  // is published, the footer hint swaps in a dim "→ v1.7.x available"
  // line so users notice without us nagging mid-prompt. We only set
  // the value if the fetch resolves with a strictly newer semver —
  // network failures are silent (no user-visible noise on offline
  // boots, behind corporate proxies, etc.).
  let latestRemoteVersion: string | null = null;
  void (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2_500);
      const res = await fetch(
        'https://registry.npmjs.org/@burtson-labs/bandit-stealth-cli/latest',
        { signal: ctrl.signal, headers: { accept: 'application/json' } }
      );
      clearTimeout(timer);
      if (!res.ok) return;
      const body = (await res.json()) as { version?: string };
      const remote = typeof body.version === 'string' ? body.version : null;
      if (!remote || remote === cliVersion) return;
      // Naive semver compare — enough for our linear x.y.z scheme.
      const parse = (v: string): number[] =>
        v.split('.').map((n) => parseInt(n, 10) || 0);
      const [a1, a2, a3] = parse(cliVersion);
      const [b1, b2, b3] = parse(remote);
      const isNewer =
        b1 > a1 ||
        (b1 === a1 && b2 > a2) ||
        (b1 === a1 && b2 === a2 && b3 > a3);
      if (isNewer) latestRemoteVersion = remote;
    } catch {
      /* offline / proxy / DNS — silent */
    }
  })();
  process.stdout.write(launchBanner(cliVersion) + '\n\n');

  // Tips for getting started + Recent activity. Cheap heuristics decide
  // which tips fire so the section adapts to the user's current cwd:
  // - in $HOME / no project → suggest cd-ing into a real repo
  // - no BANDIT.md → suggest /init
  // - first session → suggest `?` for shortcuts
  // Recent activity reads the last few session ids from the store so
  // returning users see what they were working on.
  try {
    const homeDir = os.homedir();
    const isHomeDir = path.resolve(cwd) === path.resolve(homeDir);
    const banditMdExists =
      fs.existsSync(path.join(cwd, 'BANDIT.md')) ||
      fs.existsSync(path.join(cwd, '.bandit', 'BANDIT.md'));
    const tips: string[] = [];
    if (isHomeDir) {
      tips.push(
        `${c.dim('Note:')} you launched bandit in ${c.cyan('~')}. For best results, cd into a project directory first.`
      );
    }
    if (!banditMdExists) {
      tips.push(
        `Run ${c.cyan('/init')} to create a ${c.cyan('BANDIT.md')} file with project memory.`
      );
    }
    tips.push(`Run ${c.cyan('/doctor')} when Bandit feels confusing — it checks setup, provider, permissions, and next actions.`);
    tips.push(`Type ${c.accent('?')} for shortcuts or ${c.cyan('/help permissions')} for approval choices.`);
    // First-run nudge: when there's no saved config AND no provider
    // env var, point the user at /connect — the interactive wizard
    // that picks Ollama / Bandit Cloud / OpenAI-compatible (LM Studio,
    // OpenRouter, Together, Groq, etc.) and writes the choice to
    // ~/.bandit/config.json. Without this hint the openai-compatible
    // surface (shipped) is invisible — the enum value exists
    // but there's no breadcrumb pointing at it. Skip the hint when the
    // user already has a saved config (every subsequent run).
    try {
      const cfgPath = path.join(os.homedir(), '.bandit', 'config.json');
      const noConfig = !fs.existsSync(cfgPath);
      const noEnv = !process.env.BANDIT_PROVIDER && !process.env.BANDIT_API_KEY;
      if (noConfig && noEnv) {
        tips.push(
          `${c.green('First run?')} ${c.cyan('/connect')} ${c.dim('— pick a provider (Ollama, Bandit Cloud, or any OpenAI-compatible upstream like LM Studio, OpenRouter, Together, Groq…).')}`
        );
      } else {
        tips.push(`Switch or set up a provider: ${c.cyan('/connect')} ${c.dim('(wizard)')} or ${c.cyan('/provider <name>')} ${c.dim('(direct).')}`);
      }
    } catch {
      tips.push(`Switch providers fast: ${c.cyan('/provider ollama')} or ${c.cyan('/provider bandit')} — keeps your saved settings.`);
    }
    // Cloud-onboarding nudge. Surface a one-liner pointing at /login
    // when the user has selected the bandit provider (env or saved
    // config) but has no API key on file. The /login slash command is
    // a deterministic, non-LLM path to set the key — important for
    // users testing on small local models that struggle to walk them
    // through editing ~/.bandit/config.json by hand.
    try {
      const globalCfgPath = path.join(os.homedir(), '.bandit', 'config.json');
      const wantsCloud =
        (process.env.BANDIT_PROVIDER ?? '').toLowerCase() === 'bandit';
      let hasKey = !!process.env.BANDIT_API_KEY;
      let savedProvider: string | undefined;
      if (fs.existsSync(globalCfgPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(globalCfgPath, 'utf-8')) as {
            provider?: string;
            bandit?: { apiKey?: string };
          };
          if (parsed.bandit?.apiKey) hasKey = true;
          savedProvider = parsed.provider;
        } catch {
          /* corrupt config — silently ignore here, /config will surface it */
        }
      }
      const onCloud = wantsCloud || savedProvider === 'bandit';
      if (onCloud && !hasKey) {
        tips.push(
          `${c.red('No Bandit Cloud API key on file.')} Run ${c.cyan('/login <key>')} to save one (get one at ${linkify('https://burtson.ai')}).`
        );
      }
    } catch {
      /* never let the cloud-key probe break boot */
    }

    const recentIds = await session.list().catch(() => [] as string[]);
    const formatId = (id: string): string => {
      // Session ids are `YYYYMMDD-HHMMSS-xxxx`. Surface a friendlier
      // label when we can parse it; fall back to the raw id otherwise.
      const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id);
      if (!m) return id;
      const [, y, mo, d, h, mi] = m;
      return `${y}-${mo}-${d} ${h}:${mi}`;
    };

    process.stdout.write(`  ${c.bold('Tips for getting started')}\n`);
    for (const t of tips) process.stdout.write(`    ${c.dim('•')} ${t}\n`);
    process.stdout.write('\n');
    process.stdout.write(`  ${c.bold('Recent activity')}\n`);
    if (recentIds.length === 0) {
      process.stdout.write(`    ${c.dim('No recent activity')}\n`);
    } else {
      for (const id of recentIds.slice(0, 3)) {
        process.stdout.write(`    ${c.dim('•')} ${c.dim(formatId(id))}\n`);
      }
    }
    process.stdout.write('\n');
  } catch {
    /* never let the tips block break boot */
  }

  process.stdout.write(c.dim(`  ${glyph.spark} booting…\n`));

  const fileConfig = await loadConfigFiles(cwd);

  // Apply saved theme on every boot. If no theme is saved (first run
  // ever), fire the picker before anything else writes colored output
  // — that way the entire session uses the user's pick, including the
  // boot status messages below.
  if (fileConfig.theme) {
    setActiveTheme(fileConfig.theme);
  } else if (process.stdout.isTTY) {
    const picked = await runFirstRunThemePicker();
    if (picked) {
      setActiveTheme(picked);
      await saveTheme(picked);
      fileConfig.theme = picked;
    }
  }

  const initialResolved = resolveConfig(fileConfig, overrides);
  const initialBundle = buildProviderSettings(initialResolved);
  let { settings, model, kind } = initialBundle;
  let resolved = initialResolved;
  // App-level telemetry (OTLP) — opt-in, off by default. One exporter per
  // session; the emitEvent funnel + turn loop call the module helpers. Bearer
  // defaults to the signed-in Bandit token.
  const telemetryCfg = resolveTelemetryConfig({ telemetry: fileConfig.telemetry, banditApiKey: resolved.apiKey });
  if (initTelemetry(telemetryCfg) && telemetryCfg) {
    process.stdout.write(c.dim(`  ${glyph.spark} telemetry on · ${telemetryCfg.endpoint}`) + '\n');
  }
  const sendNotification = (notification: CliNotification): void => {
    notifyCli(resolved.notifications, notification);
  };
  const modelWasExplicit = initialBundle.modelWasExplicit;
  // Lazy-fetch model capabilities from models.dev for openai-compatible
  // upstreams. Without this, an LM Studio user pointing at
  // `qwen2.5-coder-32b-instruct` would inherit the conservative
  // small-tier defaults (8K context, 1K output budget, no vision
  // routing) — Models.dev knows the real numbers. Fire-and-forget so a
  // network hiccup doesn't slow startup; the runtime cache is populated
  // by the time the first chat call resolves capabilities. Catalog is
  // disk-cached for 24h so repeat runs skip the round-trip entirely.
  if (kind === 'openai-compatible' && resolved.openaiBaseUrl && resolved.model) {
    void (async () => {
      const fromCatalog = await queryModelsDevCapabilities(resolved.model, resolved.openaiBaseUrl!);
      if (fromCatalog) {
        registerModelCapabilities(resolved.model, fromCatalog);
        return;
      }
      // Local servers (LM Studio, vLLM, llama.cpp) match nothing in the
      // models.dev catalog — fall back to the server's own GET /v1/models.
      // vLLM/OpenRouter report the served context window there; everything
      // else from the prefix-matched profile stays as-is (tier deliberately
      // NOT derived from context length — a 7B model can serve 128K).
      const probed = await queryOpenAICompatibleModelInfo(
        resolved.model,
        resolved.openaiBaseUrl!,
        resolved.openaiApiKey
      );
      if (probed?.exists && probed.contextWindow) {
        const base = getModelCapabilities(resolved.model);
        registerModelCapabilities(resolved.model, {
          ...base,
          contextWindow: probed.contextWindow,
          label: resolved.model
        });
      }
    })().catch(() => undefined);
  }
  // Same lazy discovery for direct Ollama: /api/show reports the model's
  // real context length, parameter tier, and tool-calling capability.
  // Without it, any community model outside the built-in capability table
  // (mistral, phi4, granite, deepseek-r1, codellama…) runs with the
  // worst-case defaults — 8K context assumed, native tools off. Built-in
  // profiles still win over this cache (precedence rule in
  // getModelCapabilities), so the probe only upgrades unknowns. Local
  // call, 5s timeout, silent on failure.
  const probeOllamaCapabilities = (modelId: string): void => {
    if (settings.kind !== 'ollama' || !modelId) {return;}
    const baseUrl = settings.ollamaUrl ?? resolved.ollamaUrl ?? 'http://localhost:11434';
    void queryOllamaModelCapabilities(modelId, baseUrl)
      .then(caps => { if (caps) {registerModelCapabilities(modelId, caps);} })
      .catch(() => undefined);
  };
  probeOllamaCapabilities(model);
  // Per-session thinking-mode override. undefined = use the runtime
  // default for the active model (off for reasoning models, absent
  // for non-reasoning). Toggled via the `/think on|off|auto` slash
  // command. Read on every chat request via buildChat's getThink().
  let sessionThinkingOverride: boolean | undefined = undefined;
  // co-author trailer toggle. Default ON: Bandit appends
  // `Co-authored-by: Bandit <bandit@burtson.ai>` to commits it issues
  // on the user's behalf so the Bandit ninja shows up on GitHub PR /
  // blame / contributor views. Resolves in priority order:
  // 1. BANDIT_NO_COAUTHOR=1 env (highest — hard off, ignores config)
  // 2. /coauthor on|off slash command this session (in-memory)
  // 3. `coauthor: false` in ~/.bandit/config.json (persistent)
  // 4. default true
  // Slash-command opt-out also persists to config; env opt-out is
  // process-scoped so power-users can disable per-shell without
  // touching their config file.
  const coauthorEnvOff = /^(1|true)$/i.test(process.env.BANDIT_NO_COAUTHOR ?? '');
  let sessionCoauthor: boolean = coauthorEnvOff
    ? false
    : (resolved.coauthor !== false);
  // session-level watchdog override. Initialised from
  // `~/.bandit/config.json` watchdogMs (if present) and mutable via
  // `/watchdog`. The env var BANDIT_NO_TOKEN_WATCHDOG_MS overrides
  // both at the chat-call site, so a per-shell diagnostic value
  // beats the persisted preference. `undefined` means "no override —
  // use the auto-scale formula".
  let sessionWatchdogMs: number | undefined = resolved.watchdogMs;
  // When true, each prompt runs the heuristic planner first and asks
  // y/N before the real execution. Toggled via `/plan-preview on`.
  let sessionPlanPreview = false;
  // First time the user types a `!`-prefix command in a session, we
  // explain that it bypasses the agent's run_command allow-list and
  // ask for explicit consent. Subsequent invocations skip the gate.
  // The `!`-prefix is a power-user shortcut and the warning needs to
  // be loud the first time so people don't conflate it with the
  // model-driven path (where every command goes through allow-list +
  // permission gate). Set to true once they've ack'd in the session.
  let sessionBangAck = false;
  // Per-turn AbortController, populated only while a turn is actively
  // running. Esc keypress checks this; non-null = "in flight, cancel
  // is meaningful". Cleared back to null after the turn settles. The
  // status bar reads from this to decide whether to render the "Esc
  // to stop" hint.
  let activeTurnController: AbortController | null = null;
  // Per-turn timing. `turnStartedAt` is stamped when each real LLM turn
  // begins; `lastTurnMs` holds the most-recent completed turn's wall-
  // clock. The status bar shows THIS (active turn elapsed, or last turn
  // duration) instead of session-since-boot — the old display sat next
  // to "N turns" and read as if a single turn took the whole session,
  // which confused everyone (a near-instant answer showed "1 turn ·
  // 6m29s" because that was cumulative idle + work since launch).
  let turnStartedAt = 0;
  let lastTurnMs = 0;
  // Terminal window/tab title — "<glyph> <task> — Bandit" via OSC 0 (sets
  // icon + title; no-op when stdout isn't a TTY). The U+FE0F after the ninja
  // forces the solid color emoji over a hollow text glyph. We do NOT set
  // process.title: on macOS it leaks adjacent env memory
  // (__CFBundleIdentifier=…) into Terminal's process slot. The host's
  // "node …/cli.js" still shows in that SEPARATE slot when the terminal's
  // active-process title component is on — a terminal setting, not the OSC.
  const TITLE_PREFIX = '🥷️';
  // Bind the REAL stdout writer now, before the turn-view ever monkeypatches
  // process.stdout.write. The title OSC must bypass that capture: routed
  // through it (e.g. the reset-to-idle at turn end, which runs while the
  // capture is still active), the <Static> re-emit splits the escape and
  // strict terminals (Apple Terminal) print orphaned `]0;…` / `[` as literal
  // text — the "rogue brackets".
  const writeTitleRaw = process.stdout.write.bind(process.stdout);
  const setWindowTitle = (title: string): void => {
    if (!process.stdout.isTTY || process.env.BANDIT_NO_TITLE) return;
    const clean = title.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);
    // Empty body clears the title back to the terminal default (used on exit).
    const out = clean ? `${TITLE_PREFIX} ${clean}` : '';
    writeTitleRaw(`\x1b]0;${out}\x07`);
  };
  const idleWindowTitle = 'Bandit';
  setWindowTitle(idleWindowTitle);
  // Pre-flight the Ollama model so we don't 404 mid-prompt. If the user
  // didn't specify BANDIT_MODEL, silently swap to the closest installed
  // variant so common suffix differences (-it-qat, -it-q4_K_M) Just Work.
  if (kind === 'ollama') {
    process.stdout.write(c.dim(`  ${glyph.spark} checking ollama (${settings.ollamaUrl})…\n`));
    const check = await validateOllamaModel(model, settings.ollamaUrl ?? '', !modelWasExplicit);
    if (!check.ok) {
      process.stderr.write(c.red('✗ ') + check.message + '\n');
      process.exit(1);
    }
    if (check.autoSwitched) {
      if (modelWasExplicit) {
        process.stdout.write(c.dim(`${glyph.info} ${check.fromModel} not pulled — using ${c.accent(check.model)} instead\n`));
      }
      model = check.model;
      settings.ollamaModel = check.model;
      resolved = { ...resolved, model: check.model };
    }
  }
  process.stdout.write(c.dim(`  ${glyph.spark} loading skills + memory…\n`));
  // Kick off the three independent loaders in parallel so the slowest
  // (usually skill discovery on big workspaces) sets the wall-clock,
  // not the sum. Shaves ~200-600ms on cold starts.
  const [skillRegistry, hookSettings, memory] = await Promise.all([
    loadSkills(cwd),
    loadHookSettings(cwd),
    loadCombinedMemory(cwd)
  ]);
  const todoStore = new TodoStore();
  const permissionStore = new SessionPermissionStore();

  await session.init();
  if (!session.currentId) await session.startNew();
  const conversation = await session.readConversation();

  const skillCount = skillRegistry.getAll().length;
  const memorySummary = memory.sources.length ? `memory: ${memory.sources.join(', ')}` : 'no memory files';

  // Clear the three boot-status lines we wrote above before printing the
  // final status row so the terminal ends up looking like a clean launch
  // rather than a log of every step. \x1b[2K clears the current line,
  // \x1b[1A moves the cursor up one row — repeat three times.
  const bootLines = kind === 'ollama' ? 4 : 3; // banner-blank + booting + (ollama?) + loading
  for (let i = 0; i < bootLines - 1; i++) {
    process.stdout.write('\x1b[1A\x1b[2K');
  }

  const bootMs = Date.now() - bootStartedAt;
  const isLocalOllama = kind === 'ollama' && settings.ollamaUrl === 'http://localhost:11434';
  const endpointLabel = kind === 'ollama'
    ? (isLocalOllama ? 'local' : (settings.ollamaUrl ?? 'local'))
    : (settings.apiUrl ?? 'api.burtson.ai');
  // "local · private" makes it explicit that nothing leaves the machine when
  // running against a localhost Ollama; "cloud" flags the opposite so a new
  // user can trust the intro without reading docs.
  const modeLabel = isLocalOllama
    ? c.green('local · private')
    : kind === 'ollama'
      ? c.yellow('remote ollama')
      : c.yellow('cloud');
  process.stdout.write(c.dim(`  ${kind}/${model}  •  ${endpointLabel}  •  `) + modeLabel + c.dim(`  •  ${skillCount} skills  •  ${memorySummary}  •  ${session.currentId}  •  booted in ${bootMs}ms\n`));
  if (conversation.length > 0) {
    process.stdout.write(c.dim(`  ${glyph.info} resumed with ${conversation.length} prior messages\n`));
  }
  process.stdout.write('\n' + c.dim(`  Type ${c.cyan('/help')} for commands, ${c.cyan('@path')} to pin a file, ${c.cyan('Ctrl+V')} to paste a clipboard image, or ${c.cyan('exit')} to quit.\n\n`));

  // @-mention Tab completer. When the user types `@src/auth/lo<TAB>`,
  // readline passes the whole line to the completer; we extract the
  // trailing @-token, walk the workspace (skipping IGNORED dirs) for
  // matching files and dirs, and return completions. readline does the
  // rest — single match inserts, multiple show the list + common
  // prefix. No picker UI needed; uses the terminal's built-in flow.
  const completer = (line: string): [string[], string] => {
    // Only the LAST @-token on the line is considered — if the prompt
    // is "explain @a.ts and @b.t<TAB>", we complete "b.t" not both.
    const match = line.match(/@([^\s@]*)$/);
    if (!match) return [[], line];
    const query = match[1];
    const matches = fuzzyMatchWorkspaceFiles(cwd, query, 30);
    if (matches.length === 0) return [[], match[0]];
    // readline's contract: return [completions, substring-being-completed].
    // The completions include the `@` prefix so a single exact match
    // replaces the user's "@b.t" with "@b.ts" cleanly.
    return [matches.map(m => `@${m}`), match[0]];
  };
  // Ink input layer is the DEFAULT as of v1.7.310 — the persistent
  // bordered frame, Static-committed scrollback, and @-overlay are
  // strictly better than the readline + ANSI cursor-dance variant
  // (which couldn't survive wrap/resize/multi-line paste). The legacy
  // readline path stays available behind `--no-ink` / `BANDIT_INK_INPUT=0`
  // as a fallback for environments where ink misbehaves.
  const useInk = process.env.BANDIT_INK_INPUT !== '0';
  // Turn-view (ink-owns-turn): keep ink mounted THROUGH the turn so a
  // persistent composer + in-place plan tree + status stay pinned while
  // the model streams, instead of pausing/unmounting for the turn. Now the
  // DEFAULT for the ink path (proven across the TTY matrix in
  // docs/ink-turn-view-plan.md). Opt OUT with BANDIT_TURN_VIEW=0 to fall
  // back to the pause-for-the-turn behavior; --no-ink disables it too.
  const useTurnView = useInk && process.env.BANDIT_TURN_VIEW !== '0';
  // Shared helper used by both keypress handlers (readline path) and the
  // ink onCtrlV callback. Reads the clipboard, writes the image into
  // `.bandit/pastes/` and returns the `@<rel> ` mention to inject — or
  // null if there's no image (e.g. clipboard has plain text instead).
  const handleClipboardImagePaste = async (): Promise<string | null> => {
    const img = await readClipboardImage();
    if (!img) return null;
    try {
      const destDir = path.join(cwd, '.bandit', 'pastes');
      fs.mkdirSync(destDir, { recursive: true });
      const destName = `paste-${Date.now()}.png`;
      const destPath = path.join(destDir, destName);
      try { fs.renameSync(img.path, destPath); }
      catch { fs.copyFileSync(img.path, destPath); try { fs.unlinkSync(img.path); } catch { /* best-effort */ } }
      const rel = path.relative(cwd, destPath);
      const kb = Math.round(img.sizeBytes / 1024);
      // Use console.log — ink 7 patches console.* through its frame-aware
      // writer that re-renders the live composer below the new output.
      // Direct process.stdout.write breaks ink's render tracking: it
      // doesn't know the cursor moved, so the next ink render lands
      // BELOW the now-wrong position and the previous composer frame
      // gets stranded above as scrollback (which is what surfaced as
      // duplicate composer boxes after every paste).
      console.log('\n' + c.dim(`  ${glyph.check} image pasted (${kb} KB) → ${c.cyan(rel)}`));
      return `@${rel} `;
    } catch (err) {
      process.stdout.write('\n' + c.red(`  ${glyph.cross} clipboard paste failed: ${err instanceof Error ? err.message : String(err)}\n`));
      return null;
    }
  };
  // Build the line interface. The ink variant exposes the same surface
  // as readline.Interface (line, cursor, write, prompt, setPrompt,
  // pause, resume, close, on('line'|'close')) so the ~80 downstream
  // references work without per-site changes.
  // In-session history list for the ink path's Up/Down recall. Readline
  // has its own history; ink doesn't, so we keep a small array of every
  // submitted line and walk it on arrow-key press. Capped to 200 to
  // avoid unbounded growth in long-running REPLs.
  const inkHistory: string[] = [];
  let inkHistoryCursor = -1;
  const HISTORY_MAX = 200;
  const rl: readline.Interface | InkLineInterface = useInk
    ? createInkLineInterface({
        cwd,
        // Rich tip pinned to the bottom under the input box. ink redraws
        // this in-place per render — no scrollback cost — so showing
        // the menu of common entry points (doctor / review / @path /
        // Ctrl+V image) costs nothing visually and saves the user from
        // having to press `?` to discover them.
        footerTip: '? shortcuts  ·  /doctor setup  ·  /review changes  ·  @path pin  ·  Ctrl+V image',
        completer,
        // Synchronous workspace match for the @-mention overlay. Uses
        // the same fuzzyMatchWorkspaceFiles helper the readline Tab
        // completer relies on — single source of truth for file scoring.
        searchFiles: (q) => fuzzyMatchWorkspaceFiles(cwd, q, 30),
        onCtrlV: handleClipboardImagePaste,
        onActivity: () => {
          if (activeTurnController) spinner.pauseFor(1500);
        },
        historyPrev: () => {
          if (inkHistory.length === 0) return undefined;
          if (inkHistoryCursor === -1) inkHistoryCursor = inkHistory.length;
          inkHistoryCursor = Math.max(0, inkHistoryCursor - 1);
          return inkHistory[inkHistoryCursor];
        },
        historyNext: () => {
          if (inkHistoryCursor === -1) return undefined;
          inkHistoryCursor += 1;
          if (inkHistoryCursor >= inkHistory.length) {
            inkHistoryCursor = -1;
            return '';
          }
          return inkHistory[inkHistoryCursor];
        },
        // Mid-turn typing → live echo in the spinner dock's composer row.
        // (During a turn the ink frame is unmounted; the spinner owns the
        // bottom region, so the composer rides along with the plan dock.)
        onTurnType: (buffer: string) => {
          if (activeTurnController) spinner.setComposer(buffer);
        },
        // Mid-turn Enter → queue the line to run after the current turn,
        // restoring the readline path's "send while the AI is working."
        // lineQueue / drainQueue are captured here and only invoked mid-
        // turn (long after they're initialized below).
        onTurnSubmit: (line: string) => {
          lineQueue.push(line);
          spinner.setComposer('');
          spinner.note(c.dim(`  ${glyph.check} queued — runs after this turn: `) + c.cyan(line));
          void drainQueue();
        },
        // Turn-view sub-flow plumbing: suspend/reinstall the mid-turn
        // stdout capture around a pause/resume so a sub-flow that owns raw
        // stdin (the permission picker's arrow menu) renders straight to
        // the terminal instead of into <Static> while ink is unmounted.
        onPauseInTurn: () => { removeTurnCapture(); },
        onResumeInTurn: () => { installTurnCapture(rl as InkLineInterface); }
      })
    : readline.createInterface({ input: process.stdin, output: process.stdout, completer });
  // Esc-to-cancel for the ink path. Readline registers its own keypress
  // handler below; the ink adapter emits a synthetic 'escape' event
  // instead so cli.ts can route it without observing raw stdin.
  if (useInk) {
    (rl as InkLineInterface).on('escape', () => {
      if (!activeTurnController || activeTurnController.signal.aborted) return;
      activeTurnController.abort();
    });
    // Push every submitted line into the ink history ring so the Up/Down
    // arrows recall it later. Done as a separate listener (not inside
    // the main 'line' handler) so history capture survives early
    // returns / paste coalescing.
    (rl as InkLineInterface).on('line', (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      if (inkHistory[inkHistory.length - 1] !== trimmed) inkHistory.push(trimmed);
      if (inkHistory.length > HISTORY_MAX) inkHistory.shift();
      inkHistoryCursor = -1;
    });
    // Turn-view composer events. The TurnView composer emits these while a
    // turn is in flight (BANDIT_TURN_VIEW). Both lineQueue and
    // pendingBackgroundInjections are captured here and only read at
    // invocation time (mid-turn), long after they're initialized below.
    const inkIface = rl as InkLineInterface;
    // If a mid-turn sub-flow is awaiting a line (a permission deny+note,
    // a yes/no answer — replGetLine set `lineIntercept`), the composer's
    // Enter is that answer, NOT a queued message. Resolve the intercept
    // and stop. Returns true when it consumed the submission.
    const consumedByLineIntercept = (text: string): boolean => {
      if (!lineIntercept) return false;
      const fn = lineIntercept;
      lineIntercept = null;
      fn(text);
      return true;
    };
    inkIface.on('turnSubmit', (line: string) => {
      if (consumedByLineIntercept(line)) return;
      // Enter with plain text → queue to run after the current turn
      // (the "send a message while the AI works" behavior).
      lineQueue.push(line);
      inkIface.commitTurnLine?.(c.dim(`  ${glyph.check} queued — runs after this turn: `) + c.cyan(line));
    });
    inkIface.on('nudge', (msg: string) => {
      if (consumedByLineIntercept(msg)) return;
      // `/btw <msg>` → deliver to the RUNNING agent before its next LLM
      // call via the same drainExternalMessages path background-subagent
      // completions use. If no turn is active, fall back to queueing.
      if (activeTurnController && !activeTurnController.signal.aborted) {
        pendingBackgroundInjections.push({ role: 'user', content: msg });
        inkIface.commitTurnLine?.(c.accent(`  ${glyph.arrow} nudged — the agent sees this before its next step: `) + c.cyan(msg));
      } else {
        lineQueue.push(msg);
        inkIface.commitTurnLine?.(c.dim(`  ${glyph.check} queued: `) + c.cyan(msg));
      }
    });
  }

  // ---- turn-view stdout capture (BANDIT_TURN_VIEW) ----
  // While a turn runs in turn-view mode, route everything the agent
  // writes to stdout (assistant tokens, tool cards, diffs, recap) into
  // ink's <Static> scrollback, line-buffered: complete lines commit; the
  // trailing partial shows as the live in-progress stream line. ink's own
  // frame writes bypass this — the interface mounted ink with a private
  // writer (see inkInterface.tsx's inkStdout Proxy). The spinner is
  // silenced via its sink at the same time, so nothing fights for stdout.
  let turnCaptureBuffer = '';
  let turnOriginalWrite: typeof process.stdout.write | null = null;
  // Committed <Static> scrollback is append-only; it must never carry
  // cursor-movement / erase / OSC control sequences. ink's <Text> renders
  // committed lines but only understands SGR (color/style) escapes — for any
  // OTHER escape it drops the ESC byte and leaves the bare introducer visible
  // (the stray `[` / `]` users saw around mid-turn approval prompts, which
  // redraw their menu in place via `\x1b[<n>A\x1b[0J`). Strip everything but
  // SGR before committing; box-drawing glyphs and colors are untouched.
  const sanitizeForStatic = (s: string): string => s
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')                          // OSC (title, etc.)
    .replace(/\x1b\[[0-?]*[ -/]*([@-~])/g, (m, final) => (final === 'm' ? m : '')) // CSI: keep SGR, drop the rest
    .replace(/\x1b[^[\]]/g, '');                                           // lone two-byte ESC sequences
  const installTurnCapture = (ink: InkLineInterface): void => {
    if (turnOriginalWrite) return; // already installed
    turnOriginalWrite = process.stdout.write.bind(process.stdout);
    turnCaptureBuffer = '';
    const patched = ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean => {
      const enc = typeof encodingOrCb === 'string' ? (encodingOrCb as BufferEncoding) : undefined;
      const text = typeof chunk === 'string'
        ? chunk
        : (Buffer.isBuffer(chunk) ? chunk.toString(enc) : String(chunk ?? ''));
      turnCaptureBuffer += text;
      let nl = turnCaptureBuffer.indexOf('\n');
      while (nl >= 0) {
        // Drop a trailing CR so CRLF terminals don't leave a stray ^M in
        // the committed line. Mid-line CRs (rare here — the spinner, the
        // only \r source, is sink-silenced in turn mode) are left intact.
        const line = sanitizeForStatic(turnCaptureBuffer.slice(0, nl).replace(/\r$/, ''));
        ink.commitTurnLine?.(line);
        turnCaptureBuffer = turnCaptureBuffer.slice(nl + 1);
        nl = turnCaptureBuffer.indexOf('\n');
      }
      ink.setTurnStream?.(turnCaptureBuffer);
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      if (typeof callback === 'function') (callback as (e?: Error | null) => void)(null);
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = patched;
  };
  const removeTurnCapture = (): void => {
    if (!turnOriginalWrite) return;
    process.stdout.write = turnOriginalWrite;
    turnOriginalWrite = null;
    const ink = rl as InkLineInterface;
    // Flush any partial line that never got a newline so its content isn't
    // lost, then clear the live stream. This is the single authoritative
    // flush: clearing turnStream here means exitTurnMode() won't re-commit
    // the same partial (turnStream === turnCaptureBuffer at this point).
    if (turnCaptureBuffer.length > 0) {
      ink.commitTurnLine?.(sanitizeForStatic(turnCaptureBuffer.replace(/\r$/, '')));
      turnCaptureBuffer = '';
    }
    ink.setTurnStream?.('');
  };
  // Route a turn FAILURE message safely. In turn mode ink owns the bottom
  // region and only stdout is captured into <Static>; a raw stderr write
  // (the catch block's UPSTREAM_MODEL / generic / circuit-breaker
  // branches) would bypass both the capture and ink, garbling the frame
  // and shifting the cursor on the next reconcile. So in turn mode send
  // it through the (still-patched) stdout — it line-buffers into
  // scrollback like the rest of the turn output. Otherwise stderr as usual.
  const writeTurnAwareErr = (text: string): void => {
    if ((rl as InkLineInterface).isTurnMode?.()) {
      process.stdout.write(text);
    } else {
      process.stderr.write(text);
    }
  };
  // Narrator loop — paints a live "▸ background tasks" block above the
  // composer whenever any subagents are running, so the user sees real
  // progress instead of silence (or, worse, the model hallucinating
  // fake progress fences to fill the void). The story:
  //
  //   • subagents already emit `tool_loop:tool_execute` events; the
  //     task tool already pushes per-iteration progress into the store
  //   • we subscribe to start/progress/complete/failed/cancelled events
  //   • on every event AND on a 2-second wallclock tick (for elapsed-
  //     time refresh), we snapshot the running tasks and render a tight
  //     line per task into the ink store
  //   • when no tasks are running, we hand it an empty array — the
  //     block vanishes
  //
  // The narrator is pure rendering — no second model, no extra
  // inference, no GPU contention. Works identically on Ollama, OpenAI-
  // compatible, and Bandit Cloud because the task store is provider-
  // agnostic. Only paints when ink is mounted (between turns / at the
  // prompt); during a turn ink is paused and the block isn't visible
  // anyway, so the agent's stdout writes aren't fighting a live frame.
  const setNarrator = (rl as InkLineInterface).setNarratorLines;
  const updateNarrator = (): void => {
    if (!useInk || typeof setNarrator !== 'function') return;
    const running = backgroundStore.listByStatus('running');
    if (running.length === 0) {
      setNarrator.call(rl, []);
      return;
    }
    const MAX_VISIBLE = 4;
    const visible = running.slice(0, MAX_VISIBLE);
    const lines = visible.map((task) => {
      const elapsedMs = Date.now() - task.startedAt;
      const secs = Math.floor(elapsedMs / 1000);
      const elapsed = secs >= 60
        ? `${Math.floor(secs / 60)}m${secs % 60}s`
        : `${secs}s`;
      // Trim goal to one line — task goals are often a full sentence
      // ("scan the codebase for security issues in the auth flow…") and
      // we want one line per task. 50 chars is a fair budget for the
      // composer's typical width without wrapping in a 100-col terminal.
      const goal = task.goal.length > 50 ? task.goal.slice(0, 47) + '…' : task.goal;
      const tool = task.lastTool ? ` · ${task.lastTool}` : '';
      // Render the status glyph in cyan, then a dim body. Keeps the
      // line scannable — the user can lock onto the spinner column
      // instead of having to parse the whole line.
      return c.cyan('⚡') + ' ' + c.dim(`${goal}  ·  iter ${task.iterations}  ·  ${task.toolCalls} tools${tool}  ·  ${elapsed}`);
    });
    if (running.length > MAX_VISIBLE) {
      lines.push(c.dim(`  + ${running.length - MAX_VISIBLE} more running`));
    }
    setNarrator.call(rl, lines);
  };
  if (useInk && typeof setNarrator === 'function') {
    backgroundStore.on('start', updateNarrator);
    backgroundStore.on('progress', updateNarrator);
    backgroundStore.on('complete', updateNarrator);
    backgroundStore.on('failed', updateNarrator);
    backgroundStore.on('cancelled', updateNarrator);
    // 2-second elapsed-time refresh. Only does work when there's at
    // least one running task — `updateNarrator` short-circuits at idle
    // and the store's content-equality check inside setNarratorLines
    // suppresses no-op re-renders. setInterval ref()s the loop, but
    // the REPL's stdin handle already keeps the process alive, so the
    // extra ref is harmless.
    setInterval(() => {
      if (backgroundStore.listByStatus('running').length > 0) updateNarrator();
    }, 2_000);
  }
  // Ctrl+V clipboard-image interceptor. readline ignores keys it doesn't
  // recognize, so we layer our own keypress listener on top of stdin
  // WITHOUT enabling raw mode (which would break line editing). When the
  // terminal forwards Ctrl+V (byte 0x16) as a keypress event, we grab the
  // clipboard: if it's an image, attach it to .bandit/pastes/ and echo
  // the @-mention into readline's buffer so the next submit includes it.
  // If it's anything else (text), we let readline handle the next byte
  // stream normally. Works on macOS/Linux/Windows because `readClipboardImage`
  // shells out to the platform-native tool.
  if (!useInk) readline.emitKeypressEvents(process.stdin);
  // Bump stdin's listener cap so concurrent permission prompts don't trip
  // Node's default-10 MaxListenersExceededWarning. // a model fired 7 parallel `run_command` kubectl calls; each spawned
  // its own permission prompt, each prompt added a keypress listener via
  // permissionPrompt.ts:208. 7 prompt listeners + the 4 baseline CLI
  // listeners (ctrlV, spinner-pause, @-mention, esc-cancel) = 11, past
  // the default cap. The warning then leaked into one of the rendered
  // prompts as "enter to confirm(node:46976) MaxListenersExceeded...".
  // 30 is a pragmatic ceiling — well above the worst legitimate burst,
  // still low enough to surface a real leak if one ever appears.
  if (!useInk) process.stdin.setMaxListeners(30);
  const ctrlVHandler = async (_str: string | undefined, key: readline.Key | undefined) => {
    if (!key || key.ctrl !== true || key.name !== 'v') return;
    const insertion = await handleClipboardImagePaste();
    if (insertion) rl.write(insertion);
  };
  if (!useInk) process.stdin.on('keypress', ctrlVHandler);

  // Spinner-pause-on-typing. While a turn is in flight the spinner
  // clears the prompt line ~12×/sec, which would make any character
  // readline echoes invisible. On every keystroke we pause the spinner
  // for 1.5s (extends on continued typing, resumes on idle) AND force
  // readline to repaint the prompt via _refreshLine — pauseFor clears
  // the line but readline doesn't repaint on its own. Wrapped in
  // setImmediate so readline has committed the keystroke before we
  // ask it to repaint.
  const spinnerPauseHandler = (_str: string | undefined, key: readline.Key | undefined) => {
    if (!activeTurnController) return;
    if (key && key.name === 'escape') return;
    spinner.pauseFor(1500);
    setImmediate(() => {
      // `_refreshLine` is Node-internal but stable across 14/16/18/20/22.
      // try/catch in case a future rename or a non-readline test shim
      // changes the surface.
      try {
        const rlAny = rl as unknown as { _refreshLine?: () => void };
        rlAny._refreshLine?.();
      } catch { /* skip repaint */ }
    });
  };
  if (!useInk) process.stdin.on('keypress', spinnerPauseHandler);

  // @-mention file picker. When the user types `@` at the tail of the
  // current line, pause readline, open the interactive picker (arrow
  // keys + live filter), and on commit splice the selected path back
  // into readline's buffer. Readline sees the `@` land in its buffer
  // as a normal character FIRST; we wait one tick then inspect the
  // line and decide whether to open the picker.
  //
  // Trigger condition: the JUST-typed char is `@` AND readline's line
  // ends with `@` (not part of a larger token like an email address).
  let atMentionPickerActive = false;
  const atMentionHandler = async (str: string | undefined, key: readline.Key | undefined) => {
    if (atMentionPickerActive) return;
    if (!str || str !== '@') return;
    // `@` preceded by a non-word char (or start-of-line) is a mention
    // trigger. `foo@bar.com` is NOT — the `@` is inside an email.
    // readline's rl.line reflects the buffer AFTER this keystroke, so
    // the trailing char is the '@' we just typed.
    // We have to wait one tick so readline has actually committed the
    // char into rl.line before we inspect it.
    setImmediate(async () => {
      const line = (rl as unknown as { line?: string }).line ?? '';
      if (!/(^|\s)@$/.test(line)) return;
      atMentionPickerActive = true;
      try {
        rl.pause();
        const result = await openFilePicker(cwd, '');
        if (!result.dismissed && result.insertion) {
          // readline's buffer currently ends with `@`. Replace that
          // with the picked path. We delete the `@` (sending backspace
          // into readline's buffer via the kill-word-equivalent) and
          // then write the full `@path`.
          // `rl.line` is writable in practice; shorten by one.
          const rlMut = rl as unknown as { line: string; cursor: number };
          if (rlMut.line.endsWith('@')) {
            rlMut.line = rlMut.line.slice(0, -1);
            rlMut.cursor = rlMut.line.length;
          }
          rl.write(result.insertion + (result.trailingChar ?? ''));
        } else if (result.trailingChar) {
          rl.write(result.trailingChar);
        }
      } finally {
        rl.resume();
        // Clear the prompt-line remnants and let readline redraw.
        process.stdout.write('\x1b[2K\r');
        rl.prompt(true);
        atMentionPickerActive = false;
      }
    });
    void key;
  };
  if (!useInk) process.stdin.on('keypress', atMentionHandler);

  // Bottom-right footer hint — rewritten every time we redraw the
  // prompt. Uses dim styling and right-aligns the text so it sits at
  // the tail of its own line, then we emit a newline and let readline
  // paint the actual prompt below it. Tips are static for now; if the
  // user installs the email-manager skill, a future pass can swap in a
  // context-aware hint (e.g. "/email to triage inbox"). `Ctrl+V` is
  // spelled literally because macOS terminals forward raw image bytes
  // only under Ctrl+V (not Cmd+V) — Cmd+V is handled by the OS and
  // pastes as the clipboard's text representation, which for a raw
  // screenshot is empty.
  const renderFooterHint = (): void => {
    const cols = process.stdout.columns || 80;
    const tip = '? shortcuts  ·  /doctor setup  ·  /review changes  ·  @path pin  ·  Ctrl+V image';
    const visible = tip.length > cols - 2 ? tip.slice(0, cols - 4) + '…' : tip;
    const padding = Math.max(0, cols - visible.length - 1);
    // Close the bottom of the input frame with a divider, then the
    // tip line below it. Pairs with the divider rendered above the
    // prompt by renderStatusBar — together they bracket the input
    // area so the loading indicator (rendered in the stream above)
    // has a consistent landing position.
    process.stdout.write('\n' + divider() + '\n' + ' '.repeat(padding) + c.dim(visible) + '\n');
  };

  // ANSI cursor-dance variant of the footer: writes the bottom
  // divider + tip BELOW the active prompt and returns the cursor to
  // its previous position so typing lands on the prompt line. Pairs
  // with rl.prompt() — call this AFTER prompt() to anchor the bottom
  // edge of the input frame on every cycle (not just at boot).
  //
  // Known limitations of the ANSI approach (queued for full ink
  // replacement in v1.7.307+):
  //   - Long inputs that wrap to a second line overlap the divider
  //   - Window resize between prompt() and submit leaves stale layout
  //   - Multi-line paste corrupts the saved cursor position
  // Acceptable for now because the common-case ergonomics (single-
  // line input, normal terminal width) are the failure the user
  // saw repeatedly with boot-only rendering.
  const renderInputFooterAnchored = (): void => {
    if (!process.stdout.isTTY) {
      // Non-TTY (file pipe, CI logs): no cursor games. Footer is
      // less useful anyway when output isn't interactive.
      return;
    }
    const cols = process.stdout.columns || 80;
    const tip = '? shortcuts  ·  /doctor setup  ·  /review changes  ·  @path pin  ·  Ctrl+V image';
    const visible = tip.length > cols - 2 ? tip.slice(0, cols - 4) + '…' : tip;
    const padding = Math.max(0, cols - visible.length - 1);
    // \x1b[s saves cursor, \x1b[u restores. Write a newline + divider
    // + newline + tip below current cursor, then restore so readline's
    // typing lands on the prompt line.
    process.stdout.write(
      '\x1b[s' +
      '\n' + divider() + '\n' +
      ' '.repeat(padding) + c.dim(visible) +
      '\x1b[u'
    );
  };
  // The "vX.Y.Z available" indicator USED to live in renderFooterHint,
  // but renderFooterHint is called exactly once at boot — before the
  // npm-registry fetch had a chance to resolve. So the pin never
  // showed. Surfacing it via the status bar (which re-renders before
  // every prompt cycle) means the user sees it the moment the fetch
  // completes, not "never."

  // Lightweight status row — re-emitted before every prompt redraw so
  // the user always sees current state: model, turn count, session
  // elapsed, session token total, and git branch (when in a repo).
  // Right-aligned dim text, one line. Designed to be cheap enough to
  // re-render on every prompt cycle without feeling noisy.
  let turnCount = 0;
  const renderStatusBar = (): void => {
    const cols = process.stdout.columns || 80;
    // Per-TURN time, not session-since-boot. While a turn runs, this is
    // the current turn's elapsed; at the prompt it's the last turn's
    // duration. The old session-since-boot value sat next to "N turns"
    // and read as if one turn took the whole session (a near-instant
    // answer showed "1 turn · 6m29s" — that was cumulative idle since
    // launch). Empty before the first turn so the idle bar stays clean.
    const turnMs = activeTurnController ? Date.now() - turnStartedAt : lastTurnMs;
    const elapsedLabel = turnMs <= 0
      ? ''
      : turnMs >= 3600_000
        ? `${Math.floor(turnMs / 3600_000)}h${Math.floor((turnMs % 3600_000) / 60_000)}m`
        : turnMs >= 60_000
          ? `${Math.floor(turnMs / 60_000)}m${Math.floor((turnMs % 60_000) / 1000)}s`
          : `${Math.floor(turnMs / 1000)}s`;

    // Refresh git branch at most every 30s. First call runs synchronously
    // so the very first status bar after boot gets the branch; subsequent
    // calls reuse the cache. `git rev-parse` is fast enough that even
    // sync is sub-10ms, but caching keeps the typical-keystroke path zero.
    if (cachedGitBranch === null || Date.now() - gitBranchCheckedAt > 30_000) {
      try {
        const branch = cp.spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 1_000
        }).stdout?.trim() ?? '';
        cachedGitBranch = branch || '';
        gitBranchCheckedAt = Date.now();
      } catch {
        cachedGitBranch = '';
        gitBranchCheckedAt = Date.now();
      }
    }

    const tokenLabel = sessionTokenTotal >= 1000
      ? `~${(sessionTokenTotal / 1000).toFixed(1)}K tok`
      : sessionTokenTotal >= 100
        ? `~${sessionTokenTotal} tok`
        : '';

    // Flush any background-task notices buffered since the last
    // render. We do this here (between turns) rather than from the
    // emitter listeners directly so we don't race readline's prompt
    // redraw with mid-keystroke writes.
    while (pendingBackgroundNotices.length > 0) {
      const msg = pendingBackgroundNotices.shift()!;
      process.stdout.write(msg + '\n');
    }
    const parts = [
      model,
      `${turnCount} turn${turnCount === 1 ? '' : 's'}`
    ];
    if (elapsedLabel) parts.push(elapsedLabel);
    if (tokenLabel) parts.push(tokenLabel);
    if (cachedGitBranch) parts.push(cachedGitBranch);
    const runningTaskCount = backgroundStore.listByStatus('running').length;
    if (runningTaskCount > 0) {
      parts.push(`bg:${runningTaskCount} running`);
    }
    if (sessionThinkingOverride !== undefined) {
      parts.push(sessionThinkingOverride ? 'think:on' : 'think:off');
    }
    if (latestRemoteVersion) {
      // Always-on update pin. The npm fetch is fire-and-forget at boot;
      // this reads the resolved value on every prompt cycle so once the
      // fetch returns a strictly-newer version, the user sees it on
      // the very next prompt — no need to restart bandit.
      parts.push(c.accent(`update v${latestRemoteVersion} available`));
    }
    // While a turn is in flight, surface the cancel-and-queue affordance:
    // queued count tells the user "your next message is on deck", Esc
    // tells them how to bail. Suppressed when nothing is running so
    // the idle status bar stays clean.
    if (activeTurnController) {
      if (lineQueue.length > 0) parts.push(c.accent(`queued: ${lineQueue.length}`));
      parts.push(c.dim('Esc to stop'));
    }
    const label = parts.join(' · ');
    const padding = Math.max(0, cols - label.length - 1);
    process.stdout.write(' '.repeat(padding) + c.dim(label) + '\n');
    // Visual frame above the input — separates the prompt from the
    // turn output / spinner so the loading indicator (which renders
    // in the output stream above this line) sits in a consistent
    // spot relative to the input. Layout (readline path):
    //   <output / spinner here>
    //   ───────────────────────── ← divider (this line)
    //   > prompt
    //   ───────────────────────── ← footer hint divider (renderFooterHint)
    //
    // ink path skips this divider — the rounded box border around the
    // input already provides the visual separation, and the extra
    // horizontal rule jammed right above it reads as a stray dashed
    // line between every turn (matches the "line break after each
    // user message" complaint).
    if (!useInk) process.stdout.write(divider() + '\n');
  };
  // Repaint the footer when the terminal resizes so the right-align
  // stays correct. We don't attempt true ANSI-positioned status lines
  // (cursor save/restore collides with streaming output) — this is a
  // "printed just above each new prompt" design that survives scroll.
  process.stdout.on?.('resize', () => {
    // No-op during active streaming; the footer reappears on the next
    // prompt cycle which is the natural redraw point.
  });

  /** One-line "what just happened" summary printed before the next
   * prompt. Heuristic, no LLM call: compresses the user's prompt
   * to its first verb-ish phrase, captures the first sentence of
   * the assistant's prose response (with thinking blocks stripped),
   * and renders both as a dim "✻ recap: <prompt> → <outcome>" line.
   * Suppressed for trivial turns (short prompt + short answer) to
   * avoid recap-spam on quick chit-chat. */
  const renderRecap = (userPrompt: string, assistantResponse: string): void => {
    if (!userPrompt || !assistantResponse) return;
    // Strip everything that's hidden from the user OR renders to ANSI
    // box-drawing in the terminal but lives as raw markdown in the
    // string we have here. Without this the recap leaked things like
    // `Here's your cluster — **15 nodes**, all **Ready**: | Node |
    // Roles | OS | Version | Age | |---|---|--` because the
    // first-sentence extractor walked past the `:` straight into the
    // markdown table source. on a "get my k8s
    // nodes" turn.
    const visible = assistantResponse
      // 1. Hidden reasoning channels.
      .replace(/<think\b[\s\S]*?<\/think\s*>/gi, '')
      .replace(/```bandit-reasoning\b[\s\S]*?```/gi, '')
      // 2. Code fences (any language) + tool-call markup.
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/<tool_call\b[\s\S]*?<\/tool_call\s*>/gi, '')
      // 3. Markdown table syntax — drop full table rows AND separator
      // lines so the first-sentence extractor doesn't pick up
      // pipe-and-dash garbage. Has to be line-oriented because
      // a table row may span the rest of the response.
      .split('\n')
      .filter(line => !/^\s*\|.*\|\s*$/.test(line))           // pipe-bounded row
      .filter(line => !/^\s*\|?\s*[:\-|\s]+\|\s*[:\-|\s]+/.test(line))  // header separator
      .join('\n')
      // Inline pipe-table fragment — any sequence of 3+ pipe-separated
      // chunks on a single line, even when there's prose before/after.
      // Catches "Here's your cluster — | Node | Roles | OS |" where the
      // line-level filter above doesn't fire (line doesn't start with
      // `|`). 3+ pipes is unambiguously table-shaped, not stray prose.
      // on a k8s nodes recap.
      .replace(/(\|[^|\n]+){3,}\|?/g, ' ')
      // 4. Inline markdown decoration that survives in plain text.
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')   // bold **x**
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')   // italic *x*
      .replace(/__([^_\n]+)__/g, '$1')        // bold __x__
      .replace(/`([^`\n]+)`/g, '$1')          // inline code `x`
      .replace(/^#{1,6}\s+/gm, '')            // headings
      .replace(/^\s*[-*•]\s+/gm, '')          // list bullets
      // 5. Collapse any trailing dash-only lines (table footers /
      // horizontal rules left over) and squash multi-blank.
      .replace(/^\s*-{3,}\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (visible.length < 40 && userPrompt.trim().length < 30) return;
    const promptSummary = userPrompt.trim().replace(/\s+/g, ' ').slice(0, 80);
    const firstSentence = visible.split(/(?<=[.!?])\s+/)[0]?.replace(/\s+/g, ' ').slice(0, 100) ?? '';
    if (!firstSentence) return;
    const cols = process.stdout.columns || 80;
    // Two-line layout instead of hard-truncating one line. Line 1 holds
    // the prompt summary, line 2 holds the outcome arrow. Each side gets
    // its own width budget and ellipsis so the more interesting half
    // (the outcome) doesn't get lopped just because the prompt was long.
    //
    // Prior bug 2026-05-26 (Mark, CLI session): recap rendered
    // `✻ recap: "I just connected I think the problem is you have…" → The Google MCP server only supports one active connection at a time — I can't switch between account`
    // and the outcome ran past the terminal width and got hard-cut
    // mid-word at "account" — the user couldn't tell what the agent had
    // actually said.
    const PROMPT_PREFIX = '✻ recap: ';
    const OUTCOME_PREFIX = '         → ';
    const promptBudget = Math.max(20, cols - PROMPT_PREFIX.length - 4); // -4 for leading "  " indent + closing quote + safety
    const outcomeBudget = Math.max(20, cols - OUTCOME_PREFIX.length - 3); // -3 for leading "  " indent + safety
    const truncate = (s: string, budget: number): string =>
      s.length > budget ? s.slice(0, Math.max(1, budget - 1)) + '…' : s;
    const promptLine = PROMPT_PREFIX + `"${truncate(promptSummary, promptBudget - 2)}"`;
    const outcomeLine = OUTCOME_PREFIX + truncate(firstSentence, outcomeBudget);
    process.stdout.write(c.dim('  ' + promptLine) + '\n');
    process.stdout.write(c.dim('  ' + outcomeLine) + '\n');
  };

  rl.setPrompt(c.accent(glyph.prompt + ' '));

  // Readline path only: monkey-patch rl.prompt so the bottom divider +
  // tip render on EVERY prompt cycle (not just at boot). The anchored
  // variant uses ANSI save/restore so the cursor returns to the prompt
  // line after the footer is drawn below it.
  //
  // Known limitation of the ANSI variant: long input that wraps to a
  // second line overlaps the divider, and multi-line paste shifts
  // everything. The ink path (BANDIT_INK_INPUT=1) is the durable fix
  // and renders its own persistent frame natively — the monkey-patch
  // is skipped there.
  if (!useInk) {
    const _originalPrompt = rl.prompt.bind(rl);
    rl.prompt = ((preserveCursor?: boolean) => {
      if (process.stdout.isTTY) {
        // Reserve 2 blank rows below the cursor (will be filled by the
        // anchored footer immediately after rl.prompt prints). The
        // `\x1b[2A` returns the cursor to its pre-reserve position so
        // the prompt prints where it would have.
        process.stdout.write('\n\n\x1b[2A');
      }
      _originalPrompt(preserveCursor);
      renderInputFooterAnchored();
    }) as typeof rl.prompt;
  }

  rl.prompt();

  // Lightweight tool context for slash commands (e.g. /plan invokes create_plan directly).
  const slashToolCtx = new CliToolExecutionContext(cwd, createDefaultLanguageAdapters());

  const slashCtx: SlashContext = {
    skillRegistry,
    session,
    cwd,
    toolCtx: slashToolCtx,
    model: {
      get current() { return model; },
      set(next: string) {
        model = next;
        // Rebuild provider settings with the new model while preserving every
        // other piece of the resolved config (endpoint, headers, api key).
        resolved = { ...resolved, model: next };
        const rebuilt = buildProviderSettings(resolved);
        settings = rebuilt.settings;
        probeOllamaCapabilities(next);
      }
    },
    setProvider(next) {
      // Hot-swap the provider mid-session. Picks a sensible default
      // model when the current model is wrong for the new provider
      // (e.g. switching ollama → bandit while on `gemma4:e4b` would
      // try to call the cloud with an Ollama-only tag). Ollama default
      // = the framework's recommended local model; bandit default =
      // bandit-logic (agent-tuned, native tool calling, the model that
      // actually performs reliably on agent-loop tasks per the
      // 2026-04-26 model bake-off).
      const sensibleDefault = next === 'ollama' ? 'gemma4:e4b' : 'bandit-logic';
      const stillFitsCurrentProvider =
        (next === 'ollama' && /:/.test(model)) || // Ollama tags include a colon
        (next === 'bandit' && model.startsWith('bandit-'));
      const nextModel = stillFitsCurrentProvider ? model : sensibleDefault;
      model = nextModel;
      resolved = { ...resolved, provider: next, model: nextModel };
      const rebuilt = buildProviderSettings(resolved);
      settings = rebuilt.settings;
      kind = rebuilt.kind;
      probeOllamaCapabilities(nextModel);
    },
    get providerKind() {
      return resolved.provider;
    },
    get ollamaUrl() {
      return settings.ollamaUrl ?? resolved.ollamaUrl ?? 'http://localhost:11434';
    },
    setOllamaUrl(next: string) {
      // Empty / whitespace = "use the default" (http://localhost:11434).
      // Mid-session hot-swap so the next /model lookup and the next
      // chat request both pick up the new endpoint without restarting.
      const trimmed = (next ?? '').trim();
      const effective = trimmed.length > 0 ? trimmed : 'http://localhost:11434';
      resolved = { ...resolved, ollamaUrl: effective };
      const rebuilt = buildProviderSettings(resolved);
      settings = rebuilt.settings;
    },
    getConversation: () => [...conversation],
    setConversation: (next) => {
      conversation.length = 0;
      conversation.push(...next);
      void session.replace([...next]);
    },
    tokenBudget: () => {
      const numCtx = resolved.provider === 'ollama'
        ? resolveOllamaRuntimeOptions(model).num_ctx
        : 32768;
      return Math.floor(numCtx * 0.75);
    },
    thinkingMode: {
      get: () => sessionThinkingOverride,
      set: (next) => { sessionThinkingOverride = next; }
    },
    planPreview: {
      get: () => sessionPlanPreview,
      set: (next) => { sessionPlanPreview = next; }
    },
    coauthor: {
      get: () => sessionCoauthor,
      set: (next) => { sessionCoauthor = next; },
      envOff: coauthorEnvOff
    },
    watchdog: {
      get: () => sessionWatchdogMs,
      set: (next) => { sessionWatchdogMs = next; },
      envValue: (() => {
        const parsed = Number.parseInt(process.env.BANDIT_NO_TOKEN_WATCHDOG_MS ?? '', 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
      })()
    },
    notifications: {
      get: () => ({ ...resolved.notifications }),
      set: (next) => {
        resolved = {
          ...resolved,
          notifications: { ...resolved.notifications, ...next }
        };
      }
    },
    getConfig: () => resolved,
    exit: () => rl.close(),
    clearConversation: () => {
      conversation.length = 0;
      void session.replace([]);
    },
    reloadMemory: async () => {
      const fresh = await loadCombinedMemory(cwd);
      memory.content = fresh.content;
      memory.sources = fresh.sources;
      return fresh.content;
    },
    getLine: () => replGetLine(),
    queuePrompt: (line: string) => { lineQueue.push(line); },
    backgroundStore,
    mcpPool,
    reloadMcpFromDisk: async () => {
      // /mcp reload — re-read mcp-servers.json and re-register every
      // entry. register() disposes the prior entry, which drops its
      // in-memory cached tool list, so we re-prime from the disk cache
      // exactly like boot does. Skipping this left post-reload prompts
      // unable to register a server's tools (the first-spawn gate skips
      // an un-cached server that the prompt doesn't mention by name),
      // surfacing as "<server>.<tool> not registered" mid-turn.
      const count = await registerMcpServersFromDisk(cwd, mcpPool);
      await primeMcpDiscoveryCacheFromDisk();
      return count;
    },
    revokeMcpTrust: async (serverName: string) => {
      // /mcp revoke <name> — remove the persisted "always allow"
      // decision for this server's fingerprint. The next first-spawn
      // re-prompts the user. Returns true when a fingerprint was
      // matched + removed, false when the server isn't in the pool.
      const snap = mcpPool.snapshot().find((s) => s.name === serverName);
      if (!snap) return false;
      const fingerprint = fingerprintServerConfig(snap.name, snap.config);
      await revokeMcpFingerprint(fingerprint);
      // Drop the in-memory approval too so the trust prompt fires
      // again on the next spawn within this session, not just the
      // next session.
      approvedFingerprints.delete(fingerprint);
      return true;
    },
    setMcpActivation: async (serverName: string, mode: 'always' | 'on-mention') => {
      // /mcp activation <name> <mode> — flip the server's activation
      // and persist to disk so the change survives session restart.
      // The in-memory pool gets the new config immediately; the
      // disk write is best-effort (the user sees the new mode in
      // /mcp listings even if the file wasn't writable).
      const snap = mcpPool.snapshot().find((s) => s.name === serverName);
      if (!snap) return false;
      mcpPool.register(serverName, { ...snap.config, activation: mode });
      try {
        await persistMcpActivation(cwd, serverName, mode);
      } catch { /* best effort; in-memory state already updated */ }
      return true;
    },
    addGitHubMcp: async (token: string) => {
      // /mcp add github <token> — wizard equivalent. Build the
      // standard server config, write it to mcp-servers.json,
      // pre-trust the fingerprint (user just typed the token
      // themselves; re-prompting on first spawn is silly), and
      // re-register from disk so the entry shows up in /mcp
      // listings immediately.
      const config = buildGitHubServerConfig(token);
      const target = await addMcpServerToConfig(cwd, 'github', config);
      const fingerprint = fingerprintServerConfig('github', config);
      await approveMcpFingerprint(fingerprint).catch(() => { /* best effort */ });
      approvedFingerprints.add(fingerprint);
      await registerMcpServersFromDisk(cwd, mcpPool);
      return target;
    },
    addSlackMcp: async (botToken: string, teamId: string) => {
      const config = buildSlackServerConfig(botToken, teamId);
      const target = await addMcpServerToConfig(cwd, 'slack', config);
      const fingerprint = fingerprintServerConfig('slack', config);
      await approveMcpFingerprint(fingerprint).catch(() => { /* best effort */ });
      approvedFingerprints.add(fingerprint);
      await registerMcpServersFromDisk(cwd, mcpPool);
      return target;
    },
    addGitLabMcp: async (token: string, apiUrl?: string) => {
      const config = buildGitLabServerConfig(token, apiUrl);
      const target = await addMcpServerToConfig(cwd, 'gitlab', config);
      const fingerprint = fingerprintServerConfig('gitlab', config);
      await approveMcpFingerprint(fingerprint).catch(() => { /* best effort */ });
      approvedFingerprints.add(fingerprint);
      await registerMcpServersFromDisk(cwd, mcpPool);
      return target;
    },
    addGmailMcp: async (credentialsPath: string) => {
      // The gongrzhe Gmail server reads its OAuth client secrets from
      // GMAIL_OAUTH_PATH (or ~/.gmail-mcp/gcp-oauth.keys.json by default).
      // Copying into the canonical location keeps the refresh-token sidecar
      // (~/.gmail-mcp/credentials.json) co-located with the client secrets,
      // which is what the server documents and tests against.
      const expanded = credentialsPath.startsWith('~')
        ? path.join(process.env.HOME ?? '', credentialsPath.slice(1))
        : path.resolve(credentialsPath);
      if (!fs.existsSync(expanded)) {
        throw new Error(`Credentials file not found: ${expanded}`);
      }
      const gmailDir = path.join(process.env.HOME ?? '', '.gmail-mcp');
      const destPath = path.join(gmailDir, 'gcp-oauth.keys.json');
      await fs.promises.mkdir(gmailDir, { recursive: true });
      await fs.promises.copyFile(expanded, destPath);
      const config = buildGmailServerConfig(destPath);
      const target = await addMcpServerToConfig(cwd, 'gmail', config);
      const fingerprint = fingerprintServerConfig('gmail', config);
      await approveMcpFingerprint(fingerprint).catch(() => { /* best effort */ });
      approvedFingerprints.add(fingerprint);
      await registerMcpServersFromDisk(cwd, mcpPool);
      return target;
    },
    addCustomMcp: async (params: { name: string; command: string; args?: string[]; envInput?: string }) => {
      const config = buildCustomServerConfig({ command: params.command, args: params.args, envInput: params.envInput });
      const target = await addMcpServerToConfig(cwd, params.name, config);
      const fingerprint = fingerprintServerConfig(params.name, config);
      await approveMcpFingerprint(fingerprint).catch(() => { /* best effort */ });
      approvedFingerprints.add(fingerprint);
      await registerMcpServersFromDisk(cwd, mcpPool);
      return target;
    },
    oneShotChat: async (prompt: string, opts?: { systemPrompt?: string; timeoutMs?: number }) => {
      // Single non-streaming completion through the active provider.
      // Used by /insights to get an AI-written accomplishment + friction
      // summary. Builds its own provider so the streaming chat in
      // runPrompt doesn't race the same socket; closes silently on
      // failure so callers can fall back to a static path. Timeout
      // defaults to 30s — large enough for cold-loaded local models,
      // small enough that /insights doesn't hang the REPL on a stuck
      // endpoint.
      const timeoutMs = opts?.timeoutMs ?? 30_000;
      try {
        const provider = await createProvider(settings);
        const messages: { role: string; content: string }[] = [];
        if (opts?.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt });
        messages.push({ role: 'user', content: prompt });
        const request = {
          model,
          messages,
          stream: true,
          temperature: 0.3
        };
        let collected = '';
        const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
        const stream = (async () => {
          for await (const chunk of provider.chat(request as never)) {
            const text = chunk.message?.content ?? '';
            if (text) collected += text;
            if (chunk.done) break;
          }
          return collected;
        })();
        const result = await Promise.race([stream, deadline]);
        return typeof result === 'string' && result.trim().length > 0 ? result : null;
      } catch {
        return null;
      }
    },
    runMemoryMigrateWizard: async () => {
      // Lazy-import so test/harness paths that don't run the wizard
      // don't pay the module-load cost. The wizard owns its own
      // stdout rendering; cli.ts here just provides the pause/resume
      // dance for the editor spawn.
      const { runWizard } = await import('./memoryMigrate');
      const { spawnEditorOnFile } = await import('./editorSpawn');
      await runWizard({
        cwd,
        getLine: () => replGetLine({ bypassQueue: true }),
        editFile: async (filePath) => {
          const editor = (await import('./editorSpawn')).resolveEditor();
          if (!editor) return { exitCode: 1 };
          // Pause whoever owns stdin (ink under the default path,
          // readline under --no-ink) so the editor gets full TTY
          // control via stdio: 'inherit'. Same dance the `!bash`
          // shortcut runs at cli.ts:4602+; reusing the pattern keeps
          // raw-mode handling consistent across every "drop into a
          // child process" flow.
          const wasInkPaused = useInk && (rl as InkLineInterface).isPaused();
          if (useInk && !wasInkPaused) rl.pause();
          const stdinIsTty = !!process.stdin.isTTY;
          const setRawMode = stdinIsTty
            ? (process.stdin as NodeJS.ReadStream).setRawMode?.bind(process.stdin)
            : null;
          // Force cooked mode so cooked-mode editors (notepad,
          // `code --wait`) and raw-mode editors (nano, vim) both work.
          if (setRawMode) {
            try { setRawMode(false); } catch { /* non-fatal */ }
          }
          // Ignore SIGINT on the parent for the child's lifetime —
          // Ctrl+C inside nano shouldn't kill bandit too.
          const previousSigint = process.listeners('SIGINT').slice();
          process.removeAllListeners('SIGINT');
          const noopSigint = () => undefined;
          process.on('SIGINT', noopSigint);
          try {
            return await spawnEditorOnFile(editor, filePath);
          } finally {
            process.removeListener('SIGINT', noopSigint);
            for (const fn of previousSigint) {
              process.on('SIGINT', fn as (...args: unknown[]) => void);
            }
            if (setRawMode) {
              try { setRawMode(false); } catch { /* non-fatal */ }
            }
            if (useInk && !wasInkPaused) rl.resume();
          }
        },
        onBeforeEdit: (entry, editor) => {
          process.stdout.write('\n' + c.dim(`  ─── editing ${entry.targetPath} via ${editor.label} (save + exit when done) ───`) + '\n');
        }
      });
    }
  };

  // Serialize line handling so each line fully completes before the next is
  // processed. Without this, readline emits all piped lines synchronously
  // and then 'close' — racing the async handlers and eating their output.
  //
  // Two separate problems we solve together here:
  // 1. Piped stdin dumps all lines synchronously before any async work
  // starts — queue them and drain via a single worker.
  // 2. When a permission prompt (or any sub-flow) needs one line of
  // user input, we route the next queued line to IT instead of
  // treating that keystroke as a brand-new prompt. Prevents the
  // "typed 2 — got processed as permission AND as a new message"
  // bug that appeared with a second temporary readline.
  const lineQueue: string[] = [];
  let lineIntercept: ((line: string) => void) | null = null;
  let workerRunning = false;
  // Consecutive-server-error circuit breaker. After this many tagged
  // WATCHDOG failures in a row, drop the rest of the queue rather
  // than grinding through ~10 minutes of doomed retries against an
  // unreachable upstream.
  let consecutiveServerErrors = 0;
  const SERVER_ERROR_CIRCUIT_BREAKER = 2;

  const replGetLine: GetLineFn = (opts) => new Promise((resolve) => {
    // Sub-flows pass bypassQueue:true when they need FRESH input —
    // e.g. permission picker "deny + note" reads the denial reason
    // which must NOT come from any mid-turn-queued message. Without
    // this, a user who typed "fix the test" while the agent was
    // running, then picked deny+note, would see "fix the test"
    // become the denial reason and their actual typed note get
    // queued as the next prompt.
    if (!opts?.bypassQueue && lineQueue.length > 0) {
      resolve(lineQueue.shift()!);
      return;
    }
    // CRITICAL for sub-flows like the !bash y/N gate, the plan-preview
    // y/N gate, and any other replGetLine caller mid-turn: the user's
    // ORIGINAL submission set submitting=true on the ink store, which
    // unmounted the InkInputFrame. Without a visible composer the user
    // has nowhere to type the answer and this await hangs forever.
    // rl.prompt() in the ink interface clears submitting=false so the
    // frame re-mounts before we go to sleep on the next line event.
    // (No-op for the readline path — readline's own prompt rendering
    // is already handled by the underlying interface.)
    rl.prompt();
    // Tell the turn-view composer a sub-flow read is pending so an empty
    // Enter resolves it (plain deny) instead of being swallowed, and a
    // "/btw …" note isn't reclassified as a nudge. Cleared in the
    // callback below, which runs whether the line arrives via the
    // composer (consumedByLineIntercept) or the queue (drainQueue).
    // No-op on the readline / default-ink paths.
    (rl as InkLineInterface).setAwaitingLine?.(true);
    lineIntercept = (line) => {
      lineIntercept = null;
      (rl as InkLineInterface).setAwaitingLine?.(false);
      resolve(line);
    };
  });

  const drainQueue = async (): Promise<void> => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      while (lineQueue.length > 0) {
        // If a sub-flow is waiting for input, hand it the line.
        if (lineIntercept) {
          const next = lineQueue.shift()!;
          const fn = lineIntercept;
          lineIntercept = null;
          fn(next);
          continue;
        }
        const raw = lineQueue.shift()!;
        let line = raw.trim();
        if (!line) { rl.prompt(); continue; }
        if (line === 'exit' || line === 'quit') { rl.close(); return; }
        // Expand single-letter confirm shortcuts after a yes/no question
        // so the agent sees an unambiguous answer. We ONLY expand when
        // the prior assistant response looks like a yes/no question
        // (same detector that rendered the [y]/[n] hint) — outside
        // that context, `y` / `n` might be an abbreviation the user
        // actually means (e.g. a variable name in a prompt).
        if (/^[yn]$/i.test(line) && conversation.length > 0) {
          const lastAssistant = [...conversation].reverse().find(m => m.role === 'assistant');
          if (lastAssistant && looksLikeYesNoQuestion(lastAssistant.content)) {
            line = line.toLowerCase() === 'y' ? 'yes' : 'no';
          }
        }
        turnStartedAt = Date.now();
        try {
          const slash = findSlashCommand(line);
          if (slash) {
            const out = await slash.cmd.run(slash.args, slashCtx);
            if (out) process.stdout.write(out + '\n');
            rl.prompt();
            continue;
          }

          // `!`-prefix bash shortcut. Direct shell access for the user
          // — bypasses run_command's allow-list because the user is
          // explicitly invoking, not the agent. Catastrophic guards
          // (rm -rf, mkfs, dd if=) still apply. Same shape as Claude
          // Code's `!` and Aider's `/run`.
          if (line.startsWith('!') && line.length > 1) {
            const bashCmd = line.slice(1).trim();
            if (!bashCmd) { rl.prompt(); continue; }
            const BLOCKED = [/rm\s+-rf/, /rmdir\s+\//, /\bmkfs\b/, /dd\s+if=/];
            const blocked = BLOCKED.find((re) => re.test(bashCmd));
            if (blocked) {
              process.stdout.write(c.red(`Refusing to run \`${bashCmd}\` — matches blocked pattern \`${blocked.source}\`. Run it in your shell directly if you really mean it.\n`));
              rl.prompt();
              continue;
            }
            // First-use confirmation gate — full multi-line warning the
            // first time a user types `!cmd` in this session, with a
            // y/N gate. After they ack once, every subsequent `!` call
            // still gets a loud yellow box reminding them the command
            // is bypassing the agent and running straight in their
            // shell — easy to miss a single line, harder to miss a
            // boxed banner. Per-call visibility requested 2026-04-30.
            if (!sessionBangAck) {
              // First `!` of the session: show the full warning, then run.
              // No y/N gate — typing `!` is already the explicit opt-in, the
              // loud warning + blocked-pattern guard are the safety, and
              // Ctrl+C still aborts. The old raw "Run it? [y/N]" prompt was
              // a bare stdout line with no newline that ink's next repaint
              // erased, so no confirmation actually appeared — which read as
              // broken. Dropping it is simpler and can't half-render.
              process.stdout.write('\n' + c.yellow('⚠  !-prefix runs directly in your shell.') + '\n');
              process.stdout.write(c.dim('   • bypasses the run_command allow-list and per-command approval gate') + '\n');
              process.stdout.write(c.dim('   • catastrophic patterns (rm -rf, mkfs, dd if=) are still blocked') + '\n');
              process.stdout.write(c.dim('   • the agent will not see the output — use run_command instead if you want it to react') + '\n');
              sessionBangAck = true;
            } else {
              // Per-call loud banner so the user sees a clear shell
              // attribution on every `!` invocation. Boxed in yellow
              // because users wanted it more obvious than the
              // single-line dim echo we shipped before — when the
              // session ack-flag was already set it was easy to miss.
              const cols = Math.min(process.stdout.columns || 80, 96);
              const top = '┌' + '─'.repeat(cols - 2) + '┐';
              const bot = '└' + '─'.repeat(cols - 2) + '┘';
              const padLine = (text: string): string => {
                const visible = text.replace(/\x1b\[[0-9;]*m/g, '');
                const space = Math.max(0, cols - 4 - visible.length);
                return '│ ' + text + ' '.repeat(space) + ' │';
              };
              const cmdLine = bashCmd.length > cols - 8
                ? bashCmd.slice(0, cols - 11) + '…'
                : bashCmd;
              process.stdout.write('\n' + c.yellow(top) + '\n');
              process.stdout.write(c.yellow(padLine(c.bold('▸ SHELL') + c.dim('  running directly in your terminal — agent will not see output'))) + '\n');
              process.stdout.write(c.yellow(padLine(c.dim('$ ') + cmdLine)) + '\n');
              process.stdout.write(c.yellow(bot) + '\n');
            }
            // Full TTY passthrough for interactive shell commands
            // (`gh auth login`, `op signin`, etc.) via `stdio: 'inherit'`
            // + paused readline. Three guards:
            //   1. Install a no-op SIGINT handler on the parent so
            //      Ctrl+C inside the child doesn't kill bandit too.
            //   2. Force setRawMode(false) after exit — some TUI
            //      commands leave the TTY in raw mode and would break
            //      bandit's line-mode readline.
            //   3. Print a copy-the-URL tip on known auth flows in
            //      case the child's "open browser" call fails silently.
            const { spawn } = await import('child_process');
            const looksLikeAuthFlow = /\b(?:gh\s+auth\s+login|op\s+signin|gcloud\s+auth\s+login|aws\s+sso\s+login|az\s+login|docker\s+login)\b/.test(bashCmd);
            if (looksLikeAuthFlow) {
              process.stdout.write(c.dim('  ↳ tip: if the browser doesn\'t open automatically, copy the URL the command prints and paste it manually.\n'));
            }
            process.stdout.write(c.dim(`❯ ${bashCmd}\n`));
            rl.pause();
            // CRITICAL: Force stdin into canonical (cooked) mode BEFORE
            // spawning. Readline puts the TTY in raw mode for its own
            // line-editing features; rl.pause() only stops emitting
            // 'line' events — it does NOT release raw mode. With raw
            // mode still on, every keystroke goes to the child as a
            // single-byte event and Enter is `\r` (carriage return),
            // not `\n` (line feed). Tools like `gh auth login` read in
            // canonical mode and wait for `\n` — they never see the
            // line terminate, so the user's Enter does nothing and the
            // device-code prompt hangs forever. .
            // setRawMode(false) before spawn = child inherits stdin in
            // cooked mode, Enter delivers `\n`, gh proceeds.
            const stdinIsTty = !!process.stdin.isTTY;
            const setRawMode = stdinIsTty
              ? (process.stdin as NodeJS.ReadStream).setRawMode?.bind(process.stdin)
              : null;
            if (setRawMode) {
              try { setRawMode(false); } catch { /* non-fatal */ }
            }
            // Ignore SIGINT on the parent for the child's lifetime —
            // see comment #1 above.
            const previousSigint = process.listeners('SIGINT').slice();
            process.removeAllListeners('SIGINT');
            const noopSigint = () => undefined;
            process.on('SIGINT', noopSigint);
            const exitCode = await new Promise<number>((resolve) => {
              const child = spawn(bashCmd, {
                cwd,
                shell: '/bin/sh',
                stdio: 'inherit',
                env: process.env
              });
              child.on('exit', (code, signal) => {
                resolve(typeof code === 'number' ? code : signal ? 130 : 1);
              });
              child.on('error', () => resolve(1));
            });
            // Restore the prior SIGINT handlers so Ctrl+C at the
            // bandit prompt behaves normally again.
            process.removeListener('SIGINT', noopSigint);
            for (const fn of previousSigint) {
              process.on('SIGINT', fn as (...args: unknown[]) => void);
            }
            // Belt-and-suspenders: snap the TTY back to canonical mode
            // in case the child left it in raw. Readline will re-enable
            // raw mode itself on resume() if it needs it for prompt
            // editing.
            if (setRawMode) {
              try { setRawMode(false); } catch { /* non-fatal */ }
            }
            rl.resume();
            if (exitCode !== 0) process.stdout.write(c.dim(`exit ${exitCode}\n`));
            rl.prompt();
            continue;
          }

          // Plan-preview gate. When enabled via `/plan-preview on`,
          // run the heuristic planner first, show the user the
          // proposed steps, and ask y/N before actually calling the
          // model. Same planner the /plan slash command uses — it's
          // deterministic and cheap (no LLM cost), so the preview
          // itself adds ~100ms. User types `y` to proceed or anything
          // else to cancel and re-prompt.
          if (sessionPlanPreview) {
            const createPlan = planSkill.tools[0];
            if (createPlan) {
              try {
                const planResult = await createPlan.execute({ goal: line }, slashToolCtx);
                if (!planResult.isError) {
                  process.stdout.write('\n' + c.bold('Proposed plan:') + '\n');
                  process.stdout.write(planResult.output + '\n\n');
                  process.stdout.write(c.dim('Proceed? [y/N] '));
                  const answer = await replGetLine();
                  const confirmed = /^\s*y(es)?\s*$/i.test(answer.trim());
                  if (!confirmed) {
                    process.stdout.write(c.dim('↷ cancelled — revise and try again.\n'));
                    renderStatusBar();
                    rl.prompt();
                    continue;
                  }
                }
              } catch {
                // Planner failures shouldn't block the user — fall
                // through to direct execution.
              }
            }
          }

          // Drain any background subagent tasks that completed since
          // the last turn. Their synopses get prepended to the user's
          // prompt as a system-style preamble so the agent sees the
          // result on this turn — same model the rest of the agent
          // already understands (text in, text out).
          const promptWithBgEvents = drainBackgroundCompletions(line);

          // Per-turn AbortController. Esc keypress aborts it, the loop
          // unwinds with `cancelled: true`, runPrompt returns and we
          // print a "[cancelled]" line. The active flag also lets the
          // shortcuts/queue indicator know whether to surface "Esc to
          // stop" — only visible while a turn is actually in flight.
          activeTurnController = new AbortController();
          // Turn-view shows queue/Esc affordances in its own CTA + status,
          // and ink is already mounted (a direct status-bar write here
          // would strand above the live frame), so skip the turn-start
          // status bar in that mode.
          if (!useTurnView) renderStatusBar();
          turnStartedAt = Date.now();
          telemetryStartTurn(line, model);
          // Reflect the task in the terminal tab title (reset to idle
          // when the turn ends below) so the window reads like the work,
          // not "node …/bin/bandit".
          const taskDesc = line.replace(/\s+/g, ' ').trim();
          const shortTask = taskDesc.length > 48 ? taskDesc.slice(0, 47) + '…' : taskDesc;
          setWindowTitle(`${shortTask} — Bandit`);
          let cancelledByUser = false;
          const onAbort = () => { cancelledByUser = true; };
          activeTurnController.signal.addEventListener('abort', onAbort, { once: true });

          // Pause the ink frame for the turn duration. The "trust
          // patchConsole" experiment in v1.7.316 left the live frame
          // mounted under the theory that ink's default patchConsole
          // would route process.stdout.write through its frame-aware
          // writer. In practice the high-frequency spinner ticks
          // (`\r\x1b[2K` every 80ms) and the model-token stream
          // overwhelmed that path — trust-gate prompts got clobbered
          // and the empty composer still snapshotted into scrollback.
          // Until the proper Static-everywhere refactor lands, the
          // safe path is: pause for the turn, accept that typing
          // during a turn isn't echoed in real time (chars are still
          // captured by stdin's buffer and surface on resume), resume
          // cleanly when the turn ends.
          //
          // Turn-view path (BANDIT_TURN_VIEW): the opposite — keep ink
          // MOUNTED through the turn so the composer + plan stay pinned.
          // Enter turn mode, attach the spinner's status sink, and
          // install the stdout capture that line-buffers agent output
          // into ink's <Static> scrollback. All three are undone in the
          // finally below.
          if (useTurnView) {
            const ink = rl as InkLineInterface;
            ink.enterTurnMode?.();
            spinner.setSink((s) => ink.setTurnStatus?.(s));
            installTurnCapture(ink);
          } else if (useInk) {
            rl.pause();
          }

          const response = await runPrompt({
            prompt: promptWithBgEvents,
            skillRegistry,
            cwd,
            settings,
            model,
            conversation,
            memoryBlock: memory.content,
            todoStore,
            hookSettings,
            permissionStore,
            customRepoRoots: resolved.repoRoots,
            tavilyApiKey: resolved.tavilyApiKey,
            backgroundStore,
            // Mid-turn injection — drain the background-completion queue
            // at each iteration boundary so the parent loop sees subagent
            // synopses AS THEY ARRIVE instead of polling check_task. The
            // queue is populated by backgroundStore.on('complete'/'failed'/
            // 'cancelled') subscribers further up; this callback is just
            // the read side. Returns [] in the common case (no completions
            // since last drain).
            drainExternalMessages: () => {
              if (pendingBackgroundInjections.length === 0) return [];
              const out = pendingBackgroundInjections.slice();
              pendingBackgroundInjections.length = 0;
              return out;
            },
            mcpPool,
            notify: sendNotification,
            signal: activeTurnController.signal,
            getLine: replGetLine,
            // rl downstream is typed as readline.Interface — both the
            // readline and ink adapters share the pause/resume surface
            // we actually call on it.
            rl: rl as readline.Interface,
            getThink: () => sessionThinkingOverride,
            getCoauthor: () => sessionCoauthor,
            getWatchdogMs: () => sessionWatchdogMs,
            recentReads: sessionRecentReads,
            // Route the agent's `switch_model` tool through the same
            // SlashContext.model.set path used by `/model <name>`, so
            // settings + provider are rebuilt consistently and the NEXT
            // REPL iteration picks up the new model automatically.
            onModelSwitch: (next) => {
              slashCtx.model.set(next);
              process.stdout.write(
                c.dim(`  ${glyph.spark} model switched to ${c.accent(next)} (next prompt)\n`)
              );
            },
            onTokenDelta: (delta) => { sessionTokenTotal += delta; }
          });
          activeTurnController.signal.removeEventListener('abort', onAbort);
          activeTurnController = null;
          telemetryEndTurn(cancelledByUser ? { error: 'cancelled' } : undefined);
          lastTurnMs = Date.now() - turnStartedAt;
          setWindowTitle(idleWindowTitle);
          if (cancelledByUser) {
            // The loop returns finalText='[cancelled]' with cancelled=true.
            // Print a clear line so the user sees the Esc was honored, then
            // drain any further queued lines so they aren't applied to the
            // (now-aborted) turn — the user can re-prompt fresh.
            process.stdout.write('\n' + c.yellow('↷ cancelled by Esc — agent stopped, queue cleared.') + '\n');
            lineQueue.length = 0;
          }
          await session.replace(conversation);
          turnCount++;
          // runPrompt already wrote the response to stdout (live during
          // streaming, or as one blob at the end for non-streaming
          // providers) — no duplicate print.
          void response;
          // Skip the inter-turn divider on the ink path — the input
          // box's own border already provides visual separation, and
          // an extra horizontal rule jammed right above the box border
          // reads as a stray dashed line, not as a separator.
          if (!useInk) process.stdout.write(divider() + '\n');
          // Heuristic recap line — single-line summary so the user
          // sees what the turn did at a glance even after the response
          // scrolled. Cheap (no extra LLM call) — composes user's
          // prompt verb + tools fired this turn + first sentence of
          // response. Suppressed for very short turns to stay quiet.
          renderRecap(line, response);
          // Inline yes/no shortcut when the assistant ends with a clear
          // confirm-question. Saves the user from typing "yes" or "no"
          // four keystrokes at a time. If the pattern doesn't match,
          // nothing renders and the normal prompt flow continues.
          if (looksLikeYesNoQuestion(response)) {
            process.stdout.write(c.dim('  [y] yes  ·  [n] no  ·  or type a full reply\n'));
          }
          sendNotification({
            kind: 'complete',
            title: 'Bandit turn complete',
            message: line.slice(0, 160),
            durationMs: Date.now() - turnStartedAt
          });
          // Turn completed normally — reset the dead-server detector.
          consecutiveServerErrors = 0;
        } catch (err) {
          const code = (err as { code?: string } | undefined)?.code;
          // user-initiated abort path. Esc during a
          // first-token hang now propagates a USER_ABORT through the
          // chat closure (the for-await signal check inside the loop
          // never fires when no chunks are flowing, so we race the
          // abort signal directly). Distinct from server failure:
          // we render it yellow, clear the queue (matches the older
          // "↷ cancelled by Esc" path that only fired on between-
          // iteration aborts), and reset the dead-server counter.
          if (code === 'USER_ABORT') {
            const dropped = lineQueue.length;
            if (dropped > 0) lineQueue.length = 0;
            const suffix = dropped > 0 ? ` (cleared ${dropped} queued message${dropped === 1 ? '' : 's'})` : '';
            process.stdout.write('\n' + c.yellow(`↷ cancelled — agent stopped${suffix}.`) + '\n\n');
            consecutiveServerErrors = 0;
          } else {
            const message = err instanceof Error ? err.message : String(err);
            sendNotification({
              kind: 'error',
              title: code === 'UPSTREAM_MODEL' ? 'Bandit upstream failed' : 'Bandit turn failed',
              message,
              durationMs: Date.now() - turnStartedAt
            });
            if (code === 'UPSTREAM_MODEL') {
              writeTurnAwareErr(
                c.red('\n✗ Upstream model failed after retry/fallback attempts.\n') +
                c.dim('   The session is still saved. Send "continue" to resume from the last successful step.\n') +
                c.dim(`   Details: ${message}\n\n`)
              );
            } else {
              writeTurnAwareErr(c.red(`\n✗ ${message}\n\n`));
            }
            // circuit-breaker on tagged dead-server errors.
            // Reset on any other error class (parse error, tool error,
            // etc.) since those don't indicate the upstream is down.
            if (code === 'WATCHDOG' || code === 'UPSTREAM_MODEL') {
              consecutiveServerErrors++;
              if (consecutiveServerErrors >= SERVER_ERROR_CIRCUIT_BREAKER && lineQueue.length > 0) {
                const dropped = lineQueue.length;
                lineQueue.length = 0;
                writeTurnAwareErr(
                  c.yellow(
                    `⚡ Model server has failed ${consecutiveServerErrors} times in a row — dropped ${dropped} queued message${dropped === 1 ? '' : 's'} so they don't all fail against the same upstream issue. Check the server, then re-send what you need.\n\n`
                  )
                );
                consecutiveServerErrors = 0;
              }
            } else {
              consecutiveServerErrors = 0;
            }
          }
        } finally {
          if (useTurnView) {
            // Tear down the turn view. Order matters:
            //   1. detach the spinner sink (no more status writes),
            //   2. render the between-turns status bar WHILE the capture
            //      is still installed so it commits to <Static> instead
            //      of stranding above the still-mounted ink frame,
            //   3. remove the capture (restores real stdout, flushes any
            //      partial line, clears the live stream),
            //   4. exit turn mode (restores the idle input frame; the
            //      stream is already cleared so there's no double flush).
            // stop() first guarantees the 80ms status timer is cleared
            // before we detach the sink, so no late render() can fall
            // through to a stdout paintDock mid-teardown.
            spinner.stop();
            spinner.setSink(null);
            renderStatusBar();
            removeTurnCapture();
            (rl as InkLineInterface).exitTurnMode?.();
            rl.prompt();
          } else {
            renderStatusBar();
            // Re-mount ink. We paused (unmounted) it above at the start of
            // the turn so its live frame didn't fight the agent's stdout
            // writes; the matching resume MUST happen here or the process
            // exits the moment runPrompt resolves. The ink path doesn't
            // register any stdin keypress listeners (those are all guarded
            // by `if (!useInk)` so they don't fight ink's raw-mode reads),
            // which means ink itself is the only handle keeping the event
            // loop alive — unmounted with no other refs, Node sees nothing
            // to do and exits cleanly to the shell. The readline path
            // doesn't share this failure mode because its own keypress
            // listeners hold stdin.
            if (useInk) rl.resume();
            rl.prompt();
          }
        }
      }
    } finally {
      workerRunning = false;
    }
  };

  // Compact 3-column keyboard-shortcut overlay: input triggers on the
  // left, key chords in the middle, common slash commands on the right.
  // `/help` is the single source of truth for the full slash-command
  // list — this panel intentionally only shows what's most worth
  // knowing at a glance. Triggered by `?` keypress when the prompt is
  // empty; also accepted as a typed `?` line for terminals that swallow
  // the raw-mode keypress event.
  const showShortcuts = (): void => {
    const col1: Array<[string, string]> = [
      ['?',         'show this menu'],
      ['/',         'slash commands'],
      ['@',         'pin a file'],
      ['↑ / ↓',     'history']
    ];
    const col2: Array<[string, string]> = [
      ['Esc',       'stop agent'],
      ['Ctrl+V',    'paste image'],
      ['Ctrl+C',    'cancel turn'],
      ['Ctrl+D',    'exit'],
      ['Enter',     'submit']
    ];
    const col3: Array<[string, string]> = [
      ['/help',     'full command list'],
      ['/doctor',   'setup check'],
      ['/login',    'save cloud API key'],
      ['/provider', 'switch ollama/bandit'],
      ['/model',    'switch model'],
      ['/tasks',    'background subagents'],
      ['/rewind',   'undo agent edit'],
      ['/clear',    'reset chat']
    ];
    // ANSI escapes inflate `.length`. Pad on visible width so columns
    // line up regardless of color codes wrapping each cell.
    const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');
    const visLen = (s: string): number => [...stripAnsi(s)].length;
    const pad = (s: string, w: number): string =>
      s + ' '.repeat(Math.max(0, w - visLen(s)));
    const KEY1 = 6, LBL1 = 15, KEY2 = 8, LBL2 = 12, CMD3 = 8;
    const rows = Math.max(col1.length, col2.length, col3.length);
    const out: string[] = [''];
    for (let i = 0; i < rows; i += 1) {
      const [k1, l1] = col1[i] ?? ['', ''];
      const [k2, l2] = col2[i] ?? ['', ''];
      const [k3, l3] = col3[i] ?? ['', ''];
      const cell1 = k1 ? `${pad(c.accent(k1), KEY1)}  ${pad(c.dim(l1), LBL1)}` : ' '.repeat(KEY1 + 2 + LBL1);
      const cell2 = k2 ? `${pad(c.accent(k2), KEY2)}  ${pad(c.dim(l2), LBL2)}` : ' '.repeat(KEY2 + 2 + LBL2);
      const cell3 = k3 ? `${pad(c.cyan(k3), CMD3)}  ${c.dim(l3)}` : '';
      out.push(`  ${cell1}  ${cell2}  ${cell3}`.replace(/\s+$/, ''));
    }
    out.push('');
    process.stdout.write(out.join('\n') + '\n');
  };

  // Live shortcuts overlay — appears above the prompt as soon as the
  // buffer is exactly `?`, and disappears the moment the user
  // backspaces it or types past it. We listen on every keypress and
  // diff against `shortcutsShown` rather than wiring per-key logic
  // because readline mutates `rl.line` synchronously on insert/delete
  // but emits the keypress event after; reading `rl.line` post-event
  // is the simplest source of truth.
  //
  // Line accounting for the erase path: showShortcuts emits 1 blank
  // + N rows + 1 blank where N = max column length (currently 8 for
  // col3). MENU_LINES = blank + rows + blank = 10. We DELIBERATELY
  // do NOT re-render the status bar inside show/hide — every
  // toggle was leaving a stale status line in scrollback (user
  // reported seeing 3 stacked status lines after testing ? and !).
  // The status bar is already on screen from the previous prompt
  // cycle and stays valid; it'll get re-rendered when the user
  // actually submits a line. Keeping it out of the overlay path
  // makes the line-walk math match exactly what was emitted.
  const SHORTCUT_ROWS = 8;
  const MENU_LINES = 1 + SHORTCUT_ROWS + 1;
  let shortcutsShown = false;

  const showShortcutsOverlay = (): void => {
    // Wipe the line readline already painted (with the `?` echoed)
    // before drawing the menu, then re-prompt so the `?` reappears
    // beneath the overlay.
    process.stdout.write('\r\x1b[2K');
    showShortcuts();
    rl.prompt(true);
    // rl.prompt(true) re-renders with the current buffer (`?`), so
    // the cursor lands after the `?` — exactly what we want.
    shortcutsShown = true;
  };

  const hideShortcutsOverlay = (): void => {
    // Clear the prompt line, walk up MENU_LINES erasing each, then
    // re-prompt. readline keeps `rl.line` so the remaining buffer
    // (empty after backspace, or whatever the user typed past `?`)
    // shows up correctly.
    process.stdout.write('\r\x1b[2K');
    for (let i = 0; i < MENU_LINES; i += 1) {
      process.stdout.write('\x1b[1A\x1b[2K');
    }
    rl.prompt(true);
    shortcutsShown = false;
  };

  const questionKeyHandler = (_str: string | undefined, _key: readline.Key | undefined) => {
    if (atMentionPickerActive) return;
    // Defer to next tick so readline has finished mutating rl.line
    // for this keystroke. Without this we'd see the pre-keypress
    // buffer and miss the `?` that was just inserted.
    setImmediate(() => {
      if (atMentionPickerActive) return;
      const buf = (rl as unknown as { line?: string }).line ?? '';
      if (buf === '?' && !shortcutsShown) {
        showShortcutsOverlay();
      } else if (buf !== '?' && shortcutsShown) {
        hideShortcutsOverlay();
      }
    });
  };
  if (!useInk) process.stdin.on('keypress', questionKeyHandler);

  // Live "shell mode" indicator — same shape as the `?` shortcuts
  // overlay but for `!`-prefix shell escape. The moment the buffer
  // starts with `!`, paint a loud yellow banner above the prompt so
  // the user can't miss that the next Enter sends to /bin/sh, NOT to
  // the agent. The banner disappears when they delete the `!` or
  // when they press Enter (resetting state for the next turn).
  // Without this the lone `!` glyph in the input was almost
  // invisible against the prompt — user reported 2026-04-30.
  let bangBannerShown = false;
  // Banner emits exactly 4 newlines: leading blank, top border,
  // padded row, bottom border. We deliberately don't re-render the
  // status bar (same reason as the shortcuts overlay — was leaking
  // stale status lines on every toggle).
  const BANG_BANNER_LINES = 4;
  const showBangBanner = (): void => {
    process.stdout.write('\r\x1b[2K');
    const cols = Math.min(process.stdout.columns || 80, 96);
    const top = '┌' + '─'.repeat(cols - 2) + '┐';
    const bot = '└' + '─'.repeat(cols - 2) + '┘';
    const padLine = (text: string): string => {
      const visible = text.replace(/\x1b\[[0-9;]*m/g, '');
      const space = Math.max(0, cols - 4 - visible.length);
      return '│ ' + text + ' '.repeat(space) + ' │';
    };
    process.stdout.write('\n' + c.yellow(top) + '\n');
    process.stdout.write(c.yellow(padLine(c.bold('▸ SHELL MODE') + c.dim('  next Enter sends straight to /bin/sh — agent will not see it'))) + '\n');
    process.stdout.write(c.yellow(bot) + '\n');
    rl.prompt(true);
    bangBannerShown = true;
  };
  const hideBangBanner = (): void => {
    process.stdout.write('\r\x1b[2K');
    for (let i = 0; i < BANG_BANNER_LINES; i += 1) {
      process.stdout.write('\x1b[1A\x1b[2K');
    }
    rl.prompt(true);
    bangBannerShown = false;
  };
  const bangKeyHandler = (_str: string | undefined, _key: readline.Key | undefined) => {
    if (atMentionPickerActive) return;
    setImmediate(() => {
      if (atMentionPickerActive) return;
      const buf = (rl as unknown as { line?: string }).line ?? '';
      const startsWithBang = buf.startsWith('!');
      if (startsWithBang && !bangBannerShown) {
        showBangBanner();
      } else if (!startsWithBang && bangBannerShown) {
        hideBangBanner();
      }
    });
  };
  if (!useInk) process.stdin.on('keypress', bangKeyHandler);

  // Esc-to-cancel — only meaningful while a turn is in flight. Without
  // a running turn, Esc passes through to readline's default (clear
  // line). Triggers controller.abort() which the tool-use loop already
  // honors via its `signal` option; the post-run path prints
  // "[cancelled]" and clears any queued lines so the user comes back
  // to a clean prompt.
  const escCancelHandler = (_str: string | undefined, key: readline.Key | undefined) => {
    if (!key || key.name !== 'escape') return;
    if (!activeTurnController || activeTurnController.signal.aborted) return;
    if (atMentionPickerActive) return;
    activeTurnController.abort();
  };
  if (!useInk) process.stdin.on('keypress', escCancelHandler);

  // Paste-merge buffer. When the user pastes a multi-line block, every
  // newline fires its own `line` event back-to-back within a few ms.
  // Without coalescing, each line lands in lineQueue as a separate
  // turn and the user sees "queued (12) — sends after current turn"
  // for what they meant as ONE prompt. Buffer + 50ms debounce: typed
  // input flushes after the 50ms gap (imperceptible); pasted input
  // accumulates all lines before flushing as a single submission.
  //
  // 50ms threshold tuned for real terminal paste behavior — a paste of
  // 50+ lines arrives within ~5-15ms total; a fast human typing Enter
  // twice in a row takes >100ms. The lineIntercept / `?` / empty-line
  // paths still fire immediately because they short-circuit before
  // the buffer is touched.
  const processSubmittedLine = (raw: string): void => {
    if (!raw.trim()) return;
    lineQueue.push(raw);
    if (activeTurnController) {
      process.stdout.write('\n' + c.dim(`  ↳ queued (${lineQueue.length}) — sends after current turn`) + '\n');
    }
    void drainQueue();
  };

  // Multi-line paste coalescing — see src/input/pasteBuffer.ts for the
  // contract. The class encapsulates the array + debounce timer so the
  // (incoming) ink refactor can swap the underlying line-event source
  // without changing the "paste arrives as one message" behavior.
  const pasteBuffer = new PasteBuffer({
    onFlush: (merged) => processSubmittedLine(merged)
  });

  rl.on('line', (raw) => {
    // ? on its own pops the shortcuts overlay without entering the queue.
    // If the keypress-driven overlay already painted (normal terminals),
    // pressing Enter just clears state and re-prompts — the menu has
    // already scrolled into view. If it didn't paint (some SSH muxers
    // swallow keypress), we fall through and render the menu now.
    if (raw.trim() === '?' && pasteBuffer.size === 0) {
      if (!shortcutsShown) {
        showShortcuts();
        renderStatusBar();
      }
      shortcutsShown = false;
      rl.prompt();
      return;
    }
    // Reset overlay state for any submitted line — the prompt cycle
    // is starting fresh below the previous render.
    shortcutsShown = false;
    bangBannerShown = false;
    // If a sub-flow is actively waiting for input (permission prompt, etc.),
    // route the keystroke straight to its resolver. This is CRITICAL when
    // the worker is busy — it means the worker is blocked precisely waiting
    // for this input, so we cannot queue+drain (drainQueue refuses to
    // re-enter while the worker runs, which would deadlock the REPL).
    // Bypass the paste-merge buffer entirely — sub-flows expect single
    // keypresses (y/n, arrow-select, numeric choice) and can't be
    // delayed by the 50ms debounce without making approvals feel
    // sluggish.
    if (lineIntercept) {
      const fn = lineIntercept;
      lineIntercept = null;
      // Drop any in-flight paste so its content doesn't leak into the
      // sub-flow handler. Edge case: pasted text immediately followed
      // by a permission prompt — better to lose the paste than send
      // stale buffered input to the wrong consumer.
      pasteBuffer.discard();
      fn(raw);
      return;
    }
    // Drop empty submissions. The permission picker uses raw-mode
    // keypresses for arrow navigation but readline still observes
    // the Enter that confirms — those land here as empty strings
    // and used to inflate `queued (N)` by one for every approval.
    // Symptom: user approves three permissions, sees "queued (3) —
    // sends after current turn" even though they never typed a
    // follow-up prompt. Same guard catches the @-mention picker's
    // confirm-Enter and stray double-Enters.
    if (!raw.trim() && pasteBuffer.size === 0) {
      return;
    }
    // Append + (re)arm the debounce inside the buffer. Pasted lines
    // all arrive within a few ms so the timer keeps resetting and the
    // whole block flushes as one submission. Typed Enter waits 50 ms
    // then flushes alone.
    pasteBuffer.push(raw);
  });

  rl.on('close', () => {
    // Hand the terminal title back to the shell on exit.
    setWindowTitle('');
    // Flush any pending paste buffer synchronously so its content
    // isn't lost on EOF — piped input ("echo 'a\nb\nc' | bandit ...")
    // closes immediately after the last line, before the 50 ms debounce
    // could fire on its own.
    pasteBuffer.flush();
    // Let the worker finish anything that was in flight so final output
    // isn't lost on EOF (piped input, CI, scripted tests).
    const waitForDrain = async () => {
      while (workerRunning || lineQueue.length > 0) {
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      // Best-effort: close every spawned MCP server child process so we
      // don't leak orphaned subprocesses across REPL exits. Failures
      // here are inert — pool.dispose() catches its own errors.
      try { await mcpPool.dispose(); } catch { /* ignore */ }
      process.stdout.write(c.dim(`\n${glyph.info} session saved: ${session.currentId}\n`));
      process.exit(0);
    };
    void waitForDrain();
  });
}

async function main(): Promise<void> {
  // `bandit insights` runs as its own subcommand, NOT through the
  // normal prompt path. Branch before parseArgs so flags like --out
  // don't get swept into the positional prompt buffer. Same shape as
  // git's `git log` vs `git commit` — the first positional decides.
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'mcp' && rawArgs[1] === 'serve') {
    // `bandit mcp serve` — turn the bandit binary into an MCP server
    // exposing its native tool surface over stdio. Other MCP-speaking
    // clients (Claude Desktop, Cursor, Cline, Continue, etc.) point
    // at this command in their mcpServers config and drive Bandit's
    // tools through the same JSON-RPC envelope they use everywhere
    // else. See docs/integration-playlist/mcp-roadmap.md (Phase 4).
    const subArgs = rawArgs.slice(2);
    let workspace = process.cwd();
    let readOnly = false;
    for (let i = 0; i < subArgs.length; i += 1) {
      const a = subArgs[i];
      if (a === '--workspace' || a === '-w') workspace = subArgs[++i] ?? workspace;
      else if (a === '--read-only') readOnly = true;
      else if (a === '--help' || a === '-h') {
        process.stdout.write(`Usage: bandit mcp serve [--workspace <path>] [--read-only]\n\n`);
        process.stdout.write(`Starts a Model Context Protocol server on stdio that exposes\n`);
        process.stdout.write(`Bandit's native tools (read_file / apply_edit / replace_range / search_code /\n`);
        process.stdout.write(`run_command / etc) so other MCP-speaking clients can drive\n`);
        process.stdout.write(`Bandit. Add to your client's mcpServers config:\n\n`);
        process.stdout.write(`  { "bandit": { "command": "bandit", "args": ["mcp", "serve"] } }\n\n`);
        process.stdout.write(`--read-only excludes write_file / apply_edit / replace_range / run_command so\n`);
        process.stdout.write(`the client gets a view-only window into your codebase.\n`);
        return;
      }
    }
    // Build the registry the same way runPrompt does so the exposed
    // tool set tracks Bandit's own surface — minus the host-specific
    // ones (todo_write needs a session, task needs a background
    // store, etc.). Read-only mode strips the write/exec tools.
    const skillRegistry = await loadSkills(workspace);
    const activeSkills = skillRegistry.resolveActiveSkills('');
    const { registry } = skillRegistry.buildToolRegistryWithMap(activeSkills);
    let exposed = registry.getAll();
    if (readOnly) {
      const writers = new Set(['write_file', 'apply_edit', 'replace_range', 'apply_patch', 'run_command', 'watch_command']);
      exposed = exposed.filter((t) => !writers.has(t.name));
    }
    const toolCtx = new CliToolExecutionContext(workspace, createDefaultLanguageAdapters());
    const { serveBanditMcp } = await import('@burtson-labs/agent-core');
    process.stderr.write(`bandit MCP server: workspace=${workspace}${readOnly ? ' (read-only)' : ''}, ${exposed.length} tools\n`);
    await serveBanditMcp({ tools: exposed, toolCtx, name: 'bandit', version: '1.0.0' });
    return;
  }

  if (rawArgs[0] === 'insights') {
    const subArgs = rawArgs.slice(1);
    let outPath: string | undefined;
    let openInBrowser = true;
    let noAi = false;
    for (let i = 0; i < subArgs.length; i += 1) {
      const a = subArgs[i];
      if (a === '--out' || a === '-o') outPath = subArgs[++i];
      else if (a === '--no-open') openInBrowser = false;
      else if (a === '--no-ai') noAi = true;
      else if (a === '--help' || a === '-h') {
        process.stdout.write(`Usage: bandit insights [--out <path>] [--no-open] [--no-ai]\n\n`);
        process.stdout.write(`Generates a stand-alone HTML report from local session +\n`);
        process.stdout.write(`turn-log data. Default output: ./bandit-insights.html. Opens\n`);
        process.stdout.write(`the file in your default browser unless --no-open is passed.\n\n`);
        process.stdout.write(`--no-ai: skip the LLM-narrated storyline section.\n`);
        return;
      }
    }

    // Build the AI summary callback when consent is in place. For local
    // Ollama, consent is implicit (no network egress). For Bandit cloud,
    // we require explicit prior consent persisted via `/insights` —
    // standalone subcommand mode doesn't have a readline to prompt with,
    // so first-time cloud users need to run `/insights` once in the REPL.
    let aiCallback: Parameters<typeof writeInsightsReport>[0]['ai'] | undefined;
    if (!noAi) {
      try {
        const cwd = process.cwd();
        await loadWorkspaceModelBehaviorProfiles(cwd);
        const fileConfig = await loadConfigFiles(cwd);
        const resolved = resolveConfig(fileConfig, {});
        const bundle = buildProviderSettings(resolved);
        const settings = bundle.settings;
        const model = bundle.model;
        const { loadInsightsAiConsent } = await import('./config');
        const isOllama = settings.kind === 'ollama';
        const consent = isOllama ? 'allow' : await loadInsightsAiConsent();
        if (consent === 'allow') {
          const hostKit = await import('@burtson-labs/host-kit');
          aiCallback = hostKit.buildInsightsAiCallback({
            modelLabel: model,
            timeoutMs: 90_000,
            oneShotChat: async (prompt: string, opts?: { systemPrompt?: string; timeoutMs?: number }) => {
              // Single non-streaming completion through the active
              // provider. Mirrors the slash-command path's closure so
              // both entry points produce identical narrative output.
              const timeoutMs = opts?.timeoutMs ?? 60_000;
              try {
                const provider = await createProvider(settings);
                const messages: { role: string; content: string }[] = [];
                if (opts?.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt });
                messages.push({ role: 'user', content: prompt });
                const request = { model, messages, stream: true, temperature: 0.5 };
                let collected = '';
                const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
                const stream = (async () => {
                  for await (const chunk of provider.chat(request as never)) {
                    const text = chunk.message?.content ?? '';
                    if (text) collected += text;
                    if (chunk.done) break;
                  }
                  return collected;
                })();
                const result = await Promise.race([stream, deadline]);
                return result ?? collected;
              } catch {
                return null;
              }
            }
          });
          process.stdout.write(`asking ${model} for a summary…\n`);
        } else if (!isOllama && consent !== 'deny') {
          process.stdout.write(
            `(skipping AI narrative — run \`bandit\` then \`/insights\` once to grant consent for cloud summaries.)\n`
          );
        }
      } catch (err) {
        // Best-effort — if config or provider setup fails the report
        // still gets written, just without the storyline section.
        if (process.env.BANDIT_DEBUG) {
          process.stderr.write(`[insights] AI setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }

    const written = await writeInsightsReport({ cwd: process.cwd(), out: outPath, ai: aiCallback });
    process.stdout.write(`✓ insights written to ${written}\n`);
    if (openInBrowser) {
      // Cross-platform "open this file in the default browser." `open`
      // on macOS, `xdg-open` on Linux, `start` on Windows. We don't
      // care about the spawn result — failure to launch is silent and
      // the user can open the path manually from the line above.
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      try {
        cp.spawn(opener, [written], { detached: true, stdio: 'ignore' }).unref();
      } catch { /* opener missing — silent */ }
    }
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); return; }
  if (args.version) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../package.json') as { version: string };
    process.stdout.write(`bandit ${pkg.version}\n`);
    return;
  }

  const cwd = process.cwd();
  await loadWorkspaceModelBehaviorProfiles(cwd);
  const session = new SessionStore();
  await session.init();

  if (args.resume) {
    const ok = await session.resume(args.resume);
    if (!ok) { process.stderr.write(c.red(`session not found: ${args.resume}\n`)); process.exit(1); }
  } else if (args.session) {
    const ok = await session.resume(args.session);
    if (!ok) session.currentId = args.session; // create on first write
  }

  if (args.prompt) {
    await oneShot(args.prompt, cwd, session, args.overrides);
  } else {
    await repl(cwd, session, args.overrides);
  }
}

main().catch((err) => {
  process.stderr.write(c.red(`fatal: ${err instanceof Error ? err.message : String(err)}\n`));
  process.exit(1);
});

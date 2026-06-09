/**
 * IDE slash command dispatch — extracted from extension.ts.
 *
 * Why: extension.ts crossed 9k lines and bandit's self-evaluation
 * flagged it as monolithic. Slash commands were a self-contained
 * cohesive group (~157 lines) with a small, well-defined interface
 * to the rest of the provider — cleanest first method-level cut
 * after the pure helpers in .
 *
 * Interface: callers pass a `SlashCommandContext` that wraps the
 * provider state + methods the handlers need. Handlers never touch
 * `this`; they read from / call back through the context. This keeps
 * the slash module fully unit-testable in isolation (mock the context,
 * call handleSlashCommand) without spinning up the entire VS Code
 * extension host.
 *
 * Adding a command: extend the `if (cmd === '...')` chain in
 * handleSlashCommand below + update the `/help` table.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConversationEntry } from '../services/conversationTypes';
import { getModelBehaviorProfile, type ProviderKind } from '@burtson-labs/stealth-core-runtime';
import { loadMemory, appendMemory, listTurnTraces, readTurnTraceById, formatTurnTraceMarkdown, listInstalledOllamaModels } from '@burtson-labs/host-kit';
import { createConversationEntry } from '../helpers/conversation';

export interface SlashCommandContext {
  /** Live conversation reference — slash handlers push system-style
   * assistant messages here and then call updateConversation. */
  conversation: ConversationEntry[];
  updateConversation(entries: ConversationEntry[]): Promise<void>;
  syncState(): Promise<void>;
  clearCurrentConversation(): Promise<void>;
  getProviderKind(config: vscode.WorkspaceConfiguration): ProviderKind;
  resolveOllamaBaseModel(config: vscode.WorkspaceConfiguration): string;
  hasBanditApiKey?(): Promise<boolean>;
}

const HELP_BODY = [
  '**IDE slash commands:**',
  '',
  '| Command | Does |',
  '|---|---|',
  '| `/help` | This list |',
  '| `/clear` | Clear conversation history (keeps session id) |',
  '| `/memory` | Show auto-loaded project memory (`BANDIT.md` / `CLAUDE.md`) |',
  '| `/remember <fact>` | Append a fact to `BANDIT.md` so it survives across sessions |',
  '| `/doctor` | Check setup, provider, model profile, traces, and next actions |',
  '| `/model` | Show the active model |',
  '| `/model <name>` | Switch to another model for the next prompt |',
  '| `/ollama` | Show the active Ollama endpoint |',
  '| `/ollama default` | Reset Ollama endpoint to `http://localhost:11434` |',
  '| `/ollama <url>` | Set the Ollama endpoint |',
  '| `/think on \\| off \\| auto` | Override per-model thinking mode |',
  '| `/rewind [id]` | Restore a file from a checkpoint |',
  '| `/trace`, `/trace list`, `/trace failed`, `/trace <id>` | Inspect turn traces from workspace/global `.bandit/turns` |',
  '| `/profile [model]` | Show Bandit\'s behavior profile for a model |',
  '',
  '_Other slash commands (`/usage`, `/session`, `/theme`, `/paste`, `/init`, `/commit`, `/review`, `/refactor`, `/test`, `/explain`, `/onboard`, `/changelog`) live in the terminal CLI — run `bandit` in your shell to use them._'
].join('\n');

const REMEMBER_USAGE = [
  '**Usage:** `/remember <fact>` — appends a bullet to `BANDIT.md` at the workspace root so the fact survives across sessions.',
  '',
  'Examples:',
  '- `/remember All my repos live in ~/Documents/GitHub`',
  '- `/remember Local Ollama runs at http://localhost:11434`',
  '- `/remember Prefer pnpm over npm in this monorepo`'
].join('\n');

const NO_MEMORY_BODY = [
  '_No project memory loaded._',
  '',
  'Drop a `BANDIT.md` or `CLAUDE.md` at the workspace root and it will auto-attach to every prompt. Use it for "always remember these constraints / conventions / endpoints" notes. Or just type `/remember <fact>` and Bandit will append for you.'
].join('\n');

function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function getActiveModel(configuration: vscode.WorkspaceConfiguration, ctx: SlashCommandContext): string {
  const providerKind = ctx.getProviderKind(configuration);
  if (providerKind === 'ollama') {return ctx.resolveOllamaBaseModel(configuration);}
  if (providerKind === 'openai-compatible') {
    return configuration.get<string>('openaiModel', '') || configuration.get<string>('model', 'bandit-core-1') || 'bandit-core-1';
  }
  return configuration.get<string>('model', 'bandit-core-1') || 'bandit-core-1';
}

function getOllamaEndpoint(configuration: vscode.WorkspaceConfiguration): string {
  return configuration.get<string>('ollamaBaseUrl', '')
    || configuration.get<string>('ollamaUrl', '')
    || 'http://localhost:11434';
}

function shortPath(value: string): string {
  const home = os.homedir();
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function gitSummary(root: string): { ok: boolean; detail: string; fix?: string; dirtyCount: number } {
  try {
    cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, stdio: 'ignore', timeout: 1000 });
  } catch {
    return {
      ok: false,
      detail: 'No git repository detected.',
      fix: 'Open a repository folder before starting long agent runs.',
      dirtyCount: 0
    };
  }
  const branch = (() => {
    try {
      return cp.execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf-8', timeout: 1000 }).trim();
    } catch {
      return 'detached';
    }
  })();
  const dirtyCount = (() => {
    try {
      const out = cp.execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf-8', timeout: 1500 });
      return out.split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  })();
  return {
    ok: true,
    detail: `${branch || 'detached'}${dirtyCount > 0 ? ` · ${dirtyCount} changed file${dirtyCount === 1 ? '' : 's'}` : ' · clean'}`,
    fix: dirtyCount > 0 ? 'Use `/trace` for run history or the Source Control panel to review changes.' : undefined,
    dirtyCount
  };
}

function formatWatchdog(configuration: vscode.WorkspaceConfiguration): { detail: string; fix?: string } {
  const envParsed = Number.parseInt(process.env.BANDIT_NO_TOKEN_WATCHDOG_MS ?? '', 10);
  if (Number.isFinite(envParsed) && envParsed >= 0) {
    return {
      detail: `env override ${envParsed}ms`,
      fix: envParsed === 0 ? 'Unset BANDIT_NO_TOKEN_WATCHDOG_MS to restore stall protection.' : undefined
    };
  }
  const configured = configuration.get<number>('watchdogMs', -1);
  if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) {
    return {
      detail: configured === 0 ? 'disabled in settings' : `pinned to ${Math.floor(configured)}ms`,
      fix: configured === 0 ? 'Set banditStealth.watchdogMs to -1 for auto sizing.' : undefined
    };
  }
  return { detail: 'auto-sized by prompt length and concurrent streams' };
}

function formatCheck(label: string, ok: boolean, detail: string, fix?: string): string[] {
  const mark = ok ? '✓' : '⚠';
  const lines = [`- ${mark} **${label}:** ${detail}`];
  if (fix) {lines.push(`  - Next: ${fix}`);}
  return lines;
}

/**
 * Handle a slash command. Returns true when the input was recognised
 * and processed (caller should NOT forward it to the model). Returns
 * false only for inputs that don't begin with a slash; today every
 * slash input is handled (unknown commands render a "not recognized"
 * pointer rather than falling through), so the caller treats `true`
 * as "consumed".
 */
export async function handleSlashCommand(
  raw: string,
  configuration: vscode.WorkspaceConfiguration,
  ctx: SlashCommandContext
): Promise<boolean> {
  const renderSystem = async (markdown: string) => {
    const entry = createConversationEntry('assistant', markdown, { payload: markdown });
    ctx.conversation.push(entry);
    await ctx.updateConversation(ctx.conversation);
    await ctx.syncState();
  };

  const stripped = raw.replace(/^\/+/, '').trim();
  const [head, ...rest] = stripped.split(/\s+/);
  const cmd = (head ?? '').toLowerCase();
  const arg = rest.join(' ').trim();

  if (cmd === 'help') {
    await renderSystem(HELP_BODY);
    return true;
  }

  if (cmd === 'clear') {
    await ctx.clearCurrentConversation();
    return true;
  }

  if (cmd === 'memory') {
    // /memory migrate [apply | plan] — the wizard lives in the CLI
    // because it needs interactive stdin (the [a/e/s/q] picker) and
    // direct child-process TTY handover for the editor spawn. Neither
    // composes cleanly with the webview's chat input. So in the IDE
    // we open a VS Code integrated terminal and run `bandit /memory
    // migrate ...` there — same wizard, same UX, just hosted in the
    // terminal pane instead of the chat composer. One-time setup
    // action: terminal-first is fine.
    const sub = arg.toLowerCase();
    if (sub === 'migrate' || sub === 'migrate apply' || sub === 'migrate plan') {
      const root = workspaceRoot();
      const banditCmd = `bandit /memory ${sub}`;
      let terminal = vscode.window.terminals.find((t) => t.name === 'Bandit memory migrate');
      if (!terminal) {
        terminal = vscode.window.createTerminal({
          name: 'Bandit memory migrate',
          cwd: root
        });
      }
      terminal.show(false);
      terminal.sendText(banditCmd, true);
      await renderSystem([
        `**Memory migration launched in terminal.**`,
        '',
        `Opened an integrated terminal and ran \`${banditCmd}\`. The wizard runs there — same UX as the CLI.`,
        '',
        sub === 'migrate' || sub === 'migrate plan'
          ? 'The agent will draft proposals into `.bandit/migration-preview/`. When it finishes, run `/memory migrate apply` (here or in the terminal) to launch the per-file accept/edit/skip wizard.'
          : 'Walk through each proposed file with `a` accept, `e` edit, `s` skip, `q` quit. Editor used: `$VISUAL` → `$EDITOR` → `code --wait` → `nano` / `notepad`.'
      ].join('\n'));
      return true;
    }
    const root = workspaceRoot();
    const bundle = await loadMemory(root).catch(() => ({ content: '', sources: [] as string[] }));
    if (!bundle.content) {
      await renderSystem(NO_MEMORY_BODY);
      return true;
    }
    const sources = bundle.sources.length ? bundle.sources.map((s: string) => `\`${s}\``).join(', ') : '(none)';
    await renderSystem([
      `**Project memory** — auto-loaded from ${sources}.`,
      '',
      '```markdown',
      bundle.content,
      '```'
    ].join('\n'));
    return true;
  }

  if (cmd === 'remember') {
    const fact = arg;
    if (!fact) {
      await renderSystem(REMEMBER_USAGE);
      return true;
    }
    const root = workspaceRoot();
    try {
      const abs = await appendMemory(root, fact);
      await renderSystem([
        `✓ Saved to project memory: "${fact}"`,
        '',
        `Persisted to \`${abs}\`. Auto-loaded on every future Bandit prompt in this workspace.`
      ].join('\n'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await renderSystem(`_Could not save to memory: ${msg}_`);
    }
    return true;
  }

  if (cmd === 'doctor') {
    const root = workspaceRoot();
    const providerKind = ctx.getProviderKind(configuration);
    const activeModel = getActiveModel(configuration, ctx);
    const profile = getModelBehaviorProfile(activeModel);
    const memoryFiles = ['BANDIT.md', 'CLAUDE.md', path.join('.bandit', 'BANDIT.md'), path.join('.bandit', 'CLAUDE.md')]
      .filter((p) => fs.existsSync(path.join(root, p)));
    const settingsPath = path.join(root, '.bandit', 'settings.json');
    const skillCount = (() => {
      try {
        return fs.readdirSync(path.join(root, '.bandit', 'skills'))
          .filter((name) => name.endsWith('.md') || name.endsWith('.json'))
          .length;
      } catch {
        return 0;
      }
    })();
    const traces = await listTurnTraces(root, 1).catch(() => []);
    const watchdog = formatWatchdog(configuration);
    const git = gitSummary(root);
    const checks: string[] = [];

    checks.push(...formatCheck(
      'Workspace',
      Boolean(vscode.workspace.workspaceFolders?.length),
      shortPath(root),
      vscode.workspace.workspaceFolders?.length ? undefined : 'Open a folder before using the agent.'
    ));
    checks.push(...formatCheck('Git repo', git.ok, git.detail, git.fix));
    checks.push(...formatCheck(
      'Project memory',
      memoryFiles.length > 0,
      memoryFiles.length > 0 ? memoryFiles.join(', ') : 'No BANDIT.md or CLAUDE.md found.',
      memoryFiles.length === 0 ? 'Use `/remember <fact>` or create BANDIT.md with project conventions.' : undefined
    ));
    checks.push(...formatCheck(
      'Permissions',
      fs.existsSync(settingsPath),
      fs.existsSync(settingsPath) ? '.bandit/settings.json present.' : 'Interactive approval cards are active.',
      fs.existsSync(settingsPath) ? undefined : 'Use approval cards to save trusted scopes as you work.'
    ));
    checks.push(...formatCheck(
      'Workspace skills',
      skillCount > 0,
      skillCount > 0 ? `${skillCount} workspace skill${skillCount === 1 ? '' : 's'} found.` : 'No workspace skills found.',
      skillCount === 0 ? 'Add `.bandit/skills/*.md` when a repeated workflow deserves a reusable skill.' : undefined
    ));

    if (providerKind === 'ollama') {
      const endpoint = getOllamaEndpoint(configuration);
      const installed = await listInstalledOllamaModels(endpoint).catch(() => []);
      const activeInstalled = installed.some((model) => model.name === activeModel || model.name.startsWith(`${activeModel}:`));
      checks.push(...formatCheck(
        'Provider',
        installed.length > 0 && activeInstalled,
        installed.length > 0
          ? `Ollama at ${endpoint} · ${installed.length} model${installed.length === 1 ? '' : 's'} visible · active ${activeModel}${activeInstalled ? '' : ' not found'}`
          : `Ollama selected but no models were discovered at ${endpoint}.`,
        installed.length === 0
          ? 'Start Ollama and pull a model such as qwen3.6:27b or gemma4:26b.'
          : activeInstalled ? undefined : `Pull or switch to ${activeModel}.`
      ));
    } else if (providerKind === 'bandit') {
      const hasKey = await ctx.hasBanditApiKey?.().catch(() => false);
      checks.push(...formatCheck(
        'Provider',
        Boolean(hasKey),
        hasKey ? `Bandit Cloud · active ${activeModel}` : `Bandit Cloud selected · active ${activeModel} · API key not saved`,
        hasKey ? undefined : 'Run "Bandit Stealth: Set API Key" from the Command Palette.'
      ));
    } else {
      const baseUrl = configuration.get<string>('openaiBaseUrl', '') ?? '';
      const openaiModel = configuration.get<string>('openaiModel', '') ?? '';
      checks.push(...formatCheck(
        'Provider',
        Boolean(baseUrl && openaiModel),
        baseUrl && openaiModel
          ? `OpenAI-compatible · ${baseUrl} · active ${openaiModel}`
          : 'OpenAI-compatible selected but base URL or model is missing.',
        baseUrl && openaiModel ? undefined : 'Set banditStealth.openaiBaseUrl and banditStealth.openaiModel.'
      ));
    }

    checks.push(...formatCheck(
      'Model profile',
      true,
      `${profile.label} · ${profile.protocol.preferred}${profile.protocol.fallback ? ` -> ${profile.protocol.fallback}` : ''} · output ${profile.context.outputBudgetTokens} tok · max ${profile.reliability.maxParallelTools} parallel tool${profile.reliability.maxParallelTools === 1 ? '' : 's'}`
    ));
    checks.push(...formatCheck('Watchdog', !watchdog.fix, watchdog.detail, watchdog.fix));
    checks.push(...formatCheck(
      'Turn traces',
      traces.length > 0,
      traces.length > 0 ? `latest: ${traces[0].summary.id}` : 'No `.bandit/turns` traces yet.',
      traces.length === 0 ? 'Run one agent turn, then use `/trace` when behavior is confusing.' : undefined
    ));

    const next: string[] = [];
    if (memoryFiles.length === 0) {next.push('/remember <fact>');}
    if (!git.ok || git.dirtyCount > 0) {next.push('/trace');}
    if (providerKind === 'ollama') {next.push('/profile');}
    if (next.length === 0) {next.push('/plan <goal>', '/trace', '/profile');}

    await renderSystem([
      '**Bandit doctor**',
      '',
      ...checks,
      '',
      '**Next best actions**',
      next.map((item) => `- \`${item}\``).join('\n')
    ].join('\n'));
    return true;
  }

  if (cmd === 'model') {
    const providerKind = ctx.getProviderKind(configuration);
    if (!arg) {
      const current = providerKind === 'ollama'
        ? ctx.resolveOllamaBaseModel(configuration)
        : configuration.get<string>('model', 'bandit-core-1');
      await renderSystem([
        `**Active model:** \`${current}\` (provider: \`${providerKind}\`)`,
        '',
        'Switch with `/model <name>` — e.g. `/model gemma4:26b` for Ollama, `/model bandit-logic` for cloud.'
      ].join('\n'));
      return true;
    }
    const target = providerKind === 'ollama' ? 'ollamaModel' : 'model';
    await configuration.update(target, arg, vscode.ConfigurationTarget.Global);
    await renderSystem(`✓ Model set to \`${arg}\`. Next prompt uses the new model.`);
    return true;
  }

  if (cmd === 'ollama') {
    const current = configuration.get<string>('ollamaBaseUrl', '')
      || configuration.get<string>('ollamaUrl', '')
      || 'http://localhost:11434';
    if (!arg) {
      await renderSystem([
        `**Ollama endpoint:** \`${current}\``,
        '',
        '`/ollama default` resets to `http://localhost:11434`. `/ollama <url>` sets a remote endpoint.'
      ].join('\n'));
      return true;
    }
    const isReset = /^(default|reset|local|localhost)$/i.test(arg);
    const url = isReset ? 'http://localhost:11434' : arg;
    if (!isReset && !/^https?:\/\//i.test(url)) {
      await renderSystem(`_"${arg}" doesn't look like a URL. Expected http:// or https://._`);
      return true;
    }
    await configuration.update('ollamaBaseUrl', url, vscode.ConfigurationTarget.Global);
    await configuration.update('ollamaUrl', url, vscode.ConfigurationTarget.Global);
    await ctx.syncState();
    await renderSystem(`✓ Ollama endpoint set to \`${url}\`.`);
    return true;
  }

  if (cmd === 'think') {
    const mode = arg.toLowerCase();
    if (mode !== 'on' && mode !== 'off' && mode !== 'auto') {
      await renderSystem('_Usage: `/think on`, `/think off`, or `/think auto`._');
      return true;
    }
    await configuration.update('thinkingMode', mode, vscode.ConfigurationTarget.Global);
    await renderSystem(`✓ Thinking mode set to \`${mode}\`. Applies on the next prompt.`);
    return true;
  }

  if (cmd === 'trace') {
    const root = workspaceRoot();
    if (!arg || arg === 'last') {
      const [trace] = await listTurnTraces(root, { limit: 1, includeGlobal: true });
      await renderSystem(trace ? formatTurnTraceMarkdown(trace) : '_No turn traces found in workspace/global `.bandit/turns` yet._');
      return true;
    }
    if (arg === 'list' || arg === 'ls' || arg === 'all' || arg === 'failed') {
      const traces = await listTurnTraces(root, {
        limit: arg === 'failed' ? 40 : 16,
        includeGlobal: true,
        status: arg === 'failed' ? ['failed', 'blocked', 'cancelled'] : undefined
      });
      if (traces.length === 0) {
        await renderSystem('_No matching turn traces found in workspace/global `.bandit/turns` yet._');
        return true;
      }
      await renderSystem([
        arg === 'failed' ? '**Failed/blocked turn traces**' : '**Recent turn traces**',
        '',
        ...traces.map((trace) => {
          const s = trace.summary;
          const prompt = (s.prompt ?? '').replace(/\s+/g, ' ');
          const shortPrompt = prompt.length > 90 ? `${prompt.slice(0, 87)}...` : prompt;
          const started = s.startedAt ? s.startedAt.slice(0, 19).replace('T', ' ') : 'unknown';
          const source = `${s.scope}${s.workspace ? ` · ${shortPath(s.workspace)}` : ''}`;
          return `- \`${s.id}\` — ${s.status}, ${s.toolCalls} tools, ${s.retries} retries, ${s.nativeFallbacks} fallbacks · ${source} · ${started}${shortPrompt ? ` — ${shortPrompt}` : ''}`;
        }),
        '',
        '_Run `/trace <id>` for the full timeline. Use `/trace failed` for recovery/debugging runs._'
      ].join('\n'));
      return true;
    }
    const trace = await readTurnTraceById(root, arg, { includeGlobal: true });
    await renderSystem(trace ? formatTurnTraceMarkdown(trace) : `_Trace not found: \`${arg}\`_`);
    return true;
  }

  if (cmd === 'profile') {
    const providerKind = ctx.getProviderKind(configuration);
    const modelId = arg || (providerKind === 'ollama'
      ? ctx.resolveOllamaBaseModel(configuration)
      : configuration.get<string>('model', 'bandit-core-1') ?? 'bandit-core-1');
    const profile = getModelBehaviorProfile(modelId);
    await renderSystem([
      '**Model behavior profile**',
      '',
      `- Model: \`${modelId}\``,
      `- Profile: ${profile.label} (\`${profile.id}\`)`,
      `- Protocol: \`${profile.protocol.preferred}\`${profile.protocol.fallback ? ` → \`${profile.protocol.fallback}\`` : ''} via \`${profile.protocol.envelope}\``,
      `- Native fallback: ${profile.protocol.nativeToolFailureFallback ? 'yes' : 'no'}`,
      `- Context: safe input ${profile.context.safeInputTokens} tok · output ${profile.context.outputBudgetTokens} tok · compaction \`${profile.context.compaction}\``,
      `- Prompting: \`${profile.prompting.template}\` · examples \`${profile.prompting.examples}\` · thinking \`${profile.prompting.thinking}\``,
      `- Max parallel tools: ${profile.reliability.maxParallelTools}`,
      '',
      '**Known failure modes**',
      ...profile.reliability.knownFailureModes.map((mode: string) => `- ${mode}`),
      '',
      '_Workspace overrides load from `.bandit/model-profiles.json`._'
    ].join('\n'));
    return true;
  }

  // Unknown slash — short pointer so the model never sees it.
  await renderSystem([
    `_\`/${cmd}\` is not a recognized IDE slash command._`,
    '',
    'Run `/help` for the IDE list. The terminal CLI (`bandit` in your shell) supports more — including `/usage`, `/session`, `/theme`, `/init`, `/commit`, `/review`, `/refactor`, `/test`, `/explain`.'
  ].join('\n'));
  return true;
}

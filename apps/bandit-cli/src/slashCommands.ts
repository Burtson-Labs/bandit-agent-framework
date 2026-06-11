import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { c, glyph, linkify, setActiveTheme, THEME_NAMES } from './ansi';
import { saveTheme, saveCoauthor, saveWatchdogMs, saveNotifications } from './config';
import { connectGoogleViaCli, listGoogleConnections, disconnectGoogle } from './mcpGoogleConnect';
import { readClipboardImage } from './clipboardImage';
import { planSkill, scaffoldMarkdownSkill, compactToolMessages, redactSecretsString, type SkillRegistry, type ToolLoopMessage } from '@burtson-labs/agent-core';
import {
  listInstalledOllamaModels,
  suggestOllamaMatch,
  CheckpointStore,
  looksLikeGitHubToken,
  looksLikeGmailCredentialsPath,
  listTurnTraces,
  readTurnTraceById,
  formatTurnTraceMarkdown
} from '@burtson-labs/host-kit';
import { getModelBehaviorProfile } from '@burtson-labs/stealth-core-runtime';
import type { SessionStore } from './session';
import type { ToolExecutionContext } from '@burtson-labs/agent-core';
import { describeConfig, globalConfigPath, saveApiKey, clearApiKey, saveProvider, saveOllamaUrl, saveOpenaiConfig, saveTavilyKey, clearTavilyKey, addRepoRoot, removeRepoRoot, type ResolvedConfig, type ConfiguredProviderKind } from './config';
import { OPENAI_PRESETS } from './openaiPresets';

// Canonical registry package — version checks always go here.
const REGISTRY_PACKAGE = '@burtson-labs/bandit-stealth-cli';
// Install target: the unscoped alias (`bandit-stealth-cli`) and the scoped
// package both provide the `bandit` bin, so `npm i -g` of the *other* name
// fails with an EEXIST bin conflict. Reinstall through whichever package
// owns the running binary.
const PACKAGE_NAME = (() => {
  try {
    const real = fs.realpathSync(process.argv[1] || '');
    if (/[\\/]node_modules[\\/]bandit-stealth-cli[\\/]/.test(real)) return 'bandit-stealth-cli';
  } catch { /* dev builds / direct node invocation */ }
  return REGISTRY_PACKAGE;
})();

function shortHomePath(value: string): string {
  const home = process.env.HOME || '';
  return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

/**
 * Ask the user's local npm to fetch the latest version from the configured
 * registry (uses whatever auth is in ~/.npmrc). Runs with a short timeout
 * so a slow network doesn't freeze the REPL.
 */
function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = cp.spawn('npm', ['view', REGISTRY_PACKAGE, 'version'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    proc.stdout?.on('data', (d) => { out += d.toString(); });
    const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(null); }, 8000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim() : null);
    });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

/** Semver compare — returns -1 / 0 / 1. Handles 3-segment versions only. */
function semverCompare(a: string, b: string): number {
  const parse = (v: string) => v.replace(/[^0-9.]/g, '').split('.').map((s) => parseInt(s, 10) || 0);
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}

export interface SlashContext {
  skillRegistry: SkillRegistry;
  session: SessionStore;
  cwd: string;
  model: { current: string; set(next: string): void };
  toolCtx: ToolExecutionContext;
  /** Returns the effective resolved config for /config inspection. */
  getConfig: () => ResolvedConfig;
  /** Active provider kind — determines whether /model should query
   * local Ollama or skip the list (hosted Bandit doesn't expose one). */
  providerKind: ConfiguredProviderKind;
  /** Mutate the active provider mid-session. Used by /provider so the
   * user can swap between local Ollama and Bandit Cloud without
   * restarting bandit. The setter rebuilds settings + kind so the
   * NEXT chat request uses the new provider. */
  setProvider?: (next: 'bandit' | 'ollama' | 'openai-compatible') => void;
  /** Ollama base URL for /model discovery. */
  ollamaUrl: string;
  /** Mutate the Ollama base URL mid-session. /ollama uses this so the
   * user can flip between localhost and a remote endpoint without
   * restarting. Empty string resets to the framework default
   * (http://localhost:11434). */
  setOllamaUrl?: (next: string) => void;
  /** Conversation history — /compact uses this to trim older tool
   * results when they're bloating the context. */
  getConversation: () => ToolLoopMessage[];
  setConversation: (next: ToolLoopMessage[]) => void;
  /** Budget (in tokens) used for /compact. Wired from the active
   * model's num_ctx at call time. */
  tokenBudget: () => number;
  /** Per-session thinking-mode override for reasoning-capable models
   * (Qwen 3.x, DeepSeek R1). `undefined` = use runtime default
   * (currently off for bandit-logic). `true` / `false` = force on/off
   * for every subsequent chat request in this session. Toggled via
   * the `/think` slash command. */
  thinkingMode: { get(): boolean | undefined; set(next: boolean | undefined): void };
  /** When on, each user prompt runs the heuristic planner first and
   * shows a "proceed? y/N" prompt before the model actually executes.
   * Useful for long refactors / multi-file edits where the user wants
   * a preview before burning iterations and tokens. Default off. */
  planPreview: { get(): boolean; set(next: boolean): void };
  /** Bandit co-author trailer toggle. When `get()` returns
   * true the system prompt directs the agent to append
   * `Co-authored-by: Bandit <bandit@burtson.ai>` to commits it issues.
   * `envOff` reports whether `BANDIT_NO_COAUTHOR=1` is forcing off
   * this shell, so `/coauthor status` can tell the user why they
   * can't toggle on without unsetting the env var. */
  coauthor: { get(): boolean; set(next: boolean): void; envOff: boolean };
  /** no-token watchdog persistence + session override.
   * `get()` returns the current session value (undefined = auto-scale,
   * 0 = disabled, positive ms = pinned window). `envValue` reports
   * the BANDIT_NO_TOKEN_WATCHDOG_MS shell override so `/watchdog
   * status` can show the user that env wins when both are set. */
  watchdog: {
    get(): number | undefined;
    set(next: number | undefined): void;
    envValue: number | undefined;
  };
  notifications?: {
    get(): { desktop: boolean; sound: boolean; minTurnMs: number };
    set(next: Partial<{ desktop: boolean; sound: boolean; minTurnMs: number }>): void;
  };
  exit: () => void;
  clearConversation: () => void;
  reloadMemory: () => Promise<string>;
  /** Read one line from the REPL — used by /plan to ask "Run now?"
   * without spinning up a second readline. */
  getLine?: () => Promise<string>;
  /** Push a prompt onto the REPL's line queue so the REPL picks it up
   * on the next iteration. /plan uses this to execute an approved
   * plan without the user having to re-type the goal. */
  queuePrompt?: (line: string) => void;
  /** Long-lived background-subagent task store. /tasks reads from it
   * to list running + completed tasks and supports cancellation.
   * Optional — only set when the host wired in async subagents. */
  backgroundStore?: import('@burtson-labs/host-kit').BackgroundTaskStore;
  /** Long-lived MCP client pool. /mcp uses it to list status,
   * introspect tools, and explicitly connect/disconnect servers.
   * Optional — only set when the host wired MCP support. */
  mcpPool?: import('@burtson-labs/agent-core').McpClientPool;
  /** Re-read mcp-servers.json from disk and register every entry
   * with the pool. Returns the number of servers registered after
   * the reload. Used by `/mcp reload` so the user can edit their
   * config file without restarting the REPL. */
  reloadMcpFromDisk?: () => Promise<number>;
  /** Revoke an "always allow" trust decision for an MCP server. The
   * fingerprint is removed from ~/.bandit/mcp-trust.json so the next
   * first-spawn re-prompts the user. */
  revokeMcpTrust?: (serverName: string) => Promise<boolean>;
  /** Toggle a server's activation mode and persist to disk. Returns
   * false when the server isn't registered. */
  setMcpActivation?: (serverName: string, mode: 'always' | 'on-mention') => Promise<boolean>;
  /** GitHub connector wizard — accepts a PAT, writes the standard
   * github MCP server entry, pre-trusts it. Returns the path of
   * the mcp-servers.json file that was updated. */
  addGitHubMcp?: (token: string) => Promise<string>;
  /** Slack connector wizard — bot token + team ID. */
  addSlackMcp?: (botToken: string, teamId: string) => Promise<string>;
  /** GitLab connector wizard — token + optional API URL for self-hosted. */
  addGitLabMcp?: (token: string, apiUrl?: string) => Promise<string>;
  /** Gmail connector wizard — path to a Google OAuth credentials JSON
   * the user downloaded from Cloud Console. */
  addGmailMcp?: (credentialsPath: string) => Promise<string>;
  /** Custom connector — name + raw command line + env vars. Covers
   * every MCP server we don't ship a dedicated wizard for. */
  addCustomMcp?: (params: { name: string; command: string; args?: string[]; envInput?: string }) => Promise<string>;
  /** Run one non-streaming chat completion through the active provider.
   * Used by /insights to ask the user's own LLM to summarize their
   * usage. The slash command stays out of provider-construction
   * details — cli.ts wires this with createProvider + the resolved
   * ProviderSettings. Returns null on any failure (no provider, network
   * error, parse failure) so callers can fall back to a static path. */
  oneShotChat?: (prompt: string, opts?: { systemPrompt?: string; timeoutMs?: number }) => Promise<string | null>;
  /** Hand-off to the interactive memory-migrate wizard. The slash
   *  command's job is just to detect the right subcommand and queue
   *  the plan prompt or invoke this callback; cli.ts owns the actual
   *  picker rendering + editor spawn because they need direct access
   *  to ink's pause/resume, raw-stdin reads, and child-process TTY
   *  handover. Returns when the wizard either applies or quits. Absent
   *  in non-CLI hosts (the IDE forwards `/memory migrate apply` to a
   *  terminal session running the CLI version instead). */
  runMemoryMigrateWizard?: () => Promise<void>;
}

export interface SlashCommand {
  name: string;
  description: string;
  run(args: string, ctx: SlashContext): Promise<string> | string;
}

const HELP_GROUPS: Array<{ title: string; names: string[] }> = [
  { title: 'Start Here', names: ['doctor', 'connect', 'config', 'model', 'provider', 'help'] },
  { title: 'Daily Work', names: ['init', 'plan', 'review', 'test', 'refactor', 'explain', 'commit'] },
  { title: 'Context', names: ['paste', 'remember', 'memory', 'compact', 'rewind', 'session'] },
  { title: 'Automation', names: ['tasks', 'skills', 'skill', 'mcp', 'repos'] },
  { title: 'Account & Runtime', names: ['login', 'logout', 'usage', 'ollama', 'tavily', 'think', 'profile', 'watchdog', 'notify', 'theme', 'update'] },
  { title: 'Reports', names: ['trace', 'insights', 'onboard', 'changelog'] }
];

function findCommandForHelp(name: string): SlashCommand | undefined {
  return slashCommands.find((cmd) => cmd.name === name);
}

function renderHelpAll(): string {
  const rows = slashCommands.map(cmd =>
    `  ${c.cyan('/' + cmd.name.padEnd(14))} ${c.dim(cmd.description)}`
  );
  return [
    c.bold('All slash commands:'),
    ...rows,
    '',
    c.dim('Tip: prefix any file with @ to pin it, or run /help permissions for the permission model.')
  ].join('\n');
}

function renderHelpPermissions(): string {
  return [
    c.bold('Permission choices'),
    '',
    `  ${c.accent('allow once')}       ${c.dim('Run only this exact request. Best default for edits and commands.')}`,
    `  ${c.accent('allow session')}    ${c.dim('Allow this tool type until you exit Bandit. Useful during active refactors.')}`,
    `  ${c.accent('always for target')} ${c.dim('Save an allow rule for this workspace target in .bandit/settings.json.')}`,
    `  ${c.accent('deny')}             ${c.dim('Block the tool call. Bandit should not retry the same call.')}`,
    `  ${c.accent('deny + note')}      ${c.dim('Block it and tell Bandit what safer approach to try instead.')}`,
    '',
    c.bold('Good defaults'),
    `  ${c.dim('•')} ${c.cyan('read_file/search_code')} ${c.dim('can usually be allowed for the session.')}`,
    `  ${c.dim('•')} ${c.cyan('apply_edit/replace_range/write_file')} ${c.dim('review the diff, then allow once or session.')}`,
    `  ${c.dim('•')} ${c.cyan('run_command')} ${c.dim('check the full command line and cwd before approving.')}`,
    '',
    c.dim('Run /doctor any time you want Bandit to explain your current setup and next best actions.')
  ].join('\n');
}

function renderGroupedHelp(): string {
  const lines: string[] = [
    c.bold('Bandit commands'),
    c.dim('Use /help all for the full list, /help permissions for approval choices.'),
    ''
  ];
  const shown = new Set<string>();
  for (const group of HELP_GROUPS) {
    const rows = group.names
      .map((name) => findCommandForHelp(name))
      .filter((cmd): cmd is SlashCommand => !!cmd);
    if (rows.length === 0) continue;
    lines.push(c.bold(group.title));
    for (const cmd of rows) {
      shown.add(cmd.name);
      lines.push(`  ${c.cyan('/' + cmd.name.padEnd(14))} ${c.dim(cmd.description)}`);
    }
    lines.push('');
  }
  const hidden = slashCommands.filter((cmd) => !shown.has(cmd.name) && cmd.name !== 'quit');
  if (hidden.length > 0) {
    lines.push(c.dim(`Also available: ${hidden.map((cmd) => '/' + cmd.name).join(', ')}`));
    lines.push('');
  }
  lines.push(c.dim('Fast path: /doctor → /connect or /init → ask for the change → /review → /test → /commit'));
  return lines.join('\n');
}

/**
 * Render `/insights --text` as a tight CLI summary. Mirrors the data the
 * HTML report shows but lays it out as ~20 lines of plain text the user
 * can read without leaving the REPL. Goal: a single-glance answer to
 * "how am I using Bandit?" — top tools, top files, git activity, streak,
 * and the headline error friction. Stays purely synchronous (no AI
 * callback) so it's fast and doesn't gate on consent.
 */
function renderInsightsText(data: import('@burtson-labs/host-kit').InsightsData): string {
  const lines: string[] = [];
  const acc = data.accomplishments;
  const days = Math.max(1, Math.round((Date.now() - (data.firstSeenAt ?? Date.now())) / 86400000));

  // Storyline first. Prefer AI prose when available, otherwise use the
  // deterministic local synthesis so `/insights --text` still names
  // actual wins instead of showing only counters.
  const story = data.ai?.storyline && data.ai.storyline.length > 0 ? data.ai.storyline : data.localStory;
  if (story.length > 0) {
    const cols = Math.min(process.stdout.columns || 80, 100);
    const wrapWidth = Math.max(40, cols - 4);
    lines.push(c.bold('Your story') + c.dim(`  ·  ${data.ai?.storyline?.length ? data.ai.modelLabel : 'local synthesis'}`));
    lines.push('');
    for (const para of story) {
      const words = para.replace(/\s+/g, ' ').trim().split(' ');
      let line = '';
      for (const w of words) {
        if (line.length === 0) line = w;
        else if (line.length + 1 + w.length <= wrapWidth) line += ' ' + w;
        else { lines.push('  ' + line); line = w; }
      }
      if (line) lines.push('  ' + line);
      lines.push('');
    }
  }

  lines.push(c.bold('How you use Bandit'));
  lines.push('');
  // Headline — always the first thing read.
  lines.push(`  ${c.dim('sessions    ')} ${c.accent(String(data.sessions.length))}  ${c.dim('over ' + days + ' day' + (days === 1 ? '' : 's'))}`);
  lines.push(`  ${c.dim('prompts     ')} ${c.accent(String(data.totalPrompts))}  ${c.dim('~' + (data.totalApproxTokens >= 1000 ? (data.totalApproxTokens / 1000).toFixed(1) + 'K' : data.totalApproxTokens) + ' tokens')}`);
  if (data.streak.current > 0 || data.streak.longest > 0) {
    lines.push(`  ${c.dim('streak      ')} ${c.accent(data.streak.current + ' day' + (data.streak.current === 1 ? '' : 's'))}  ${c.dim('(longest ' + data.streak.longest + ')')}`);
  }
  if (data.peakDay) {
    lines.push(`  ${c.dim('peak day    ')} ${c.accent(data.peakDay.date)}  ${c.dim(data.peakDay.prompts + ' prompts')}`);
  }
  lines.push('');
  // What got done. Headline accomplishments are the user-facing answer
  // to "what did Bandit help me ship?".
  lines.push(c.bold('What got done'));
  lines.push(`  ${c.dim('files touched ')} ${c.accent(String(acc.filesTouched))}  ${c.dim('(' + acc.filesWritten + ' written, ' + acc.editsApplied + ' edited)')}`);
  if (acc.gitOperations > 0) {
    lines.push(`  ${c.dim('git ops       ')} ${c.accent(String(acc.gitOperations))}  ${c.dim('(' + acc.commitsMade + ' commits)')}`);
  }
  if (acc.testsRun > 0) {
    lines.push(`  ${c.dim('tests run     ')} ${c.accent(String(acc.testsRun))}`);
  }
  if (acc.subagentsSpawned > 0) {
    lines.push(`  ${c.dim('subagents     ')} ${c.accent(String(acc.subagentsSpawned))}`);
  }
  if (acc.languages.length > 0) {
    const langs = acc.languages.slice(0, 5).map(l => `${l.label} ${c.dim('(' + l.count + ')')}`).join(c.dim(', '));
    lines.push(`  ${c.dim('languages     ')} ${langs}`);
  }
  if (data.work.themes.length > 0) {
    lines.push('');
    lines.push(c.bold('Bigger arcs'));
    for (const theme of data.work.themes.slice(0, 4)) {
      const bits = [
        `${theme.turns} turn${theme.turns === 1 ? '' : 's'}`,
        theme.filesTouched > 0 ? `${theme.filesTouched} files` : '',
        theme.testsRun > 0 ? `${theme.testsRun} tests` : '',
        theme.externalActions > 0 ? `${theme.externalActions} external` : '',
        theme.subagentsSpawned > 0 ? `${theme.subagentsSpawned} subagents` : ''
      ].filter(Boolean).join(', ');
      lines.push(`  ${c.cyan(theme.title)} ${c.dim(bits ? '— ' + bits : '')}`);
      if (theme.outcomes.length > 0) {
        lines.push(c.dim(`    ${theme.outcomes[0]}`));
      }
      if (theme.sampleTitles.length > 0) {
        lines.push(c.dim(`    ${theme.sampleTitles[0]}`));
      }
    }
  }
  if (data.work.highlights.length > 0) {
    lines.push('');
    lines.push(c.bold('Largest work highlights'));
    for (const h of data.work.highlights.slice(0, 5)) {
      lines.push(`  ${c.cyan(h.date)} ${c.accent(h.area)} ${c.dim('· ' + h.category)}`);
      lines.push(c.dim(`    ${h.title}`));
      lines.push(c.dim(`    ${h.summary}`));
      if (h.outcome) lines.push(c.dim(`    ${h.outcome}`));
    }
  }
  if (acc.topFiles.length > 0) {
    lines.push('');
    lines.push(c.bold('Most-touched files'));
    for (const f of acc.topFiles.slice(0, 5)) {
      lines.push(`  ${c.cyan(f.path)} ${c.dim('×' + f.touches)}`);
    }
  }
  // Tool usage — top by call count, with error-rate flag for the friction
  // case (apply_edit at 40% error rate is the kind of thing the user
  // should know about even when totals look healthy).
  const tools = [...data.toolStats.entries()]
    .map(([name, s]) => ({ name, calls: s.calls, errors: s.errors, rate: s.calls > 0 ? s.errors / s.calls : 0 }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 6);
  if (tools.length > 0) {
    lines.push('');
    lines.push(c.bold('Top tools'));
    for (const t of tools) {
      const ratePct = Math.round(t.rate * 100);
      const errFlag = t.calls >= 5 && ratePct >= 25
        ? ' ' + c.yellow('⚠ ' + ratePct + '% error rate')
        : '';
      lines.push(`  ${c.cyan(t.name.padEnd(16))} ${c.accent(String(t.calls).padStart(4))}  ${c.dim('calls')}${errFlag}`);
    }
  }
  // Friction — surface only the loudest error pattern. Full clusters
  // are in the HTML report; the CLI summary keeps it to one line so the
  // section doesn't bloat into a debug log.
  const flatErrors = [...data.errorClusters.entries()]
    .flatMap(([tool, bucket]) => bucket.map(b => ({ tool, error: b.error, count: b.count })))
    .sort((a, b) => b.count - a.count);
  if (flatErrors.length > 0) {
    const top = flatErrors[0];
    const errPreview = top.error.replace(/\s+/g, ' ').slice(0, 70);
    lines.push('');
    lines.push(c.bold('Top friction'));
    lines.push(`  ${c.cyan(top.tool)} ${c.dim('×' + top.count)}  ${c.dim(errPreview + (top.error.length > 70 ? '…' : ''))}`);
  }
  // Sentiment — only show the section when there's any signal. Positive
  // and negative chips on one line, then notable frustration phrases
  // (sanitized) below if any. Honest visibility into how the user feels
  // about working with Bandit, scanned deterministically from prompts.
  const s = data.sentiment;
  const sentTotal = s.satisfied + s.happy + s.excited + s.frustrated + s.unsatisfied;
  if (sentTotal > 0) {
    const pos: string[] = [];
    if (s.excited > 0) pos.push(c.green('excited ') + c.bold(String(s.excited)));
    if (s.happy > 0) pos.push(c.green('happy ') + c.bold(String(s.happy)));
    if (s.satisfied > 0) pos.push(c.green('satisfied ') + c.bold(String(s.satisfied)));
    const neg: string[] = [];
    if (s.unsatisfied > 0) neg.push(c.yellow('unsatisfied ') + c.bold(String(s.unsatisfied)));
    if (s.frustrated > 0) neg.push(c.red('frustrated ') + c.bold(String(s.frustrated)));
    lines.push('');
    lines.push(c.bold('How you felt'));
    if (pos.length > 0) lines.push(`  ${pos.join(c.dim('  ·  '))}`);
    if (neg.length > 0) lines.push(`  ${neg.join(c.dim('  ·  '))}`);
    if (s.notable.length > 0) {
      lines.push(c.dim('  Frustration moments:'));
      for (const note of s.notable.slice(0, 3)) {
        lines.push(c.dim('    "') + c.dim(note) + c.dim('"'));
      }
    }
  }
  lines.push('');
  lines.push(c.dim('  Full report (HTML + AI summary): ') + c.cyan('/insights'));
  return lines.join('\n');
}

export const slashCommands: SlashCommand[] = [
  {
    name: 'help',
    description: 'List available slash commands',
    run(args) {
      const topic = args.trim().toLowerCase();
      if (topic === 'all' || topic === '--all') return renderHelpAll();
      if (topic === 'permissions' || topic === 'permission' || topic === 'approve' || topic === 'approval') {
        return renderHelpPermissions();
      }
      return renderGroupedHelp();
    }
  },
  {
    name: 'clear',
    description: 'Clear the current conversation history',
    run(_args, ctx) {
      ctx.clearConversation();
      return c.dim('(conversation cleared)');
    }
  },
  {
    name: 'paste',
    description: 'Save the clipboard image to .bandit/pastes/ so you can reference it with @<path>',
    async run(_args, ctx) {
      const img = await readClipboardImage();
      if (!img) {
        return c.dim('(no image on clipboard — copy or screenshot an image first, then retry)');
      }
      // Move the tempfile into the project's .bandit/pastes/ so @-mention
      // expansion has a stable, workspace-relative path to inline. Using
      // the workspace keeps the images near the turns/checkpoints that
      // referenced them rather than scattered in /tmp.
      const destDir = path.join(ctx.cwd, '.bandit', 'pastes');
      try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* already exists */ }
      const destName = `paste-${Date.now()}.png`;
      const destPath = path.join(destDir, destName);
      try {
        fs.renameSync(img.path, destPath);
      } catch {
        // Cross-device rename — fall back to copy.
        fs.copyFileSync(img.path, destPath);
        try { fs.unlinkSync(img.path); } catch { /* best-effort cleanup */ }
      }
      const relPath = path.relative(ctx.cwd, destPath);
      const kb = Math.round(img.sizeBytes / 1024);
      return [
        c.dim(`  ${glyph.check} saved clipboard image (${kb} KB) → ${c.cyan(relPath)}`),
        c.dim(`     reference it in your next message with ${c.cyan('@' + relPath)}`)
      ].join('\n');
    }
  },
  {
    name: 'rewind',
    description: 'List checkpoints or restore a file edit (/rewind, /rewind <id>, /rewind last)',
    async run(args, ctx) {
      const store = new CheckpointStore({ workspaceRoot: ctx.cwd });
      const arg = args.trim();
      if (!arg) {
        const list = await store.list(10);
        if (list.length === 0) {
          return c.dim('(no checkpoints yet — rewind is available after the agent makes an edit)');
        }
        const rows = list.map((e, i) => {
          const marker = i === 0 ? c.accent('●') : ' ';
          const stats = c.dim(`+${e.plus} −${e.minus}`);
          return `  ${marker} ${c.cyan(e.id.padEnd(14))} ${e.tool.padEnd(10)} ${e.relPath}  ${stats}`;
        });
        return [
          c.bold('Recent checkpoints:'),
          ...rows,
          '',
          c.dim(`Use ${c.cyan('/rewind <id>')} or ${c.cyan('/rewind last')} to restore.`)
        ].join('\n');
      }
      let targetId = arg;
      if (arg === 'last' || arg === '--last') {
        const list = await store.list(1);
        if (list.length === 0) return c.dim('(no checkpoints to rewind to)');
        targetId = list[0].id;
      }
      const entry = await store.rewind(targetId);
      if (!entry) {
        return c.dim(`Checkpoint "${targetId}" not found. Run /rewind to list.`);
      }
      const action = entry.isNewFile ? 'deleted (was new file)' : 'restored to pre-edit state';
      return [
        `${glyph.check} rewound ${c.accent(entry.id)} — ${c.cyan(entry.relPath)} ${action}`,
        c.dim(`  turn ${entry.turnId} · iteration ${entry.iteration} · ${entry.tool}`)
      ].join('\n');
    }
  },
  {
    name: 'compact',
    description: 'Compact the conversation history — collapses older tool results to one-line placeholders to fit the model context window',
    run(_args, ctx) {
      const before = ctx.getConversation();
      if (before.length === 0) {
        return c.dim('(conversation is empty)');
      }
      const budget = ctx.tokenBudget();
      const report = compactToolMessages(before, { tokenBudget: budget });
      if (report.messagesCompacted === 0) {
        return c.dim(
          `(no compaction needed — ${report.beforeTokens} tokens in ${before.length} msgs, budget ${budget})`
        );
      }
      ctx.setConversation(report.compacted);
      const saved = report.beforeTokens - report.afterTokens;
      return [
        `${glyph.check} compacted ${c.accent(String(report.messagesCompacted))} message${report.messagesCompacted === 1 ? '' : 's'}`,
        c.dim(`  before: ${report.beforeTokens} tokens · after: ${report.afterTokens} tokens · saved ~${saved}`)
      ].join('\n');
    }
  },
  {
    name: 'connect',
    description: 'Interactive setup wizard — pick provider (Ollama / Bandit Cloud / OpenAI-compatible), point at a preset, save to ~/.bandit/config.json',
    async run(_args, ctx) {
      if (!ctx.getLine) {
        return c.dim('(/connect must run inside the REPL — needs an interactive prompt)');
      }
      const ask = ctx.getLine;

      // Step 1 — pick provider.
      process.stdout.write('\n' + c.bold('Connect Bandit to a provider') + '\n');
      process.stdout.write(c.dim('Pick where the agent\'s requests should go.') + '\n\n');
      process.stdout.write('  ' + c.cyan('1') + ' Ollama ' + c.dim('— local, private, free (default)') + '\n');
      process.stdout.write('  ' + c.cyan('2') + ' Bandit Cloud ' + c.dim('— hosted, OAuth sign-in') + '\n');
      process.stdout.write('  ' + c.cyan('3') + ' OpenAI-compatible ' + c.dim('— LM Studio, llama.cpp, OpenRouter, Together, Groq, OpenAI…') + '\n\n');
      process.stdout.write(c.dim('Choice [1/2/3, Enter to cancel] '));
      const choice = (await ask()).trim();
      if (!choice) {
        return c.dim('↷ /connect cancelled.');
      }

      // ── Ollama ──
      if (choice === '1' || choice.toLowerCase() === 'ollama') {
        const cfg = ctx.getConfig();
        const currentUrl = cfg.ollamaUrl ?? 'http://localhost:11434';
        process.stdout.write('\n' + c.bold('Ollama endpoint') + '\n');
        process.stdout.write(c.dim(`  current: ${currentUrl}`) + '\n');
        process.stdout.write(c.dim('  Press Enter to keep, or paste a new URL: '));
        const urlInput = (await ask()).trim();
        const url = urlInput || currentUrl;
        const currentModel = cfg.model || 'gemma4:e4b';
        process.stdout.write('\n' + c.bold('Default model') + '\n');
        process.stdout.write(c.dim(`  current: ${currentModel}`) + '\n');
        process.stdout.write(c.dim('  Press Enter to keep, or type a model id: '));
        const modelInput = (await ask()).trim();
        const model = modelInput || currentModel;
        try {
          if (urlInput && urlInput !== currentUrl) await saveOllamaUrl(url);
          await saveProvider('ollama', model);
          ctx.setProvider?.('ollama');
          ctx.model.set(model);
          return [
            '',
            c.green('✓ saved') + c.dim(' to ') + c.cyan(globalConfigPath()),
            c.dim('  provider: ') + c.cyan('ollama'),
            c.dim('  endpoint: ') + c.cyan(url),
            c.dim('  model:    ') + c.cyan(model),
            c.dim('Use /model to list other locally-installed Ollama tags.')
          ].join('\n');
        } catch (err) {
          return c.red(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── Bandit Cloud ──
      if (choice === '2' || choice.toLowerCase() === 'bandit') {
        process.stdout.write('\n' + c.bold('Bandit Cloud') + '\n');
        process.stdout.write(c.dim('  Sign in with your Burtson Labs account (browser OAuth).') + '\n');
        process.stdout.write(c.dim('  Or paste an existing key: type ') + c.cyan('paste') + c.dim(' / ') + c.cyan('Enter') + c.dim(' to start OAuth: '));
        const sub = (await ask()).trim().toLowerCase();
        if (sub === 'paste') {
          process.stdout.write(c.dim('  Paste your key (starts with ') + c.cyan('bai_') + c.dim('): '));
          const key = (await ask()).trim().replace(/^['"]|['"]$/g, '');
          if (key.length < 16) {
            return c.red(`That doesn't look like a Bandit Cloud key (got ${key.length} chars). Cancelled.`);
          }
          const file = await saveApiKey(key);
          ctx.setProvider?.('bandit');
          return [
            '',
            c.green('✓ saved') + c.dim(' to ') + c.cyan(file),
            c.dim('  provider: ') + c.cyan('bandit'),
            c.dim('  Use /usage to verify the key works.')
          ].join('\n');
        }
        // OAuth path — reuse the existing /login flow.
        try {
          const { runOAuthSignIn } = await import('./auth/oauthFlow');
          process.stdout.write(c.dim('  Opening browser for sign-in… (waiting up to 5 minutes)\n'));
          const result = await runOAuthSignIn({}, (line) => process.stdout.write(c.dim('  ' + line) + '\n'));
          const file = await saveApiKey(result.apiKey);
          ctx.setProvider?.('bandit');
          const greeting = result.name ? `Signed in as ${c.accent(result.name)}.` : 'Signed in.';
          const lines = [
            '',
            c.green(`✓ ${greeting}`),
            c.dim('  device key saved to ') + c.cyan(file),
            c.dim('  provider switched to ') + c.cyan('bandit')
          ];
          if (result.email) lines.splice(2, 0, c.dim('  account: ') + c.cyan(result.email));
          return lines.join('\n');
        } catch (err) {
          return c.red(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── OpenAI-compatible ──
      if (choice === '3' || choice.toLowerCase().startsWith('openai')) {
        process.stdout.write('\n' + c.bold('Pick an OpenAI-compatible upstream') + '\n\n');
        OPENAI_PRESETS.forEach((p, i) => {
          const num = c.cyan(String(i + 1).padStart(2, ' '));
          const url = p.baseUrl ? c.dim(' — ' + p.baseUrl) : '';
          process.stdout.write(`  ${num} ${p.label}${url}\n`);
        });
        process.stdout.write(c.dim(`\nChoice [1-${OPENAI_PRESETS.length}, Enter to cancel] `));
        const presetIdxRaw = (await ask()).trim();
        if (!presetIdxRaw) return c.dim('↷ /connect cancelled.');
        const presetIdx = parseInt(presetIdxRaw, 10) - 1;
        if (!Number.isFinite(presetIdx) || presetIdx < 0 || presetIdx >= OPENAI_PRESETS.length) {
          return c.red(`Invalid choice "${presetIdxRaw}". Cancelled.`);
        }
        const preset = OPENAI_PRESETS[presetIdx];
        if (preset.hint) {
          process.stdout.write('\n' + c.dim(preset.hint) + '\n');
        }

        // Base URL — pre-fill from preset, let user override.
        const defaultUrl = preset.baseUrl;
        process.stdout.write('\n' + c.bold('Base URL') + '\n');
        if (defaultUrl) {
          process.stdout.write(c.dim(`  default: ${defaultUrl}`) + '\n');
          process.stdout.write(c.dim('  Press Enter to keep, or paste a different URL: '));
        } else {
          process.stdout.write(c.dim('  Paste your endpoint base URL (e.g. http://localhost:1234/v1): '));
        }
        const urlInput = (await ask()).trim();
        const baseUrl = urlInput || defaultUrl;
        if (!baseUrl) {
          return c.red('A base URL is required. Cancelled.');
        }

        // Model id — pre-fill with sample, let user override.
        process.stdout.write('\n' + c.bold('Model id') + '\n');
        if (preset.sampleModel) {
          process.stdout.write(c.dim(`  suggested: ${preset.sampleModel}`) + '\n');
          process.stdout.write(c.dim('  Press Enter to use the suggestion, or type a different id: '));
        } else {
          process.stdout.write(c.dim('  Type the model id your endpoint expects: '));
        }
        const modelInput = (await ask()).trim();
        const model = modelInput || preset.sampleModel;
        if (!model) {
          return c.red('A model id is required. Cancelled.');
        }

        // API key — only prompt when the preset says it's needed. Local
        // servers (LM Studio, llama.cpp) usually don't.
        let apiKey: string | undefined;
        if (preset.requiresApiKey) {
          process.stdout.write('\n' + c.bold('API key') + '\n');
          if (preset.docsUrl) {
            process.stdout.write(c.dim('  Get a key at ') + linkify(preset.docsUrl) + '\n');
          }
          process.stdout.write(c.dim('  Paste your key (or Enter to skip and add later via config): '));
          const keyInput = (await ask()).trim();
          if (keyInput) apiKey = keyInput;
        }

        try {
          await saveOpenaiConfig({ baseUrl, model, ...(apiKey ? { apiKey } : {}) });
          await saveProvider('openai-compatible', model);
          ctx.setProvider?.('openai-compatible');
          ctx.model.set(model);
          return [
            '',
            c.green('✓ saved') + c.dim(' to ') + c.cyan(globalConfigPath()),
            c.dim('  provider: ') + c.cyan('openai-compatible'),
            c.dim('  endpoint: ') + c.cyan(baseUrl),
            c.dim('  model:    ') + c.cyan(model),
            apiKey ? c.dim('  api key:  ') + c.green('on file') : c.dim('  api key:  ') + c.yellow('not set — add to config.json or set OPENAI_API_KEY'),
            '',
            c.dim('Restart bandit if your next request still hits the previous provider.')
          ].join('\n');
        } catch (err) {
          return c.red(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return c.red(`Unknown choice "${choice}". Use 1, 2, or 3.`);
    }
  },
  {
    name: 'provider',
    description: 'Show or switch the active provider — /provider (status), /provider ollama, /provider bandit, /provider openai-compatible',
    async run(args, ctx) {
      const arg = args.trim().toLowerCase();
      const cfg = ctx.getConfig();
      // No-arg: status + how-to-switch hint. Print loud + actionable —
      // the user landed here because they want to flip something.
      if (!arg) {
        const lines = [
          c.bold('Active provider: ') + c.accent(cfg.provider),
          `  model:        ${c.cyan(cfg.model)}`,
          cfg.provider === 'ollama'
            ? `  endpoint:     ${c.cyan(cfg.ollamaUrl)}`
            : cfg.provider === 'openai-compatible'
              ? `  endpoint:     ${c.cyan(cfg.openaiBaseUrl ?? c.red('not set'))}`
              : `  api key:      ${cfg.apiKey ? c.green('on file') : c.red('NOT set — run /login <key>')}`,
          '',
          c.bold('Switch:'),
          `  ${c.cyan('/provider ollama')}            local Ollama on ${c.dim(cfg.ollamaUrl ?? 'http://localhost:11434')}`,
          `  ${c.cyan('/provider bandit')}            Bandit Cloud (requires /login first)`,
          `  ${c.cyan('/provider openai-compatible')}  any OpenAI-compatible endpoint (LM Studio, llama.cpp, vLLM, OpenRouter, Together, Groq, OpenAI, …)`,
          '',
          c.dim('After switching, /model will list options for the new provider.')
        ];
        return lines.join('\n');
      }
      if (arg !== 'ollama' && arg !== 'bandit' && arg !== 'openai-compatible') {
        return c.red(`Unknown provider "${arg}". Use ${c.cyan('ollama')}, ${c.cyan('bandit')}, or ${c.cyan('openai-compatible')}.`);
      }
      if (!ctx.setProvider) {
        return c.dim('Provider switching is not available in this host.');
      }
      // Bandit Cloud requires a key — refuse the switch with a clear
      // path forward instead of silently flipping into a state where
      // the next prompt 401s.
      if (arg === 'bandit' && !cfg.apiKey) {
        return [
          c.red('No Bandit Cloud API key on file.'),
          c.dim('Run ') + c.cyan('/login <key>') + c.dim(' first, then ') + c.cyan('/provider bandit') + c.dim('.'),
          c.dim('Get a key at ') + linkify('https://burtson.ai') + c.dim('.')
        ].join('\n');
      }
      // openai-compatible needs a base URL and a model id — refuse the
      // switch when either is missing so the next prompt doesn't fail
      // with a confusing fetch error.
      if (arg === 'openai-compatible' && (!cfg.openaiBaseUrl || !cfg.openaiModel)) {
        const missing: string[] = [];
        if (!cfg.openaiBaseUrl) missing.push('openai.baseUrl (or OPENAI_BASE_URL / --openai-base-url)');
        if (!cfg.openaiModel) missing.push('openai.model (or OPENAI_MODEL / --openai-model)');
        return [
          c.red(`Cannot switch to openai-compatible — missing: ${missing.join(', ')}.`),
          c.dim('Set in ~/.bandit/config.json:'),
          c.dim('  { "openai": { "baseUrl": "http://localhost:1234/v1", "model": "your-model-id", "apiKey": "..." } }'),
          c.dim('Or pass at launch: ') + c.cyan('bandit --provider openai-compatible --openai-base-url http://localhost:1234/v1 --openai-model my-model'),
          c.dim('Local servers (LM Studio, llama.cpp) usually skip the api key.')
        ].join('\n');
      }
      ctx.setProvider(arg);
      // Persist to global config so the choice survives the next launch.
      try { await saveProvider(arg, ctx.model.current); } catch { /* best effort */ }
      const next = ctx.getConfig();
      const lines = [
        c.green('✓ provider switched to ') + c.accent(arg),
        c.dim('  model: ') + c.cyan(next.model),
        c.dim('  saved to ') + c.cyan(globalConfigPath()),
        ''
      ];
      if (arg === 'ollama') {
        lines.push(c.dim('Run ') + c.cyan('/model') + c.dim(' to see installed Ollama models and switch to one.'));
      }
      return lines.join('\n');
    }
  },
  {
    name: 'remember',
    description: 'Persist a fact to project memory (BANDIT.md) so it survives across sessions — /remember <fact>',
    async run(args, ctx) {
      const fact = args.trim();
      if (!fact) {
        return [
          c.bold('Usage: ') + c.cyan('/remember <fact>'),
          '',
          c.dim('Appends a bullet to the "## Notes" heading in BANDIT.md at the workspace root.'),
          c.dim('The next Bandit session in this workspace auto-loads it.'),
          '',
          c.bold('Examples:'),
          c.dim('  /remember All my repos live in ~/Documents/GitHub'),
          c.dim('  /remember Local Ollama runs at http://localhost:11434'),
          c.dim('  /remember Prefer pnpm over npm in this monorepo')
        ].join('\n');
      }
      try {
        const { appendMemory } = await import('@burtson-labs/host-kit');
        const abs = await appendMemory(ctx.cwd, fact);
        // Refresh in-memory project memory so the rest of THIS session
        // also sees the new bullet without restarting.
        await ctx.reloadMemory();
        return [
          c.green('✓ Saved to project memory: ') + c.accent(`"${fact}"`),
          c.dim('  Persisted to ') + c.cyan(abs),
          c.dim('  Loaded into the current session and auto-loaded on every future run in this workspace.')
        ].join('\n');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.red(`Could not save to memory: ${msg}`);
      }
    }
  },
  {
    name: 'ollama',
    description: 'Show or set the Ollama endpoint — /ollama (status), /ollama default, /ollama <url>',
    async run(args, ctx) {
      const arg = args.trim();
      const cfg = ctx.getConfig();
      // No-arg → status + how-to-change.
      if (!arg) {
        return [
          c.bold('Ollama endpoint: ') + c.cyan(cfg.ollamaUrl ?? 'http://localhost:11434'),
          '',
          c.bold('Change:'),
          `  ${c.cyan('/ollama default')}            reset to http://localhost:11434`,
          `  ${c.cyan('/ollama <url>')}              set explicitly (e.g. /ollama https://ollama.example.com)`,
          '',
          c.dim('Saves to ') + c.cyan(globalConfigPath()) + c.dim(' so the choice survives the next launch.')
        ].join('\n');
      }
      if (!ctx.setOllamaUrl) {
        return c.dim('Ollama URL switching is not available in this host.');
      }
      const isReset = /^(default|reset|local|localhost)$/i.test(arg);
      const url = isReset ? '' : arg;
      // Light validation — flag obvious typos before they fail at request time.
      if (url && !/^https?:\/\//i.test(url)) {
        return c.red(`"${arg}" doesn't look like a URL. Expected http:// or https:// (got "${arg}").`);
      }
      ctx.setOllamaUrl(url);
      try { await saveOllamaUrl(url); } catch { /* best effort */ }
      const effective = url || 'http://localhost:11434';
      return [
        c.green('✓ Ollama endpoint set to ') + c.accent(effective),
        c.dim('  saved to ') + c.cyan(globalConfigPath()),
        ctx.providerKind === 'ollama'
          ? c.dim('Run ') + c.cyan('/model') + c.dim(' to see what is installed at the new endpoint.')
          : c.dim('Switch with ') + c.cyan('/provider ollama') + c.dim(' to use it.')
      ].join('\n');
    }
  },
  {
    name: 'model',
    description: 'List installed Ollama models, show or switch the active model (/model or /model gpt-oss:20b)',
    async run(args, ctx) {
      const next = args.trim();
      // Explicit switch: take the argument at face value, no lookup.
      if (next) {
        ctx.model.set(next);
        return `${glyph.check} model switched to ${c.accent(next)}`;
      }
      // No-arg: show current + list installed (Ollama path only — the
      // hosted Bandit provider doesn't expose a model catalog).
      const header = `${c.bold('Current model:')} ${c.accent(ctx.model.current)}`;
      if (ctx.providerKind !== 'ollama') {
        return [
          header,
          c.dim('(Hosted Bandit provider — set the model with /model <name>)')
        ].join('\n');
      }
      const installed = await listInstalledOllamaModels(ctx.ollamaUrl, { chatOnly: true });
      if (installed.length === 0) {
        return [
          header,
          c.dim(`No chat-capable models found at ${ctx.ollamaUrl}.`),
          c.dim(`Is Ollama running? Try ${c.cyan('ollama serve')}, then ${c.cyan('ollama pull gemma3:12b-it-qat')}.`)
        ].join('\n');
      }
      const ranked = suggestOllamaMatch(ctx.model.current, installed.map((m) => m.name));
      const ranking = new Map<string, number>(ranked.map((name, idx) => [name, idx]));
      const sorted = [...installed].sort((a, b) => {
        const ai = ranking.has(a.name) ? ranking.get(a.name)! : Number.POSITIVE_INFINITY;
        const bi = ranking.has(b.name) ? ranking.get(b.name)! : Number.POSITIVE_INFINITY;
        if (ai !== bi) return ai - bi;
        return a.name.localeCompare(b.name);
      });
      const formatSize = (bytes?: number): string => {
        if (!bytes || bytes <= 0) return '';
        const gb = bytes / (1024 ** 3);
        if (gb >= 1) return `${gb.toFixed(1)} GB`;
        const mb = bytes / (1024 ** 2);
        return `${mb.toFixed(0)} MB`;
      };
      const maxNameLen = Math.max(...sorted.map((m) => m.name.length), 20);
      const rows = sorted.map((m) => {
        const marker = m.name === ctx.model.current ? c.accent(glyph.check) : ' ';
        const size = formatSize(m.size);
        return `  ${marker} ${c.cyan(m.name.padEnd(maxNameLen))}  ${c.dim(size)}`.trimEnd();
      });
      return [
        header,
        '',
        c.bold(`Installed (${sorted.length}) — ranked by match to current model:`),
        ...rows,
        '',
        c.dim(`Switch with ${c.cyan('/model <name>')} — exact tag required (e.g. /model gemma3:12b-it-qat).`)
      ].join('\n');
    }
  },
  {
    name: 'skills',
    description: 'List loaded skills (built-in + workspace)',
    run(_args, ctx) {
      const skills = ctx.skillRegistry.getAll();
      if (skills.length === 0) return c.dim('(no skills loaded)');
      return skills
        .map(s => `  ${c.cyan(s.id.padEnd(24))} ${c.dim('v' + s.version)} ${s.description}`)
        .join('\n');
    }
  },
  {
    name: 'skill',
    description: 'Scaffold a new markdown skill (/skill new <name>)',
    // Skill scaffolding lives in a slash command rather than an agent tool
    // on purpose: the model is the worst party to trust with writing a
    // skill's YAML frontmatter — escaping slip-ups in a template the model
    // later has to read are compounding failures. Letting the user trigger
    // the scaffold directly gives a predictably-valid starting point that
    // the model can then edit with small, safe diffs.
    async run(args, ctx) {
      const [sub, ...rest] = args.trim().split(/\s+/);
      if (sub !== 'new') {
        return [
          c.bold('Skill scaffolding'),
          '  ' + c.cyan('/skill new <name>') + c.dim('   create .bandit/skills/<name>.md with a working template'),
          '',
          c.dim('Tips:'),
          c.dim('  • names become the skill id — keep them short, kebab-cased'),
          c.dim('  • the body of the markdown file is what the agent reads, so write playbook prose'),
          c.dim('  • edit `triggers` to add keywords that should auto-activate the skill')
        ].join('\n');
      }

      const rawName = rest.join(' ').trim();
      if (!rawName) return c.red('usage: /skill new <name>');

      // Normalize: lowercase, strip unsafe chars, kebab-case. Skills live
      // on disk — we don't want "Weird / Skill Name.md" landing there.
      const safe = rawName
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (!safe) return c.red('name must contain at least one letter or digit');

      const skillsDir = path.join(ctx.cwd, '.bandit', 'skills');
      const target = path.join(skillsDir, `${safe}.md`);
      if (fs.existsSync(target)) {
        return c.red(`skill already exists: .bandit/skills/${safe}.md`);
      }

      try {
        await fs.promises.mkdir(skillsDir, { recursive: true });
        await fs.promises.writeFile(target, scaffoldMarkdownSkill(safe, rawName), 'utf8');
      } catch (err) {
        return c.red(`could not create skill: ${err instanceof Error ? err.message : String(err)}`);
      }

      return [
        `${glyph.check} created ${c.accent('.bandit/skills/' + safe + '.md')}`,
        '',
        c.dim('Next:'),
        c.dim(`  • open it in your editor and fill in the description + playbook`),
        c.dim(`  • adjust the \`triggers\` list so the skill auto-activates on the right prompts`),
        c.dim(`  • the skill is picked up on the next REPL start (or run /session new to reload)`)
      ].join('\n');
    }
  },
  {
    name: 'session',
    description: 'List/save/resume sessions (/session list | /session resume <id>)',
    async run(args, ctx) {
      const [sub, ...rest] = args.trim().split(/\s+/);
      if (!sub || sub === 'list') {
        const ids = await ctx.session.list();
        if (ids.length === 0) return c.dim('(no saved sessions)');
        return ids.map(id => {
          const active = id === ctx.session.currentId ? c.accent(' (active)') : '';
          return `  ${c.cyan(id)}${active}`;
        }).join('\n');
      }
      if (sub === 'resume') {
        const id = rest[0];
        if (!id) return c.red('usage: /session resume <id>');
        const ok = await ctx.session.resume(id);
        return ok
          ? `${glyph.check} resumed session ${c.accent(id)} (${(await ctx.session.readConversation()).length} messages)`
          : c.red(`session "${id}" not found`);
      }
      if (sub === 'new') {
        await ctx.session.startNew();
        return `${glyph.check} started new session ${c.accent(ctx.session.currentId ?? '')}`;
      }
      return c.red(`unknown subcommand: ${sub}`);
    }
  },
  {
    name: 'trace',
    description: 'Inspect turn traces from workspace/global .bandit/turns (/trace, /trace list, /trace failed, /trace <id>). Shows tools, retries, fallbacks, errors, and final response.',
    async run(args, ctx) {
      const arg = args.trim();
      if (!arg || arg === 'last') {
        const [trace] = await listTurnTraces(ctx.cwd, { limit: 1, includeGlobal: true });
        if (!trace) return c.dim('No turn traces found in workspace/global .bandit/turns yet.');
        return formatTurnTraceMarkdown(trace);
      }
      if (arg === 'list' || arg === 'ls' || arg === 'all' || arg === 'failed') {
        const traces = await listTurnTraces(ctx.cwd, {
          limit: arg === 'failed' ? 40 : 16,
          includeGlobal: true,
          status: arg === 'failed' ? ['failed', 'blocked', 'cancelled'] : undefined
        });
        if (traces.length === 0) return c.dim('No matching turn traces found in workspace/global .bandit/turns yet.');
        const rows = traces.map((trace) => {
          const s = trace.summary;
          const status = s.status === 'completed'
            ? c.green(s.status)
            : s.status === 'failed'
            ? c.red(s.status)
            : s.status === 'blocked'
            ? c.yellow(s.status)
            : c.dim(s.status);
          const prompt = (s.prompt ?? '').replace(/\s+/g, ' ');
          const shortPrompt = prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt;
          const recovery = s.nativeFallbacks > 0 || s.retries > 0
            ? c.dim(` · retry ${s.retries} · fallback ${s.nativeFallbacks}`)
            : '';
          const source = `${s.scope}${s.workspace ? ` · ${shortHomePath(s.workspace)}` : ''}`;
          const started = s.startedAt ? s.startedAt.slice(0, 19).replace('T', ' ') : 'unknown';
          return `  ${c.cyan(s.id)}  ${status}  ${c.dim(`${s.toolCalls} tools${recovery}`)}  ${c.dim(source)}\n    ${c.dim(started)}  ${c.dim(shortPrompt || '(no prompt logged)')}`;
        });
        return [
          c.bold(arg === 'failed' ? 'Failed/blocked turn traces' : 'Recent turn traces'),
          ...rows,
          '',
          c.dim('Use /trace <id> to inspect a full timeline. Use /trace failed for recovery/debugging runs.')
        ].join('\n');
      }
      const trace = await readTurnTraceById(ctx.cwd, arg, { includeGlobal: true });
      if (!trace) return c.red(`Trace not found: ${arg}`);
      return formatTurnTraceMarkdown(trace);
    }
  },
  {
    name: 'memory',
    description: 'Show loaded memory, or /memory migrate [apply] to lift BANDIT.md sections into MEMORY.md + memory/ topic files',
    async run(args, ctx) {
      const arg = args.trim().toLowerCase();
      // `/memory migrate` — kick off the PLAN step. Agent reads existing
      // memory files, drafts topic splits + a fresh BANDIT.md, writes
      // everything to .bandit/migration-preview/ along with plan.json.
      // The user then runs `/memory migrate apply` to launch the wizard
      // that walks them through accept/edit/skip per file.
      if (arg === 'migrate' || arg === 'migrate plan') {
        if (!ctx.queuePrompt) {
          return c.dim('(/memory migrate must run inside the REPL — not available in one-shot mode)');
        }
        const prompt = [
          'Plan a migration of this workspace\'s memory files into the BANDIT.md (Behavior + Project facts) + MEMORY.md (lazy-load topic index) shape.',
          '',
          'Steps:',
          '1. Run `list_files .` and `read_file` on every file that loadMemory considers: BANDIT.md, CLAUDE.md, AGENTS.md, .bandit/BANDIT.md, .bandit/memory.md, AND the existing MEMORY.md if present.',
          '2. Identify which H2/H3 sections of the existing memory are TOPIC-shaped (situational — "when editing auth code", "when shipping a release", "when working on the CLI ink layer") vs BEHAVIOR-shaped (always-applies rules like "read the file first" or "match existing style"). Behavior stays in BANDIT.md; topics move into memory/<slug>.md.',
          '3. Make sure the staging directory exists and is clean:',
          '   - `run_command(cmd="rm", args="-rf .bandit/migration-preview", cwd=".")` (best-effort)',
          '   - `run_command(cmd="mkdir", args="-p .bandit/migration-preview/memory", cwd=".")`',
          '4. For each topic you identified, write the topic content to `.bandit/migration-preview/memory/<slug>.md` via `write_file`. Pick slugs that are short, lowercase, and hyphenated. Each topic file should start with `# <Topic title>` and contain ONLY the content for that topic.',
          '5. Write `.bandit/migration-preview/MEMORY.md` — the new lazy-load index. Shape:',
          '',
          '   ```markdown',
          '   # <project> memory — topic index',
          '',
          '   This file is an INDEX of lazy-loaded topic memories under `memory/`. Each entry has a one-line hook that tells the agent WHEN that topic is relevant. The agent reads this index every turn but does NOT preload the linked files — it calls `read_memory(name="<slug>")` on demand when a hook matches.',
          '',
          '   - [<Title>](memory/<slug>.md) — <one-line hook starting with "when ...">',
          '   ```',
          '',
          '6. Write `.bandit/migration-preview/BANDIT.md` — the fresh Karpathy-shape replacement. If `~/.bandit/bandit-template.md` exists, use it verbatim as the skeleton and fold in any user-specific behavior bullets you found in the existing BANDIT.md. Otherwise use this shape:',
          '',
          '   ```markdown',
          '   # <project> — project memory',
          '',
          '   ## Behavior',
          '   ### Before editing',
          '   - <rules>',
          '   ### When changing code',
          '   - <rules>',
          '   ### When finishing a task',
          '   - <rules>',
          '   ### Communication',
          '   - <rules>',
          '',
          '   ## Project facts',
          '   ### Repo layout',
          '   - <facts>',
          '   ### Defaults',
          '   - <facts>',
          '   ### Conventions',
          '   - <facts>',
          '   ```',
          '',
          '7. Write `.bandit/migration-preview/plan.json` — the manifest the wizard reads. Shape (this is JSON, validate it):',
          '',
          '   ```json',
          '   {',
          '     "version": 1,',
          '     "generatedAt": "<ISO timestamp>",',
          '     "sourceFiles": ["BANDIT.md", "CLAUDE.md"],',
          '     "entries": [',
          '       { "kind": "topic", "stagingPath": "memory/<slug>.md", "targetPath": "memory/<slug>.md", "title": "<Title>", "hook": "<one-line hook>", "lines": <count> },',
          '       { "kind": "index", "stagingPath": "MEMORY.md", "targetPath": "MEMORY.md", "title": "Topic index", "lines": <count> },',
          '       { "kind": "bandit", "stagingPath": "BANDIT.md", "targetPath": "BANDIT.md", "title": "Project memory (replacement)", "lines": <count> }',
          '     ]',
          '   }',
          '   ```',
          '',
          '   Topic entries come first, then index, then bandit-replacement last — the wizard\'s "REPLACE" warning fires on the bandit entry and we want that to be the user\'s final choice.',
          '',
          '8. Report back ONE short paragraph: how many topic files you drafted, what the source files were, and the literal next command — `/memory migrate apply` — so the user can launch the wizard.',
          '',
          'Constraints:',
          '- DO NOT modify any file in the workspace root during this turn. Everything lands in `.bandit/migration-preview/`.',
          '- If no memory files exist (BANDIT.md, CLAUDE.md, AGENTS.md, etc. all absent), say so and recommend `/init` to scaffold from scratch instead.',
          '- Hooks must start with "when " — they\'re relevance triggers, not summaries.'
        ].join('\n');
        ctx.queuePrompt(prompt);
        return c.dim(`${glyph.spark} planning migration — proposals will land in .bandit/migration-preview/`);
      }
      if (arg === 'migrate apply') {
        if (!ctx.runMemoryMigrateWizard) {
          return c.dim('(/memory migrate apply needs the CLI host — in the IDE, open an integrated terminal and run `bandit /memory migrate apply` there)');
        }
        await ctx.runMemoryMigrateWizard();
        return '';
      }
      // Default — show what was loaded.
      const content = await ctx.reloadMemory();
      if (!content) return c.dim('(no memory files found — create BANDIT.md or CLAUDE.md to seed context, or run /init)');
      // Redact before display — if a user has accidentally pasted a
      // config snippet or API key into BANDIT.md / CLAUDE.md, the
      // `/memory` preview would otherwise echo it in plaintext to the
      // terminal AND scrollback. (2026-05-26 wiring audit.)
      const safe = redactSecretsString(content);
      const preview = safe.split('\n').slice(0, 20).join('\n');
      const more = safe.split('\n').length > 20 ? c.dim(`\n… (${safe.split('\n').length - 20} more lines)`) : '';
      return c.dim(preview) + more;
    }
  },
  {
    name: 'about',
    description: 'Who Bandit is and what it can do (no LLM call — canned identity card)',
    run(_args, ctx) {
      const cfg = ctx.getConfig();
      const lines = [
        c.bold('Bandit') + c.dim('  —  local-first terminal coding agent'),
        c.dim('built by ') + c.accent('Burtson Labs') + c.dim('  ·  part of the Bandit Agent Framework'),
        '',
        c.bold('Siblings:'),
        '  ' + c.dim('Bandit Stealth') + ' — the VS Code / Cursor extension',
        '  ' + c.dim('@burtson-labs/host-kit') + ' — shared memory, hooks, permissions, and extra tools',
        '',
        c.bold('Capabilities:'),
        '  ' + c.cyan('tools     ') + c.dim('read, write, search, run_command, git_*, web_fetch, todo_write, task'),
        '  ' + c.cyan('skills    ') + c.dim('auto-activate from .bandit/skills/*.json based on your prompt'),
        '  ' + c.cyan('memory    ') + c.dim('auto-loads BANDIT.md / CLAUDE.md from the workspace'),
        '  ' + c.cyan('hooks     ') + c.dim('PreToolUse / PostToolUse / Stop shell scripts from .bandit/settings.json'),
        '  ' + c.cyan('sessions  ') + c.dim('persisted to ~/.bandit/sessions/, resumable with --resume <id>'),
        '  ' + c.cyan('subagents ') + c.dim('the task tool spawns a focused subagent with its own context'),
        '',
        c.bold('Current session:'),
        '  ' + c.dim('provider  ') + cfg.provider,
        '  ' + c.dim('model     ') + c.accent(cfg.model),
        '  ' + c.dim('endpoint  ') + (cfg.provider === 'ollama' ? cfg.ollamaUrl : (cfg.apiUrl ?? '(default)')),
        '',
        c.dim('Docs: ') + linkify('https://burtson.ai/stealth')
      ];
      return lines.join('\n');
    }
  },
  {
    name: 'profile',
    description: 'Show the active model behavior profile — protocol, fallback, context budget, prompting, and known failure modes',
    run(args, ctx) {
      const modelId = args.trim() || ctx.model.current;
      const profile = getModelBehaviorProfile(modelId);
      return [
        c.bold('Model behavior profile'),
        `  ${c.dim('model')}       ${c.cyan(modelId)}`,
        `  ${c.dim('profile')}     ${profile.label} (${profile.id})`,
        `  ${c.dim('protocol')}    ${profile.protocol.preferred}${profile.protocol.fallback ? ` → ${profile.protocol.fallback}` : ''} (${profile.protocol.envelope})`,
        `  ${c.dim('fallback')}    ${profile.protocol.nativeToolFailureFallback ? 'native failures degrade to text tools' : 'no native fallback needed'}`,
        `  ${c.dim('context')}     safe input ${profile.context.safeInputTokens} tok · output ${profile.context.outputBudgetTokens} tok · compaction ${profile.context.compaction}`,
        `  ${c.dim('prompting')}   ${profile.prompting.template} · examples ${profile.prompting.examples} · thinking ${profile.prompting.thinking}`,
        `  ${c.dim('parallelism')} ${profile.reliability.maxParallelTools} tool${profile.reliability.maxParallelTools === 1 ? '' : 's'} max`,
        '',
        c.bold('Known failure modes'),
        ...profile.reliability.knownFailureModes.map((mode) => `  ${c.dim('•')} ${mode}`),
        '',
        c.dim('Workspace overrides load from .bandit/model-profiles.json at startup.')
      ].join('\n');
    }
  },
  {
    name: 'config',
    description: 'Show the effective CLI config + the path to the file (provider, model, endpoint, headers — secrets redacted)',
    run(_args, ctx) {
      const cfg = ctx.getConfig();
      const lines = [
        c.bold('Effective config:'),
        describeConfig(cfg),
        '',
        c.dim('config file: ') + c.cyan(globalConfigPath()),
        c.dim('  (workspace overrides: .bandit/config.json, .bandit/config.local.json)')
      ];
      const extras: string[] = [];
      if (cfg.provider === 'bandit' && !cfg.apiKey) {
        extras.push('', c.red('No API key set.') + c.dim(' Run ') + c.cyan('/login <key>') + c.dim(' to save one.'));
      }
      return [...lines, ...extras].join('\n');
    }
  },
  {
    name: 'doctor',
    description: 'Check setup, workspace context, permissions, provider state, and next best actions',
    async run(_args, ctx) {
      const cfg = ctx.getConfig();
      const checks: Array<{ label: string; ok: boolean; detail: string; fix?: string }> = [];
      const cwd = path.resolve(ctx.cwd);
      const home = path.resolve(process.env.HOME ?? cwd);
      const isHome = cwd === home;
      const hasGit = (() => {
        try {
          cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: 'ignore', timeout: 1000 });
          return true;
        } catch { return false; }
      })();
      const gitBranch = (() => {
        try {
          return cp.execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 1000 }).trim();
        } catch { return ''; }
      })();
      const dirtyCount = (() => {
        try {
          const out = cp.execFileSync('git', ['status', '--short'], { cwd, encoding: 'utf-8', timeout: 1500 });
          return out.split('\n').filter(Boolean).length;
        } catch { return 0; }
      })();
      const memoryFiles = ['BANDIT.md', 'CLAUDE.md', path.join('.bandit', 'BANDIT.md'), path.join('.bandit', 'CLAUDE.md')]
        .filter((p) => fs.existsSync(path.join(cwd, p)));
      const settingsPath = path.join(cwd, '.bandit', 'settings.json');
      const skillsDir = path.join(cwd, '.bandit', 'skills');
      const skillCount = (() => {
        try { return fs.readdirSync(skillsDir).filter((f) => f.endsWith('.md') || f.endsWith('.json')).length; }
        catch { return 0; }
      })();

      checks.push({
        label: 'Workspace',
        ok: !isHome,
        detail: isHome ? 'Bandit is running from your home directory.' : cwd,
        fix: isHome ? 'cd into a project repo before starting Bandit.' : undefined
      });
      checks.push({
        label: 'Git repo',
        ok: hasGit,
        detail: hasGit ? `${gitBranch || 'detached'}${dirtyCount > 0 ? ` · ${dirtyCount} changed file${dirtyCount === 1 ? '' : 's'}` : ' · clean'}` : 'No git repository detected.',
        fix: hasGit && dirtyCount > 0 ? 'Run /review to inspect changes, then /test or /commit.' : !hasGit ? 'Open Bandit from a repository root.' : undefined
      });
      checks.push({
        label: 'Project memory',
        ok: memoryFiles.length > 0,
        detail: memoryFiles.length > 0 ? memoryFiles.join(', ') : 'No BANDIT.md or CLAUDE.md found.',
        fix: memoryFiles.length === 0 ? 'Run /init so future turns know build/test/project conventions.' : undefined
      });
      checks.push({
        label: 'Permissions',
        ok: fs.existsSync(settingsPath) || !/^(1|true)$/i.test(process.env.BANDIT_AUTO_APPROVE ?? ''),
        detail: /^(1|true)$/i.test(process.env.BANDIT_AUTO_APPROVE ?? '')
          ? 'BANDIT_AUTO_APPROVE is enabled.'
          : fs.existsSync(settingsPath) ? '.bandit/settings.json present.' : 'Interactive approval gate is active.',
        fix: /^(1|true)$/i.test(process.env.BANDIT_AUTO_APPROVE ?? '') ? 'Unset BANDIT_AUTO_APPROVE for normal interactive use.' : 'Run /help permissions to see approval choices.'
      });
      checks.push({
        label: 'Skills',
        ok: skillCount > 0,
        detail: skillCount > 0 ? `${skillCount} workspace skill${skillCount === 1 ? '' : 's'} found.` : 'No workspace skills found.',
        fix: skillCount === 0 ? 'Run /skill new <name> when you notice repeated workflows.' : undefined
      });

      if (ctx.providerKind === 'ollama') {
        const installed = await listInstalledOllamaModels(ctx.ollamaUrl).catch(() => []);
        checks.push({
          label: 'Provider',
          ok: installed.length > 0,
          detail: installed.length > 0
            ? `Ollama at ${ctx.ollamaUrl} · ${installed.length} model${installed.length === 1 ? '' : 's'} visible · active ${ctx.model.current}`
            : `Ollama provider selected, but no models were discovered at ${ctx.ollamaUrl}.`,
          fix: installed.length === 0 ? 'Start Ollama, run ollama pull qwen3.6:27b or gemma4:26b, then /model.' : undefined
        });
      } else if (ctx.providerKind === 'bandit') {
        checks.push({
          label: 'Provider',
          ok: !!cfg.apiKey,
          detail: cfg.apiKey ? `Bandit Cloud · active ${ctx.model.current}` : 'Bandit Cloud selected without an API key.',
          fix: cfg.apiKey ? undefined : 'Run /login <key> or /connect.'
        });
      } else {
        checks.push({
          label: 'Provider',
          ok: !!cfg.openaiBaseUrl,
          detail: cfg.openaiBaseUrl ? `OpenAI-compatible · ${cfg.openaiBaseUrl} · active ${ctx.model.current}` : 'OpenAI-compatible provider missing a base URL.',
          fix: cfg.openaiBaseUrl ? undefined : 'Run /connect and pick an OpenAI-compatible preset.'
        });
      }

      const lines: string[] = [c.bold('Bandit doctor'), ''];
      for (const check of checks) {
        const mark = check.ok ? c.green(glyph.check) : c.yellow(glyph.warn);
        lines.push(`  ${mark} ${c.bold(check.label.padEnd(15))} ${check.detail}`);
        if (check.fix) lines.push(`    ${c.dim('next:')} ${check.fix}`);
      }

      const next: string[] = [];
      if (isHome) next.push('cd into a repo and restart Bandit');
      if (memoryFiles.length === 0) next.push('/init');
      if (dirtyCount > 0) next.push('/review');
      if (ctx.providerKind === 'bandit' && !cfg.apiKey) next.push('/login <key>');
      if (next.length === 0) {
        next.push('/plan <goal>', '/test', '/insights --text');
      }
      lines.push('');
      lines.push(c.bold('Next best actions'));
      lines.push('  ' + next.map((n) => c.cyan(n)).join(c.dim('  →  ')));
      return lines.join('\n');
    }
  },
  {
    name: 'insights',
    description: 'Show how you use Bandit. Default: write an HTML report and open it in your browser. Pass --text for a quick CLI-only summary, or --no-ai to skip the LLM-generated summary section.',
    async run(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const noAi = tokens.includes('--no-ai');
      const textOnly = tokens.includes('--text') || tokens.includes('-t');
      const out = tokens.find((t) => !t.startsWith('--') && !t.startsWith('-'));
      try {
        // Lazy require so the slash-command module doesn't pull insights
        // into every smoke-test build that doesn't need it.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const hostKit = require('@burtson-labs/host-kit') as typeof import('@burtson-labs/host-kit');
        const { writeInsightsReport, computeInsights } = hostKit;
        type AiSummaryFn = Parameters<typeof writeInsightsReport>[0]['ai'];

        // Decide whether to ask the model for a summary. Off if the
        // user passed --no-ai, the host doesn't expose a oneShotChat,
        // or the user explicitly denied consent. For Bandit cloud,
        // prompt once and persist the answer. For local Ollama,
        // skip the consent step — payload never leaves the machine.
        // Shared between --text and --html paths so both surfaces ask
        // the model with the same consent semantics.
        let aiCallback: AiSummaryFn | undefined;
        if (!noAi && ctx.oneShotChat) {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { loadInsightsAiConsent, saveInsightsAiConsent } = require('./config') as typeof import('./config');
          let consent: 'allow' | 'deny' | undefined;
          if (ctx.providerKind === 'ollama') {
            consent = 'allow';
          } else {
            consent = await loadInsightsAiConsent();
            if (consent === undefined && ctx.getLine) {
              // Consent copy describes the v2 payload accurately —
              // verbatim prompt excerpts (up to 280 chars × 25) and
              // work-highlight detail with file paths. Anyone who
              // previously consented under the old "first 120 chars"
              // copy is re-prompted via the consent-key bump in config.ts.
              process.stdout.write('\n' + c.yellow('AI insights summary needs your OK once.') + '\n');
              process.stdout.write(c.dim('  Bandit will send your last ~25 prompt excerpts (up to 280 chars each),') + '\n');
              process.stdout.write(c.dim('  work-highlight metadata (titles, areas, file paths, counts), and aggregate') + '\n');
              process.stdout.write(c.dim('  stats to your cloud model so it can write a real narrative summary.') + '\n');
              process.stdout.write(c.dim('  Local Ollama users skip this prompt — bytes never leave the machine.') + '\n');
              process.stdout.write(c.dim('  Allow now? [y/N] '));
              const answer = (await ctx.getLine()).trim().toLowerCase();
              consent = /^y(es)?$/.test(answer) ? 'allow' : 'deny';
              try { await saveInsightsAiConsent(consent); } catch { /* non-fatal */ }
              process.stdout.write(c.dim(consent === 'allow' ? '  ✓ saved — disable later by editing ~/.bandit/config.json' : '  ↷ skipping AI summary on this and future runs.') + '\n\n');
            }
          }
          if (consent === 'allow') {
            // Shared with the IDE's `banditStealth.insights` command —
            // both surfaces build the callback the same way so the
            // system prompt, JSON payload, and parse semantics are
            // identical across CLI and extension.
            aiCallback = hostKit.buildInsightsAiCallback({
              oneShotChat: ctx.oneShotChat,
              modelLabel: ctx.model.current
            });
          }
        }

        // --text mode: same consent flow as --html, just renders to the
        // terminal instead of opening a browser. The storyline is the
        // headline value here — without the AI call this is back to
        // counters, which is the report the user asked us to move past.
        if (textOnly) {
          const data = computeInsights(ctx.cwd);
          if (aiCallback) {
            process.stdout.write(c.dim(`  asking ${ctx.model.current} for a summary…\n`));
            try {
              const ai = await aiCallback(hostKit.buildAiInput(data));
              if (ai) data.ai = ai;
            } catch {
              /* network / model failure — fall through to counter view */
            }
          }
          return renderInsightsText(data);
        }

        if (aiCallback) {
          process.stdout.write(c.dim(`  asking ${ctx.model.current} for a summary…\n`));
        }
        const written = await writeInsightsReport({ cwd: ctx.cwd, out, ai: aiCallback });
        // Try to open in browser (cross-platform). Best-effort — if it
        // fails, the path is right above so the user can open manually.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const cp = require('node:child_process') as typeof import('node:child_process');
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        try { cp.spawn(opener, [written], { detached: true, stdio: 'ignore' }).unref(); } catch { /* opener missing */ }
        return c.green('✓ insights written to ') + c.cyan(written) + c.dim('\n  (opening in your default browser)');
      } catch (err) {
        return c.red(`Insights failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  },
  {
    name: 'tasks',
    description: 'List background subagent tasks (running + done). /tasks <id> shows full synopsis. /tasks cancel <id> cancels a running task.',
    run(args, ctx) {
      const store = ctx.backgroundStore;
      if (!store) {
        return c.dim('Background tasks are not available in this host.');
      }
      const arg = args.trim();
      // /tasks cancel <id>
      if (/^cancel\s+\S+/.test(arg)) {
        const id = arg.replace(/^cancel\s+/, '').trim();
        const record = store.get(id);
        if (!record) return c.red(`No task with id "${id}".`);
        if (record.status !== 'running') {
          return c.dim(`Task ${id} is already ${record.status}.`);
        }
        store.cancel(id);
        return c.green(`✓ cancelled background task ${id}`);
      }
      // /tasks <id> — drill-down
      if (arg && !arg.startsWith('cancel')) {
        const record = store.get(arg);
        if (!record) return c.red(`No task with id "${arg}".`);
        const seconds = ((record.endedAt ?? Date.now()) - record.startedAt) / 1000;
        const lines: string[] = [
          c.bold(`Task ${record.id}`),
          `  status      ${record.status}`,
          `  goal        ${record.goal}`,
          `  duration    ${seconds.toFixed(1)}s`,
          `  iterations  ${record.iterations}`,
          `  tool calls  ${record.toolCalls}`
        ];
        if (record.lastTool) lines.push(`  last tool   ${record.lastTool}`);
        if (record.synopsis) lines.push('', c.bold('Synopsis:'), record.synopsis);
        if (record.error) lines.push('', c.red('Error: ') + record.error);
        return lines.join('\n');
      }
      // /tasks (no args) — list all
      const tasks = store.list();
      if (tasks.length === 0) {
        return c.dim('No background tasks have been spawned in this session.');
      }
      const rows = tasks.map((t) => {
        const seconds = ((t.endedAt ?? Date.now()) - t.startedAt) / 1000;
        const status = t.status === 'running'
          ? c.cyan(`running (${seconds.toFixed(0)}s)`)
          : t.status === 'completed'
          ? c.green(`completed (${seconds.toFixed(1)}s)`)
          : t.status === 'failed'
          ? c.red(`failed (${seconds.toFixed(1)}s)`)
          : c.dim(`cancelled (${seconds.toFixed(1)}s)`);
        const goalSlice = t.goal.length > 60 ? t.goal.slice(0, 60) + '…' : t.goal;
        return `  ${c.cyan(t.id)}  ${status}  ${c.dim(goalSlice)}`;
      });
      return [c.bold('Background subagent tasks:'), ...rows, '', c.dim('Use /tasks <id> for the full synopsis or /tasks cancel <id> to stop one.')].join('\n');
    }
  },
  {
    name: 'login',
    description: 'Sign in to Bandit Cloud. /login (browser OAuth — recommended), /login <key> (paste a key manually), /login status, /login clear',
    async run(args, ctx) {
      const arg = args.trim();
      const cfg = ctx.getConfig();
      const redact = (v?: string): string => v ? `${v.slice(0, 6)}…${v.slice(-4)}` : '(none)';
      // No-arg form now triggers OAuth instead of just showing status.
      // Status moves to /login status (explicit subcommand) so the
      // common case — "log me in" — is the simplest path.
      if (!arg) {
        try {
          const { runOAuthSignIn } = await import('./auth/oauthFlow');
          process.stdout.write(c.dim('Opening browser for sign-in… (waiting up to 5 minutes)\n'));
          const result = await runOAuthSignIn({}, (line) => process.stdout.write(c.dim(line) + '\n'));
          const file = await saveApiKey(result.apiKey);
          const greeting = result.name ? `Signed in as ${c.accent(result.name)}.` : 'Signed in.';
          const lines = [
            c.green(`✓ ${greeting}`),
            c.dim('  device key saved to ') + c.cyan(file),
            c.dim('  provider switched to ') + c.cyan('bandit')
          ];
          if (result.email) lines.splice(1, 0, c.dim('  account: ') + c.cyan(result.email));
          return lines.join('\n');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return c.red(`Sign-in failed: ${msg}`);
        }
      }
      if (arg.toLowerCase() === 'status') {
        return [
          c.bold('Bandit Cloud login'),
          `  current key:   ${redact(cfg.apiKey)}`,
          `  config file:   ${c.cyan(globalConfigPath())}`,
          '',
          c.dim('Sign in: ') + c.cyan('/login') + c.dim('   (browser OAuth)'),
          c.dim('Manual:  ') + c.cyan('/login <key>') + c.dim('   (paste an existing key)'),
          c.dim('Clear:   ') + c.cyan('/login clear')
        ].join('\n');
      }
      if (arg.toLowerCase() === 'clear' || arg.toLowerCase() === 'logout') {
        const file = await clearApiKey();
        return c.green('✓ API key cleared from ') + c.cyan(file);
      }
      const candidate = arg.replace(/^['"]|['"]$/g, '');
      if (candidate.length < 16) {
        return c.red(`That doesn't look like a Bandit Cloud key (got ${candidate.length} chars). Run ${c.cyan('/login')} for browser sign-in instead.`);
      }
      const file = await saveApiKey(candidate);
      return [
        c.green('✓ API key saved to ') + c.cyan(file),
        c.dim('  provider switched to ') + c.cyan('bandit') + c.dim(' — restart bandit (or just send a prompt) to use it.')
      ].join('\n');
    }
  },
  {
    name: 'logout',
    description: 'Sign out of Bandit Cloud (clears the saved API key)',
    async run() {
      const file = await clearApiKey();
      return [
        c.green('✓ Signed out — API key cleared from ') + c.cyan(file),
        c.dim('  Run ') + c.cyan('/login') + c.dim(' to sign in again.')
      ].join('\n');
    }
  },
  {
    name: 'tavily',
    description: 'Set the Tavily web-search API key (BYOK). /tavily <key>, /tavily status, /tavily clear',
    async run(args, ctx) {
      const arg = args.trim();
      const cfg = ctx.getConfig();
      const redact = (v?: string): string => v ? `${v.slice(0, 6)}…${v.slice(-4)}` : '(none)';
      const envSet = !!(process.env.TAVILY_API_KEY?.trim());
      if (!arg || arg.toLowerCase() === 'status') {
        const lines = [
          c.bold('Tavily web search'),
          `  current key:   ${redact(cfg.tavilyApiKey)}`,
          `  source:        ${envSet ? c.cyan('env TAVILY_API_KEY') : (cfg.tavilyApiKey ? c.cyan('~/.bandit/config.json') : c.dim('not configured'))}`,
          `  config file:   ${c.cyan(globalConfigPath())}`,
          '',
          c.dim('Save:   ') + c.cyan('/tavily <key>') + c.dim('     (grab one at https://tavily.com — free tier covers casual use)'),
          c.dim('Clear:  ') + c.cyan('/tavily clear'),
          '',
          c.dim('Once set, the agent\'s ') + c.cyan('web_search') + c.dim(' tool returns ranked snippets — useful for')
            + c.dim(' looking up library APIs, error messages, current docs.')
        ];
        return lines.join('\n');
      }
      if (arg.toLowerCase() === 'clear') {
        const file = await clearTavilyKey();
        const note = envSet
          ? '\n' + c.dim('  Note: ') + c.cyan('TAVILY_API_KEY') + c.dim(' is still set in your environment — unset it to fully disable web_search.')
          : '';
        return c.green('✓ Tavily key cleared from ') + c.cyan(file) + note;
      }
      const candidate = arg.replace(/^['"]|['"]$/g, '');
      // Tavily keys are typically 40+ chars, prefixed `tvly-`. Be lenient
      // on the prefix (they've shipped variants) but reject obvious typos.
      if (candidate.length < 20) {
        return c.red(`That doesn't look like a Tavily key (got ${candidate.length} chars). Get one at ${c.cyan('https://tavily.com')}.`);
      }
      const file = await saveTavilyKey(candidate);
      const envWarn = envSet
        ? '\n' + c.dim('  Note: ') + c.cyan('TAVILY_API_KEY') + c.dim(' env var is also set — env wins until you unset it.')
        : '';
      return [
        c.green('✓ Tavily key saved to ') + c.cyan(file),
        c.dim('  ') + c.cyan('web_search') + c.dim(' is now enabled — the agent will pick it up on the next turn.') + envWarn
      ].join('\n');
    }
  },
  {
    name: 'repos',
    description: 'Manage custom repo locations Bandit scans when resolving repo names. /repos (list), /repos add <path>, /repos rm <path>',
    async run(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = (tokens[0] ?? '').toLowerCase();
      const target = tokens.slice(1).join(' ').trim();
      const cfg = ctx.getConfig();
      const builtIns = [
        '~/Documents/GitHub',
        '~/GitHub',
        '~/Projects',
        '~/code',
        '~/dev',
        '~/repos',
        '~/work',
        '~/src',
        '~'
      ];

      if (!sub || sub === 'list' || sub === 'ls') {
        const custom = cfg.repoRoots ?? [];
        const lines = [
          c.bold('Repo discovery roots — where Bandit looks when you ask to find a repo by name'),
          '',
          c.dim('Custom (from ~/.bandit/config.json: repos.roots):')
        ];
        if (custom.length === 0) {
          lines.push(c.dim('  (none — add one with /repos add <path>)'));
        } else {
          for (const r of custom) lines.push('  ' + c.cyan(r));
        }
        lines.push('');
        lines.push(c.dim('Built-in clone parents (always scanned):'));
        for (const r of builtIns) lines.push(c.dim('  ' + r));
        lines.push('');
        lines.push(c.dim('When you say "find my auth-api repo" the agent calls find_directory which scans every entry above one level deep.'));
        lines.push(c.dim('Token-based match — "auth api" matches AuthApi, auth-api, or auth_api.'));
        return lines.join('\n');
      }

      if (sub === 'add') {
        if (!target) return c.red('Usage: /repos add <path>  — e.g. /repos add ~/work/clients');
        try {
          const result = await addRepoRoot(target);
          const lines = [
            c.green(result.added ? '✓ added ' : '↷ already known: ') + c.cyan(target),
            c.dim('  config: ') + c.cyan(result.configFile),
            c.dim('  current custom roots: ') + (result.allRoots.length === 0
              ? c.dim('(none)')
              : result.allRoots.map((r) => c.cyan(r)).join(c.dim(', ')))
          ];
          return lines.join('\n');
        } catch (err) {
          return c.red(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (sub === 'rm' || sub === 'remove' || sub === 'del') {
        if (!target) return c.red('Usage: /repos rm <path>  — must match a path that was added via /repos add');
        try {
          const result = await removeRepoRoot(target);
          if (!result.removed) {
            return c.dim(`↷ "${target}" wasn't in the custom roots list. Run /repos to see what's there.`);
          }
          return [
            c.green('✓ removed ') + c.cyan(target),
            c.dim('  config: ') + c.cyan(result.configFile),
            c.dim('  remaining custom roots: ') + (result.allRoots.length === 0
              ? c.dim('(none)')
              : result.allRoots.map((r) => c.cyan(r)).join(c.dim(', ')))
          ].join('\n');
        } catch (err) {
          return c.red(`Remove failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return c.red(`Unknown subcommand "${sub}". Use /repos, /repos add <path>, or /repos rm <path>.`);
    }
  },
  {
    name: 'mcp',
    description: 'Manage Model Context Protocol servers (/mcp, /mcp tools <name>, /mcp connect <name>, /mcp reload)',
    async run(args, ctx) {
      if (!ctx.mcpPool) {
        return c.dim('MCP support is not wired in this host.');
      }
      let tokens = args.trim().split(/\s+/).filter(Boolean);
      let sub = (tokens[0] ?? '').toLowerCase();
      let target = tokens[1];

      // No-arg form: status table + how-to-edit pointer.
      if (!sub) {
        const snap = ctx.mcpPool.snapshot();
        if (snap.length === 0) {
          return [
            c.bold('MCP servers'),
            c.dim('  No servers configured.'),
            '',
            c.dim('Add some by editing ') + c.cyan('~/.bandit/mcp-servers.json') + c.dim(' or ') + c.cyan('.bandit/mcp-servers.json') + c.dim(' (workspace).'),
            c.dim('Schema:'),
            c.dim('  { "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }'),
            '',
            c.dim('Then run ') + c.cyan('/mcp reload') + c.dim(' to register them in this session.')
          ].join('\n');
        }
        const lines: string[] = [c.bold('MCP servers:')];
        for (const s of snap) {
          const stateLabel = s.status.state === 'connected'
            ? c.green(`connected · ${s.status.toolCount} tool${s.status.toolCount === 1 ? '' : 's'}`)
            : s.status.state === 'connecting'
            ? c.yellow('connecting…')
            : s.status.state === 'error'
            ? c.red(`error: ${s.status.message}`)
            : s.status.state === 'disabled'
            ? c.dim('disabled')
            : c.dim('idle (lazy connect)');
          const cmd = `${s.config.command}${s.config.args && s.config.args.length ? ' ' + s.config.args.join(' ') : ''}`;
          const mode = s.config.activation ?? 'always';
          lines.push(`  ${c.cyan(s.name.padEnd(20))} ${stateLabel}  ${c.dim('· ' + mode)}`);
          lines.push(c.dim(`    cmd: ${cmd}`));
        }
        lines.push('');
        lines.push(c.dim('Subcommands:'));
        lines.push(c.dim('  /mcp add github <token>       — guided GitHub connector setup'));
        lines.push(c.dim('  /mcp add gitlab <token> [url] — GitLab.com or self-hosted'));
        lines.push(c.dim('  /mcp add slack <bot> <team>   — Slack via bot token + team id'));
        lines.push(c.dim('  /mcp add gmail <creds.json>   — Gmail via Google Cloud OAuth credentials'));
        lines.push(c.dim('  /mcp add custom <name> <cmd…> — any MCP server (Linear/Jira/Bitbucket/Sentry/etc.)'));
        lines.push(c.dim('  /mcp blabs google connect    — authorize a Google Workspace via browser (Burtson Labs broker)'));
        lines.push(c.dim('  /mcp blabs google list       — list connected Google accounts'));
        lines.push(c.dim('  /mcp blabs google disconnect <id> — remove a connection'));
        lines.push(c.dim('  /mcp tools <name>             — list tools the server exposes'));
        lines.push(c.dim('  /mcp connect <name>           — explicit warmup (otherwise lazy)'));
        lines.push(c.dim('  /mcp disconnect <name>        — close the server\'s child process'));
        lines.push(c.dim('  /mcp revoke <name>            — remove the persisted "always allow" decision'));
        lines.push(c.dim('  /mcp activation <name> <mode> — set always | on-mention'));
        lines.push(c.dim('  /mcp reload                   — re-read mcp-servers.json from disk'));
        return lines.join('\n');
      }

      if (sub === 'reload') {
        if (!ctx.reloadMcpFromDisk) return c.dim('reload not supported by this host.');
        const count = await ctx.reloadMcpFromDisk();
        return c.green(`✓ ${count} MCP server${count === 1 ? '' : 's'} registered from disk.`);
      }

      // Google Workspace connection management direct from
      // the CLI. Mirrors burtson.ai/mcp for users who can't reach the
      // website (headless dev box, CI runner, future self-hosted
      // AuthApi deploys). Browser-based OAuth flow → local callback
      // listener → success in the terminal, never asks the user to
      // copy-paste a token by hand.
      // Normalize Google MCP OAuth subcommands.
      //
      // Canonical: `/mcp blabs google …` — "blabs" namespaces the
      // command under the Burtson Labs MCP server so it doesn't
      // collide with future MCPs Google (or anyone else) might ship.
      // `burtson-labs` and `burtson` are accepted aliases (matches the
      // mcp-servers.json server key and the brand prefix respectively).
      //
      // Backward-compat: `/mcp google …` (no namespace) still works
      // but emits a one-line deprecation hint so users learn the new
      // shape. Drop the hint once this lands in user muscle memory.
      let namespacedAsLegacyGoogle = false;
      const NAMESPACE_ALIASES = new Set(['blabs', 'burtson-labs', 'burtson']);
      if (sub && NAMESPACE_ALIASES.has(sub) && (tokens[1] ?? '').toLowerCase() === 'google') {
        // Shift the tokens so the rest of the handler treats this like
        // legacy `/mcp google <subcmd> …`. The original sub becomes
        // 'google' and what was tokens[1] (the literal 'google') gets
        // dropped — same shape downstream.
        sub = 'google';
        tokens = tokens.slice(1);
        // Re-derive `target` for sub-handlers further below that expect
        // it (server-name target for tools/info/etc — doesn't apply to
        // the google branch but keeps the function's invariants tidy).
        target = tokens[0] ?? '';
      } else if (sub === 'google') {
        namespacedAsLegacyGoogle = true;
      }

      if (sub === 'google') {
        const cfg = ctx.getConfig();
        const subsub = (tokens[1] ?? '').toLowerCase();
        const deprecationNote = namespacedAsLegacyGoogle
          ? c.dim('  ↳ tip: ') + c.yellow('`/mcp google …` is now `/mcp blabs google …`') + c.dim(' — old form still works.') + '\n'
          : '';
        if (!subsub || subsub === 'help') {
          return [
            c.bold('Burtson Labs MCP — Google Workspace connections'),
            '',
            c.dim('  /mcp blabs google connect [--workspace=<label>] [--scopes=<csv>]'),
            c.dim('    Authorize a new Google account via browser. Default scopes:'),
            c.dim('    gmail,docs,drive,sheets,calendar.'),
            '',
            c.dim('  /mcp blabs google list'),
            c.dim('    Show your connected accounts + workspace labels + scopes.'),
            '',
            c.dim('  /mcp blabs google disconnect <id>'),
            c.dim('    Remove a connection (get id from `/mcp blabs google list`).'),
            '',
            c.dim('Aliases for the namespace prefix: ') + c.cyan('blabs') + c.dim(' / ') + c.cyan('burtson-labs') + c.dim(' / ') + c.cyan('burtson') + c.dim('. `/mcp google …` (no prefix) still works for backward compat.'),
            '',
            c.dim('Same operations are available at ') + c.cyan('https://burtson.ai/mcp') + c.dim('.'),
          ].join('\n');
        }
        if (subsub === 'connect') {
          // Parse --workspace= and --scopes= from the remaining tokens.
          // No need for a full flag parser; the surface is small and
          // we don't want to take a dependency on yargs for two flags.
          const rest = tokens.slice(2);
          let workspace: string | undefined;
          let scopes: string | undefined;
          for (const t of rest) {
            if (t.startsWith('--workspace=')) workspace = t.slice('--workspace='.length).trim();
            else if (t.startsWith('--scopes=')) scopes = t.slice('--scopes='.length).trim();
          }
          const connectOutput = await connectGoogleViaCli(cfg, { workspace, scopes });
          // Auto-reload the MCP pool when the connect succeeded — the
          // host wrote a new entry to mcp-servers.json, but the pool
          // was initialised at session start and won't pick it up
          // without an explicit /mcp reload. Doing it inline here
          // means the user goes from /mcp google connect → ask for an
          // email in ONE prompt without a manual reload + restart in
          // the middle. Skips on failure paths since there's nothing
          // new to reload.
          const succeeded = /Connected workspace/i.test(connectOutput);
          if (succeeded && ctx.reloadMcpFromDisk) {
            try {
              const count = await ctx.reloadMcpFromDisk();
              return deprecationNote + connectOutput + '\n' + c.dim(`  ↳ auto-reloaded MCP pool — ${count} server${count === 1 ? '' : 's'} now active.`);
            } catch (err) {
              return deprecationNote + connectOutput + '\n' + c.yellow(`  ⚠ auto-reload failed: ${err instanceof Error ? err.message : String(err)} — run /mcp reload manually.`);
            }
          }
          return deprecationNote + connectOutput;
        }
        if (subsub === 'list' || subsub === 'ls') {
          return deprecationNote + (await listGoogleConnections(cfg));
        }
        if (subsub === 'disconnect' || subsub === 'remove' || subsub === 'rm') {
          const connectionId = tokens[2];
          if (!connectionId) {
            return c.red('Usage: /mcp blabs google disconnect <id> — get the id from `/mcp blabs google list`.');
          }
          return deprecationNote + (await disconnectGoogle(cfg, connectionId));
        }
        return c.red(`Unknown subcommand "${subsub}". Try /mcp blabs google for help.`);
      }

      if (!target) {
        return c.red(`Usage: /mcp ${sub} <server-name>`);
      }

      if (sub === 'tools') {
        const tools = await ctx.mcpPool.discoverTools(target);
        if (tools.length === 0) {
          const snap = ctx.mcpPool.snapshot().find(s => s.name === target);
          if (!snap) return c.red(`Unknown MCP server "${target}".`);
          if (snap.status.state === 'error') {
            return c.red(`Server "${target}" is in error state: ${snap.status.message}`);
          }
          return c.dim(`Server "${target}" exposes no tools (or has not been queried yet).`);
        }
        const lines: string[] = [c.bold(`Tools exposed by "${target}":`)];
        for (const t of tools) {
          lines.push(`  ${c.cyan(`${target}.${t.name}`)}`);
          if (t.description) lines.push(c.dim(`    ${t.description}`));
        }
        return lines.join('\n');
      }

      if (sub === 'connect') {
        const ok = await ctx.mcpPool.reconnect(target);
        if (!ok) {
          const snap = ctx.mcpPool.snapshot().find(s => s.name === target);
          const detail = snap?.status.state === 'error' ? snap.status.message : `state=${snap?.status.state ?? 'unknown'}`;
          return c.red(`Could not connect "${target}": ${detail}`);
        }
        return c.green(`✓ Connected to "${target}".`);
      }

      if (sub === 'disconnect') {
        // Disconnect = re-register (which disposes any active connection)
        // and let the next ensureConnected re-spawn lazily on demand.
        const snap = ctx.mcpPool.snapshot().find(s => s.name === target);
        if (!snap) return c.red(`Unknown MCP server "${target}".`);
        ctx.mcpPool.register(target, snap.config);
        return c.green(`✓ Disconnected "${target}" (will lazy-reconnect on next use).`);
      }

      if (sub === 'revoke') {
        if (!ctx.revokeMcpTrust) return c.dim('Trust revoke is not supported by this host.');
        const ok = await ctx.revokeMcpTrust(target);
        if (!ok) return c.red(`Unknown MCP server "${target}".`);
        return [
          c.green(`✓ Trust revoked for "${target}".`),
          c.dim('  The next first-spawn for this server config will re-prompt for approval.')
        ].join('\n');
      }

      if (sub === 'add') {
        // /mcp add <provider> <args...> — connector wizards.
        const provider = (tokens[1] ?? '').toLowerCase();
        if (provider === 'github') {
          if (!ctx.addGitHubMcp) return c.dim('Connector wizards are not supported by this host.');
          const token = (tokens.slice(2).join(' ') || '').trim();
          if (!token) {
            return [
              c.bold('Usage: ') + c.cyan('/mcp add github <token>'),
              '',
              c.dim('Get a token at ') + linkify('https://github.com/settings/tokens'),
              c.dim('Classic PAT scopes: ') + c.cyan('repo, read:user, read:org'),
              c.dim('Fine-grained: pick the repos you want Bandit to read/write.')
            ].join('\n');
          }
          if (!looksLikeGitHubToken(token)) {
            return c.red(`Token doesn't look like a GitHub PAT (expected prefix: ghp_ / github_pat_ / gho_).`);
          }
          try {
            const target = await ctx.addGitHubMcp(token);
            return [
              c.green('✓ GitHub MCP server added'),
              c.dim('  saved to ') + c.cyan(target),
              c.dim('  activation: ') + c.accent('on-mention') + c.dim(' (tools surface when prompts mention github / repo / pr / issue / commit)'),
              c.dim('  fingerprint pre-trusted — no first-spawn approval prompt')
            ].join('\n');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return c.red(`Could not add GitHub server: ${msg}`);
          }
        }

        if (provider === 'slack') {
          if (!ctx.addSlackMcp) return c.dim('Connector wizards are not supported by this host.');
          const botToken = (tokens[2] ?? '').trim();
          const teamId = (tokens[3] ?? '').trim();
          if (!botToken || !teamId) {
            return [
              c.bold('Usage: ') + c.cyan('/mcp add slack <bot-token> <team-id>'),
              '',
              c.dim('Bot token: starts with ') + c.cyan('xoxb-') + c.dim(' (create one at ') + linkify('https://api.slack.com/apps') + c.dim(' → OAuth & Permissions)'),
              c.dim('Required scopes: ') + c.cyan('channels:history channels:read chat:write users:read'),
              c.dim('Team ID: starts with ') + c.cyan('T…') + c.dim(' (find in your workspace URL or via the Slack admin console).')
            ].join('\n');
          }
          try {
            const target = await ctx.addSlackMcp(botToken, teamId);
            return [
              c.green('✓ Slack MCP server added'),
              c.dim('  saved to ') + c.cyan(target),
              c.dim('  activation: on-mention (mention slack / channel / message in your prompt to summon)')
            ].join('\n');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return c.red(`Could not add Slack server: ${msg}`);
          }
        }

        if (provider === 'gitlab') {
          if (!ctx.addGitLabMcp) return c.dim('Connector wizards are not supported by this host.');
          const token = (tokens[2] ?? '').trim();
          const url = (tokens[3] ?? '').trim() || undefined;
          if (!token) {
            return [
              c.bold('Usage: ') + c.cyan('/mcp add gitlab <token> [api-url]'),
              '',
              c.dim('Token: GitLab PAT — create at ') + linkify('https://gitlab.com/-/user_settings/personal_access_tokens'),
              c.dim('Recommended scopes: ') + c.cyan('api, read_repository, read_user'),
              c.dim('api-url: omit for gitlab.com; otherwise the base /api/v4 URL of your self-hosted instance.')
            ].join('\n');
          }
          try {
            const target = await ctx.addGitLabMcp(token, url);
            return [
              c.green('✓ GitLab MCP server added'),
              c.dim('  saved to ') + c.cyan(target),
              c.dim('  activation: on-mention (gitlab / repo / mr / pipeline trigger the tools)')
            ].join('\n');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return c.red(`Could not add GitLab server: ${msg}`);
          }
        }

        if (provider === 'gmail') {
          if (!ctx.addGmailMcp) return c.dim('Connector wizards are not supported by this host.');
          const credentialsPath = (tokens.slice(2).join(' ') || '').trim();
          if (!credentialsPath) {
            return [
              c.bold('Usage: ') + c.cyan('/mcp add gmail <path-to-credentials.json>'),
              '',
              c.dim('Gmail MCP needs an OAuth credentials file you create in Google Cloud:'),
              c.dim('  1. Open ') + linkify('https://console.cloud.google.com/apis/credentials'),
              c.dim('  2. Create OAuth 2.0 Client ID → type ') + c.cyan('Desktop app'),
              c.dim('  3. Enable the Gmail API on the same project.'),
              c.dim('  4. Download the credentials JSON.'),
              c.dim('  5. Re-run: ') + c.cyan('/mcp add gmail ~/Downloads/client_secret_….json'),
              '',
              c.dim('First Gmail call after setup opens a browser tab for Google\'s consent screen.'),
              c.dim('After that the server caches the refresh token at ') + c.cyan('~/.gmail-mcp/credentials.json') + c.dim('.')
            ].join('\n');
          }
          if (!looksLikeGmailCredentialsPath(credentialsPath)) {
            return c.red('Path doesn\'t look like a credentials JSON file (expected something ending in .json).');
          }
          try {
            const target = await ctx.addGmailMcp(credentialsPath);
            return [
              c.green('✓ Gmail MCP server added'),
              c.dim('  saved to ') + c.cyan(target),
              c.dim('  credentials copied to ') + c.cyan('~/.gmail-mcp/gcp-oauth.keys.json'),
              c.dim('  activation: on-mention (email / inbox / draft / send mentions wake the tools)'),
              '',
              c.yellow('  ⚡ first use will open a browser for Google\'s OAuth consent screen — approve once, then it runs unattended')
            ].join('\n');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return c.red(`Could not add Gmail server: ${msg}`);
          }
        }

        if (provider === 'custom') {
          if (!ctx.addCustomMcp) return c.dim('Connector wizards are not supported by this host.');
          // /mcp add custom <name> <command...> ENV1=val1;ENV2=val2
          // Env vars are everything matching KEY=VALUE in the
          // remaining tokens; non-KEY=VALUE tokens are command + args.
          const remaining = tokens.slice(2);
          const name = remaining.shift();
          if (!name) {
            return [
              c.bold('Usage: ') + c.cyan('/mcp add custom <name> <command…> [KEY=value …]'),
              '',
              c.dim('Examples:'),
              c.dim('  /mcp add custom linear npx -y @some/linear-mcp LINEAR_API_KEY=lin_…'),
              c.dim('  /mcp add custom jira node ./jira-mcp.js JIRA_BASE=https://… JIRA_TOKEN=…'),
              '',
              c.dim('All env-var tokens (KEY=value) move into the server\'s env block; everything else becomes the command + args.')
            ].join('\n');
          }
          const envParts: string[] = [];
          const cmdParts: string[] = [];
          for (const t of remaining) {
            if (/^[A-Z_][A-Z0-9_]*=/.test(t)) envParts.push(t);
            else cmdParts.push(t);
          }
          if (cmdParts.length === 0) {
            return c.red('A command is required (e.g. "npx -y @some/mcp-server").');
          }
          const command = cmdParts[0];
          const args = cmdParts.slice(1);
          const envInput = envParts.join('\n');
          try {
            const target = await ctx.addCustomMcp({ name, command, args, envInput });
            return [
              c.green(`✓ MCP server "${name}" added`),
              c.dim('  saved to ') + c.cyan(target),
              c.dim('  activation: on-mention — mention "') + c.accent(name) + c.dim('" or a tool keyword to summon it.')
            ].join('\n');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return c.red(`Could not add server: ${msg}`);
          }
        }

        return c.red(`Unknown connector "${provider || '(missing)'}". Available: ${c.cyan('github')}, ${c.cyan('slack')}, ${c.cyan('gitlab')}, ${c.cyan('gmail')}, ${c.cyan('custom')}.`);
      }

      if (sub === 'activation') {
        if (!ctx.setMcpActivation) return c.dim('Activation toggle is not supported by this host.');
        const mode = (tokens[2] ?? '').toLowerCase();
        if (mode !== 'always' && mode !== 'on-mention') {
          return c.red('Usage: /mcp activation <name> <always|on-mention>');
        }
        const ok = await ctx.setMcpActivation(target, mode);
        if (!ok) return c.red(`Unknown MCP server "${target}".`);
        return [
          c.green(`✓ "${target}" activation set to `) + c.accent(mode),
          mode === 'on-mention'
            ? c.dim('  Tools register only when the prompt mentions the server name or a known trigger keyword.')
            : c.dim('  Tools register on every prompt.')
        ].join('\n');
      }

      return c.red(`Unknown /mcp subcommand: ${sub}. Run /mcp for usage.`);
    }
  },
  {
    name: 'think',
    description: 'Toggle chain-of-thought thinking mode for reasoning-capable models (/think on, /think off, /think auto, /think)',
    run(args, ctx) {
      const arg = args.trim().toLowerCase();
      if (!arg) {
        const current = ctx.thinkingMode.get();
        const stateLabel = current === true ? c.green('on') : current === false ? c.red('off') : c.dim('auto (runtime default)');
        return [
          c.bold('Thinking mode: ') + stateLabel,
          c.dim('  /think on     force chain-of-thought on for every request this session'),
          c.dim('  /think off    force it off (default for agent tool-use — faster)'),
          c.dim('  /think auto   fall back to the runtime default per model')
        ].join('\n');
      }
      if (arg === 'on' || arg === 'true' || arg === 'yes') {
        ctx.thinkingMode.set(true);
        return c.green('✓ thinking mode ON — reasoning will stream before each response (slower, more deliberate)');
      }
      if (arg === 'off' || arg === 'false' || arg === 'no') {
        ctx.thinkingMode.set(false);
        return c.green('✓ thinking mode OFF — tool-use responses will be faster');
      }
      if (arg === 'auto' || arg === 'default' || arg === 'reset') {
        ctx.thinkingMode.set(undefined);
        return c.green('✓ thinking mode AUTO — using the runtime default per model');
      }
      return c.red(`Unknown argument "${arg}". Use: /think on, /think off, /think auto.`);
    }
  },
  {
    name: 'theme',
    description: 'Switch color theme — /theme (list), /theme <name>. Names: ' + THEME_NAMES.join(', '),
    async run(args, _ctx) {
      const arg = args.trim();
      if (!arg) {
        const lines = [c.bold('Themes:')];
        for (const name of THEME_NAMES) {
          setActiveTheme(name);
          const preview = `${c.green('✓ ok')} ${c.red('✗ err')} ${c.yellow('⚠ warn')} ${c.accent('› accent')}`;
          lines.push(`  ${c.cyan(name.padEnd(12))}  ${c.dim('— preview:')} ${preview}`);
        }
        // The previewing loop above leaves the active theme set to the
        // LAST entry in THEME_NAMES — caller's saved theme will be
        // re-applied on the next /theme call or restart, so this is
        // a benign side effect for the duration of this listing.
        lines.push('');
        lines.push(c.dim('Pick one with: /theme <name>'));
        return lines.join('\n');
      }
      if (!THEME_NAMES.includes(arg as never)) {
        return c.red(`Unknown theme "${arg}". Available: ${THEME_NAMES.join(', ')}`);
      }
      setActiveTheme(arg);
      try {
        await saveTheme(arg);
      } catch (err) {
        return c.yellow(`Theme switched in this session, but couldn't save preference: ${err instanceof Error ? err.message : String(err)}`);
      }
      return c.green(`${glyph.check} theme: ${c.accent(arg)} (saved)`);
    }
  },
  {
    name: 'plan-preview',
    description: 'Toggle plan-preview mode — shows a proposed plan with y/N confirmation before running each prompt (/plan-preview on, off, or status)',
    run(args, ctx) {
      const arg = args.trim().toLowerCase();
      if (!arg || arg === 'status') {
        const enabled = ctx.planPreview.get();
        return [
          c.bold('Plan preview: ') + (enabled ? c.green('on') : c.dim('off')),
          c.dim('  /plan-preview on    show a heuristic plan + y/N before every prompt'),
          c.dim('  /plan-preview off   run prompts directly (default)'),
          c.dim('  Good for multi-file refactors where you want a look before the agent burns iterations.')
        ].join('\n');
      }
      if (arg === 'on' || arg === 'true' || arg === 'yes') {
        ctx.planPreview.set(true);
        return c.green('✓ plan preview ON — next prompt will show a plan with y/N confirmation');
      }
      if (arg === 'off' || arg === 'false' || arg === 'no') {
        ctx.planPreview.set(false);
        return c.green('✓ plan preview OFF — prompts run directly');
      }
      return c.red(`Unknown argument "${arg}". Use: /plan-preview on, off, or status.`);
    }
  },
  {
    name: 'watchdog',
    description: 'Configure the no-token watchdog (/watchdog status, off, auto, or <duration> like 120s, 5m, 90000). Persists to ~/.bandit/config.json. BANDIT_NO_TOKEN_WATCHDOG_MS env var still wins per-shell.',
    async run(args, ctx) {
      const arg = args.trim().toLowerCase();
      const formatMs = (ms: number | undefined): string => {
        if (ms === undefined) return c.dim('auto-scale (formula: 120s floor + 2ms/char, cap 300s)');
        if (ms === 0) return c.red('off') + c.dim(' (no first-token timeout)');
        const secs = ms / 1000;
        if (secs >= 60) return c.green(`${(secs / 60).toFixed(secs % 60 === 0 ? 0 : 1)}m`) + c.dim(` (${ms} ms)`);
        return c.green(`${secs}s`) + c.dim(` (${ms} ms)`);
      };
      if (!arg || arg === 'status') {
        const lines = [
          c.bold('Watchdog state'),
          c.dim('  current:  ') + formatMs(ctx.watchdog.get()),
          c.dim('  env:      ') + (ctx.watchdog.envValue !== undefined
            ? c.yellow(formatMs(ctx.watchdog.envValue)) + c.dim(' (BANDIT_NO_TOKEN_WATCHDOG_MS — overrides everything else)')
            : c.dim('(unset)')),
          '',
          c.dim('  /watchdog off              persist watchdogMs=0 (no first-token timeout)'),
          c.dim('  /watchdog auto             clear the override, use auto-scale (default)'),
          c.dim('  /watchdog 120s             persist watchdogMs=120000 (accepts s/m/ms suffix or raw ms)'),
          c.dim('  /watchdog status           show this view')
        ];
        return lines.join('\n');
      }
      if (arg === 'off' || arg === 'disable' || arg === '0') {
        ctx.watchdog.set(0);
        try { await saveWatchdogMs(0); } catch { /* best effort — session value still applies */ }
        return c.green('✓ watchdog OFF — no first-token timeout (persisted to ~/.bandit/config.json)') +
          (ctx.watchdog.envValue !== undefined
            ? '\n' + c.yellow(`⚡ BANDIT_NO_TOKEN_WATCHDOG_MS=${ctx.watchdog.envValue} is set in this shell — env override still wins until you unset it.`)
            : '');
      }
      if (arg === 'auto' || arg === 'default' || arg === 'reset') {
        ctx.watchdog.set(undefined);
        try { await saveWatchdogMs(undefined); } catch { /* best effort */ }
        return c.green('✓ watchdog → auto-scale (formula: 120s floor + 2ms/char, cap 300s). Cleared the persisted override.');
      }
      // Parse a duration. Accept: "120s", "5m", "90000ms", or raw ms.
      const match = arg.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/);
      if (!match) {
        return c.red(`Couldn't parse "${arg}". Use: /watchdog off | auto | <duration> (e.g. 120s, 5m, 90000, or 90000ms).`);
      }
      const value = Number(match[1]);
      const unit = match[2] || 'ms';
      const ms = unit === 's' ? Math.round(value * 1000)
        : unit === 'm' ? Math.round(value * 60_000)
        : Math.round(value);
      if (ms < 5000) {
        return c.red(`Watchdog values under 5s are not useful (would fire before any model can respond). Got ${ms}ms.`);
      }
      ctx.watchdog.set(ms);
      try { await saveWatchdogMs(ms); } catch { /* best effort */ }
      return c.green(`✓ watchdog pinned to ${formatMs(ms)} (persisted to ~/.bandit/config.json)`) +
        (ctx.watchdog.envValue !== undefined
          ? '\n' + c.yellow(`⚡ BANDIT_NO_TOKEN_WATCHDOG_MS=${ctx.watchdog.envValue} is set in this shell — env override still wins until you unset it.`)
          : '');
    }
  },
  {
    name: 'notify',
    description: 'Configure CLI desktop/bell notifications (/notify status, on, off, sound on, sound off, min 30s). Desktop defaults off; VS Code notifications are separate.',
    async run(args, ctx) {
      const raw = args.trim().toLowerCase();
      const current = ctx.notifications?.get();
      if (!ctx.notifications || !current) {
        return c.yellow('Notifications are not available in this host session.');
      }
      const renderStatus = (state = ctx.notifications!.get()) => [
        c.bold('CLI notifications'),
        `  ${c.dim('desktop')} ${state.desktop ? c.green('on') : c.dim('off')}`,
        `  ${c.dim('sound')}   ${state.sound ? c.green('on') : c.dim('off')}`,
        `  ${c.dim('complete')} only after ${Math.round(state.minTurnMs / 1000)}s turns`,
        '',
        c.dim('  /notify on           desktop notifications for approvals, failures, background tasks, long turns'),
        c.dim('  /notify off          disable desktop notifications'),
        c.dim('  /notify sound on     terminal bell on notification events'),
        c.dim('  /notify sound off    disable terminal bell'),
        c.dim('  /notify min 45s      only notify turn-complete after this duration')
      ].join('\n');

      if (!raw || raw === 'status') return renderStatus();
      const save = async (patch: Partial<typeof current>): Promise<string> => {
        ctx.notifications!.set(patch);
        await saveNotifications(patch).catch(() => undefined);
        return renderStatus();
      };

      if (raw === 'on' || raw === 'desktop on') {
        return save({ desktop: true });
      }
      if (raw === 'off' || raw === 'desktop off') {
        return save({ desktop: false });
      }
      if (raw === 'sound on' || raw === 'bell on') {
        return save({ sound: true });
      }
      if (raw === 'sound off' || raw === 'bell off') {
        return save({ sound: false });
      }
      const minMatch = raw.match(/^min(?:imum)?\s+(\d+(?:\.\d+)?)\s*(ms|s|m)?$/);
      if (minMatch) {
        const value = Number(minMatch[1]);
        const unit = minMatch[2] || 's';
        const ms = unit === 'm' ? Math.round(value * 60_000)
          : unit === 'ms' ? Math.round(value)
          : Math.round(value * 1000);
        if (ms < 0) return c.red('Minimum duration must be 0 or greater.');
        return save({ minTurnMs: ms });
      }
      return c.red(`Unknown argument "${args}". Use /notify status, on, off, sound on/off, or min 30s.`);
    }
  },
  {
    name: 'coauthor',
    description: 'Toggle the Bandit co-author trailer on commits Bandit makes (/coauthor on, off, or status). Default on — the ninja avatar shows on GitHub PR + blame views.',
    async run(args, ctx) {
      const arg = args.trim().toLowerCase();
      if (!arg || arg === 'status') {
        const enabled = ctx.coauthor.get();
        const lines = [
          c.bold('Bandit co-author: ') + (enabled ? c.green('on') : c.dim('off')),
          c.dim('  Trailer: ') + c.cyan('Co-authored-by: Bandit <bandit@burtson.ai>'),
          c.dim('  /coauthor on     append the trailer on Bandit-issued commits (default)'),
          c.dim('  /coauthor off    do not append the trailer'),
          c.dim('  /coauthor status show this view')
        ];
        if (ctx.coauthor.envOff) {
          lines.push('');
          lines.push(c.yellow('  ⚡ BANDIT_NO_COAUTHOR=1 is set in this shell — env override forces off until you unset it.'));
        }
        return lines.join('\n');
      }
      if (arg === 'on' || arg === 'true' || arg === 'yes') {
        if (ctx.coauthor.envOff) {
          return c.yellow('⚡ BANDIT_NO_COAUTHOR=1 is set — unset that env var (e.g. `unset BANDIT_NO_COAUTHOR`) before turning the trailer back on.');
        }
        ctx.coauthor.set(true);
        try { await saveCoauthor(undefined); } catch { /* best effort — session setting still applies */ }
        return c.green('✓ co-author ON — next Bandit commit will include `Co-authored-by: Bandit <bandit@burtson.ai>`');
      }
      if (arg === 'off' || arg === 'false' || arg === 'no') {
        ctx.coauthor.set(false);
        try { await saveCoauthor(false); } catch { /* best effort */ }
        return c.green('✓ co-author OFF — Bandit will not add the trailer (persisted to ~/.bandit/config.json)');
      }
      return c.red(`Unknown argument "${arg}". Use: /coauthor on, off, or status.`);
    }
  },
  {
    name: 'plan',
    description: 'Heuristic plan for a goal, then y/N to execute — /plan <goal>',
    async run(args, ctx) {
      const goal = args.trim();
      if (!goal) return c.red('usage: /plan <goal>');
      const createPlan = planSkill.tools[0];
      if (!createPlan) return c.red('plan tool unavailable — this is a build issue');
      try {
        const result = await createPlan.execute({ goal }, ctx.toolCtx);
        if (result.isError) return c.red(result.output);
        process.stdout.write(result.output + '\n');

        // Run-now flow. Only offered when the host supplied both a
        // reader and a queue — one-shot mode / piped stdin skips this
        // gate entirely and the user just types a prompt. If they
        // confirm, queue the original goal so the REPL picks it up on
        // the next tick and the existing plan-preview / tool-use flow
        // takes over from there.
        if (ctx.getLine && ctx.queuePrompt) {
          process.stdout.write(c.dim('\nRun this plan now? [y/N] '));
          const answer = await ctx.getLine();
          const confirmed = /^\s*y(es)?\s*$/i.test(answer.trim());
          if (confirmed) {
            ctx.queuePrompt(goal);
            return c.green(`${glyph.check} executing plan — goal queued`);
          }
          return c.dim('↷ plan kept on-screen. Type a revised goal or re-run /plan.');
        }
        return c.dim('Review the plan, then type a prompt to execute it.');
      } catch (err) {
        return c.red(`plan failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  },
  // ── Built-in workflow skills ────────────────────────────────────────
  // Each command builds a structured agent prompt and queues it through
  // the REPL's normal tool-use loop via ctx.queuePrompt. The model gets
  // a tight, opinionated brief instead of generic chat — lets users
  // type `/init` or `/commit` and watch a real workflow execute. These
  // are the "tweet-friendly" commands that make the CLI pop without
  // the user having to write skills themselves first.
  {
    name: 'init',
    description: 'Scaffold BANDIT.md (Behavior + Project facts) — agent reads the repo and writes a Karpathy-shape memory file',
    async run(_args, ctx) {
      if (!ctx.queuePrompt) {
        return c.dim('(/init must run inside the REPL — not available in one-shot mode)');
      }
      const prompt = [
        'Initialize this repository for AI-agent collaboration by writing a BANDIT.md file at the project root in the Karpathy two-section shape.',
        '',
        'Steps:',
        '1. List the repo root with `list_files .` to see top-level structure.',
        '2. Read the README (if present) and the primary manifest (package.json / Cargo.toml / pyproject.toml / go.mod / *.csproj — whichever applies). Skim only — do not dump full contents into chat.',
        '3. Detect tech stack from file extensions and the manifest.',
        '4. Write BANDIT.md via `write_file` with EXACTLY this top-level shape:',
        '',
        '   ```markdown',
        '   # <Project name> — project memory',
        '',
        '   ## Behavior',
        '',
        '   ### Before editing',
        '   - <one rule per bullet — e.g. "Read the file first. Don\'t apply_edit blind.">',
        '',
        '   ### When changing code',
        '   - <style/scope rules — match existing patterns, no drive-by refactors>',
        '',
        '   ### When finishing a task',
        '   - <verify commands the agent should run (typecheck, tests, lint)>',
        '',
        '   ### Communication',
        '   - <commit style, changelog tone, anything user-facing>',
        '',
        '   ## Project facts',
        '',
        '   ### Repo layout',
        '   - <one-line per top-level folder + what lives there>',
        '',
        '   ### Defaults',
        '   - <runtimes, model defaults, env flags worth knowing>',
        '',
        '   ### Conventions',
        '   - <build/test commands, package manager, anything else>',
        '   ```',
        '',
        '5. Keep it under ~150 lines total. Skim-friendly headers, one fact per bullet.',
        '6. Behavior comes first because it is what the agent must obey on every turn. Project facts come second because they are reference material.',
        '7. If BANDIT.md already exists, read it first and ASK before overwriting.',
        '',
        'Optional next step (offer, do not auto-do): ask whether to also scaffold a MEMORY.md index + an empty `memory/` directory for lazy-loaded topic files. Only scaffold MEMORY.md if the user says yes; do not create memory/<file>.md placeholders unless asked.'
      ].join('\n');
      ctx.queuePrompt(prompt);
      return c.dim(`${glyph.spark} initializing — agent will scan the repo and draft BANDIT.md`);
    }
  },
  {
    name: 'commit',
    description: 'Analyze diff, write a conventional-commit message, commit with your approval',
    async run(args, ctx) {
      if (!ctx.queuePrompt) {
        return c.dim('(/commit must run inside the REPL — not available in one-shot mode)');
      }
      const note = args.trim();
      const prompt = [
        'Help me commit. Workflow:',
        '',
        '1. Run `git status` to see what\'s in working tree + staging.',
        '2. Run `git diff --staged` to see what\'s about to be committed. If nothing is staged, run `git diff` and ask whether I want to stage all changes (do not auto-stage).',
        '3. Based on the actual diff, draft a conventional-commit message:',
        '   - subject line ≤72 chars: `<type>: <imperative summary>` where type is one of feat, fix, chore, docs, refactor, perf, test, build, ci, style',
        '   - body (optional, only when non-trivial): explain WHY, not what — the diff already shows what.',
        '   - skip body for one-line trivial changes',
        note ? `4. The user added this hint to factor in: "${note}"` : '4. (No additional hint from the user.)',
        '5. Show me the proposed message and ask for approval before running `git commit -m` (use a HEREDOC for multi-line messages so newlines are preserved).',
        '6. After commit, run `git status` to confirm clean state.',
        '',
        'Do NOT skip pre-commit hooks. Do NOT add a Co-Authored-By trailer. Do NOT push.'
      ].join('\n');
      ctx.queuePrompt(prompt);
      return c.dim(`${glyph.spark} drafting commit — agent will analyze the diff and propose a message`);
    }
  },
  {
    name: 'review',
    description: 'Code review of staged changes (or current branch vs main) against correctness/security/perf rubrics',
    async run(args, ctx) {
      if (!ctx.queuePrompt) {
        return c.dim('(/review must run inside the REPL — not available in one-shot mode)');
      }
      const focus = args.trim();
      const prompt = [
        'Code review. Workflow:',
        '',
        '1. Run `git diff --staged`. If empty, run `git diff main...HEAD` to review the current branch against main.',
        '2. If both are empty, run `git diff` to review unstaged work.',
        '3. Review the diff against these rubrics — be specific, cite `file:line`:',
        '   - **Correctness** — bugs, edge cases, off-by-one, null handling, race conditions',
        '   - **Security** — input validation, injection (SQL/command/template), secrets in code, CSRF, AuthZ',
        '   - **Performance** — N+1 queries, unbounded loops, blocking I/O on hot paths, memory leaks',
        '   - **Tests** — is there coverage for the new code paths? Note specific test gaps',
        '   - **Style** — consistency with surrounding code (NOT generic linter checks)',
        focus ? `4. The user wants extra scrutiny on: "${focus}" — bias your review toward these concerns.` : '4. No specific focus area requested — apply rubrics evenly.',
        '5. End with a one-line verdict: 🟢 GO (ship it), 🟡 GO WITH CHANGES (small fixes needed), or 🔴 NO-GO (substantive issues to address).',
        '',
        'No "consider adding tests" generalities. If you flag something, give a concrete fix or counter-example.'
      ].join('\n');
      ctx.queuePrompt(prompt);
      return c.dim(`${glyph.spark} reviewing — agent will analyze the diff and apply rubrics`);
    }
  },
  {
    name: 'refactor',
    description: 'Suggest concrete refactors for a target file or function — /refactor src/foo.ts or /refactor parseUser',
    async run(args, ctx) {
      if (!ctx.queuePrompt) {
        return c.dim('(/refactor must run inside the REPL — not available in one-shot mode)');
      }
      const target = args.trim();
      if (!target) return c.red('usage: /refactor <file path or function name>');
      const prompt = [
        `Refactor analysis for: ${target}`,
        '',
        '1. If the target looks like a file path, `read_file` it. If it looks like a function/symbol name, `grep` for the definition first then read the containing file.',
        '2. Identify concrete refactoring opportunities:',
        '   - **Duplication** — repeated patterns that should extract to helpers',
        '   - **Naming** — variables/functions whose name doesn\'t match what they actually do',
        '   - **Conditionals** — nested ifs that flatten with early returns or guard clauses',
        '   - **Separation of concerns** — functions doing too many things',
        '   - **Dead code** — unused params, unreachable branches, commented-out code',
        '3. For EACH suggestion:',
        '   - Show the BEFORE snippet (real code, not pseudo)',
        '   - Show the AFTER snippet (what it would look like)',
        '   - One-line rationale',
        '4. Do NOT apply edits. End with: "Want me to apply any of these? Pick a number (e.g. 1, 3) or `all`."',
        '',
        'No generic best-practice lectures. If a piece of code is already clean, say so and stop.'
      ].join('\n');
      ctx.queuePrompt(prompt);
      return c.dim(`${glyph.spark} analyzing ${c.accent(target)} for refactor opportunities`);
    }
  },
  {
    name: 'test',
    description: 'Generate tests for a target file or function — /test src/foo.ts or /test parseUser',
    async run(args, ctx) {
      if (!ctx.queuePrompt) {
        return c.dim('(/test must run inside the REPL — not available in one-shot mode)');
      }
      const target = args.trim();
      if (!target) return c.red('usage: /test <file path or function name>');
      const prompt = [
        `Generate tests for: ${target}`,
        '',
        '1. Read the target (file path → read_file; symbol name → grep + read).',
        '2. Detect the test framework from the project manifest (package.json scripts, *.csproj test sdk, pyproject.toml, etc.). Common ones: jest, vitest, mocha, xunit, pytest, go test, cargo test.',
        '3. Identify test cases to cover:',
        '   - **Happy path** — typical valid input',
        '   - **Edge cases** — empty / null / undefined / max size / boundary values',
        '   - **Error paths** — invalid input, exception throws, error states',
        '4. Write the test file in the project\'s conventional location (e.g. `__tests__/`, `*.test.ts`, `test_*.py`, `*Tests.cs`). Use `write_file`.',
        '5. After writing, run the test command and report results.',
        '',
        'Match the project\'s existing test style. Don\'t introduce a new framework or pattern. If existing tests use a specific helper / fixture pattern, follow it.'
      ].join('\n');
      ctx.queuePrompt(prompt);
      return c.dim(`${glyph.spark} generating tests for ${c.accent(target)}`);
    }
  },
  {
    name: 'explain',
    description: 'Walk through a file or function in plain English — /explain src/auth.ts or /explain handleLogin',
    async run(args, ctx) {
      if (!ctx.queuePrompt) {
        return c.dim('(/explain must run inside the REPL — not available in one-shot mode)');
      }
      const target = args.trim();
      if (!target) return c.red('usage: /explain <file path or function name>');
      const prompt = [
        `Explain: ${target}`,
        '',
        '1. Read the target (file path or symbol name — grep + read if symbol).',
        '2. Walk through it in plain English with this structure:',
        '   - **What it does** — one-paragraph high-level summary',
        '   - **Why it exists** — what problem it solves, what calls it',
        '   - **How it does it** — the actual logic flow, citing `file:line` for key steps',
        '   - **Non-obvious patterns** — anything subtle (regex tricks, race conditions handled, perf optimizations, gotchas)',
        '3. Tone: a senior engineer explaining to a smart new hire. Concrete, no buzzwords.',
        '',
        'No "this function takes X and returns Y" — that\'s obvious from the signature. Focus on intent and the parts that aren\'t self-evident.'
      ].join('\n');
      ctx.queuePrompt(prompt);
      return c.dim(`${glyph.spark} reading ${c.accent(target)} — walk-through coming`);
    }
  },
  {
    name: 'onboard',
    description: 'Generate a setup guide for a new developer joining this repo',
    async run(_args, ctx) {
      if (!ctx.queuePrompt) {
        return c.dim('(/onboard must run inside the REPL — not available in one-shot mode)');
      }
      const prompt = [
        'Generate an onboarding checklist for a new developer joining this project.',
        '',
        '1. Read the README, the project manifest, any CONTRIBUTING.md, and `.env.example` if present.',
        '2. Output a numbered checklist with this structure:',
        '   - **Prerequisites** — required runtimes (Node version, Python version, Docker, etc.) with how to verify each',
        '   - **Setup** — clone command, dependency install, env configuration steps',
        '   - **Run** — dev server, tests, lint, build commands',
        '   - **Workflow** — branch model, commit format, PR process (only if obvious from repo state)',
        '   - **Gotchas** — known footguns specific to this repo (e.g. "must run migrations before tests")',
        '3. Each item should be a single command or a 1-line action — no walls of prose.',
        '',
        'Format the output as Markdown so the user can paste it directly into a Notion page or onboarding doc.'
      ].join('\n');
      ctx.queuePrompt(prompt);
      return c.dim(`${glyph.spark} drafting onboarding guide — agent will scan setup files`);
    }
  },
  {
    name: 'changelog',
    description: 'Generate Markdown release notes from recent commits',
    async run(args, ctx) {
      if (!ctx.queuePrompt) {
        return c.dim('(/changelog must run inside the REPL — not available in one-shot mode)');
      }
      const range = args.trim();
      const prompt = [
        'Generate release notes from the recent commit history.',
        '',
        range
          ? `1. Run \`git log --oneline ${range}\` to get the commit range the user specified.`
          : '1. Run `git describe --tags --abbrev=0` to find the most recent tag. Then `git log --oneline <tag>..HEAD`. If no tags exist, fall back to `git log --oneline -50`.',
        '2. Group commits by conventional-commit type:',
        '   - **Features** (feat:)',
        '   - **Fixes** (fix:)',
        '   - **Improvements** (refactor:, perf:)',
        '   - **Docs** (docs:)',
        '   - **Other** (everything else, except merge commits)',
        '3. Skip merge commits, version-bump-only commits, and noisy chores (e.g. `chore: update deps`).',
        '4. For each commit, the entry should be the subject line (de-prefixed of the type) — punchy, one line, past tense if it isn\'t already.',
        '5. Output as Markdown, ready to paste into a CHANGELOG or GitHub release. Title it with the next version (read the project manifest to suggest one).',
        '',
        'Do NOT write the file — just print the Markdown. The user will paste it where it belongs.'
      ].join('\n');
      ctx.queuePrompt(prompt);
      return c.dim(`${glyph.spark} drafting release notes from git log`);
    }
  },
  {
    name: 'usage',
    description: 'Show Bandit cloud usage — /usage (full), /usage session, /usage weekly, /usage check (one-liner)',
    async run(args, ctx) {
      const arg = args.trim().toLowerCase();
      const cfg = ctx.getConfig();
      if (cfg.provider !== 'bandit') {
        return c.dim('(/usage is cloud-only — current provider is ' + cfg.provider + ')');
      }
      if (!cfg.apiKey) {
        return c.red('No API key set — use --api-key, BANDIT_API_KEY, or ~/.bandit/config.json');
      }
      // Derive the account endpoint from the configured completions URL
      // (apiUrl is e.g. https://api.burtson.ai/completions). Falling
      // back to the canonical host when apiUrl is unset or custom.
      const base = (() => {
        if (!cfg.apiUrl) return 'https://api.burtson.ai';
        try {
          const u = new URL(cfg.apiUrl);
          return `${u.protocol}//${u.host}`;
        } catch {
          return 'https://api.burtson.ai';
        }
      })();
      const endpoint = `${base}/api/stealth/account/usage`;
      process.stdout.write(c.dim('fetching usage…\n'));
      try {
        const res = await fetch(endpoint, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`
          }
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return c.red(`Usage fetch failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 180)}` : ''}`);
        }
        const snapshot = await res.json() as {
          authMethod?: string;
          email?: string;
          plan?: string;
          isAdmin?: boolean;
          session?: { used: number; limit: number; resetsAtUnix?: number };
          weekly?: { used: number; limit: number; resetsAtUnix?: number };
        };

        const fmtCountdown = (resetsAtUnix?: number): string => {
          if (!resetsAtUnix) return '—';
          const diff = resetsAtUnix - Math.floor(Date.now() / 1000);
          if (diff <= 0) return 'any moment';
          const hours = Math.floor(diff / 3600);
          const minutes = Math.floor((diff % 3600) / 60);
          if (hours >= 24) {
            const days = Math.floor(hours / 24);
            return `${days}d ${hours % 24}h`;
          }
          if (hours >= 1) return `${hours}h ${minutes}m`;
          return `${Math.max(1, minutes)}m`;
        };

        const bar = (used: number, limit: number, width = 24): string => {
          const safeLimit = Math.max(1, limit);
          const pct = Math.max(0, Math.min(1, used / safeLimit));
          const filled = Math.round(pct * width);
          const empty = width - filled;
          const color = pct >= 0.9 ? c.red : pct >= 0.7 ? c.yellow : c.green;
          return `${color('█'.repeat(filled))}${c.dim('░'.repeat(empty))}`;
        };

        // Compact one-liner: "/usage check" — quick "where am I?"
        // glance without the full card. Also flags any window that's
        // ≥ 90% full so the user sees a yellow/red warning at a glance.
        if (arg === 'check') {
          const segs: string[] = [];
          let warn = false;
          if (snapshot.session) {
            const pct = snapshot.session.limit > 0
              ? Math.round((snapshot.session.used / snapshot.session.limit) * 100)
              : 0;
            const tone = pct >= 90 ? c.red : pct >= 70 ? c.yellow : c.green;
            if (pct >= 90) warn = true;
            segs.push(`session ${tone(`${snapshot.session.used}/${snapshot.session.limit} (${pct}%)`)} · resets in ${fmtCountdown(snapshot.session.resetsAtUnix)}`);
          }
          if (snapshot.weekly) {
            const pct = snapshot.weekly.limit > 0
              ? Math.round((snapshot.weekly.used / snapshot.weekly.limit) * 100)
              : 0;
            const tone = pct >= 90 ? c.red : pct >= 70 ? c.yellow : c.green;
            if (pct >= 90) warn = true;
            segs.push(`weekly ${tone(`${snapshot.weekly.used}/${snapshot.weekly.limit} (${pct}%)`)} · resets in ${fmtCountdown(snapshot.weekly.resetsAtUnix)}`);
          }
          const tail = warn ? c.red('  ⚠ at least one window ≥ 90%') : c.green('  ✓ within limits');
          return segs.join('\n  ') + '\n' + tail;
        }

        // Single-window views — "session" / "weekly".
        if (arg === 'session' || arg === 'weekly') {
          const window = arg === 'session' ? snapshot.session : snapshot.weekly;
          const label = arg === 'session' ? '5-hour session' : 'Weekly window';
          if (!window) {
            return c.dim(`(no ${arg} data returned by the gateway)`);
          }
          const { used, limit, resetsAtUnix } = window;
          const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
          return [
            c.bold(label),
            '',
            `  ${bar(used, limit)}  ${used}/${limit} (${pct}%)`,
            `  ${c.dim('resets in ' + fmtCountdown(resetsAtUnix))}`
          ].join('\n');
        }

        // No-args / anything else → full card.
        const lines: string[] = [];
        lines.push(c.bold('Account & Usage'));
        lines.push('');
        lines.push(`  ${c.dim('auth     ')} ${snapshot.authMethod ?? 'Burtson.ai API Key'}`);
        if (snapshot.email) lines.push(`  ${c.dim('email    ')} ${snapshot.email}`);
        lines.push(`  ${c.dim('plan     ')} ${c.accent(snapshot.plan ?? 'free')}`);
        lines.push('');
        if (snapshot.session) {
          const { used, limit, resetsAtUnix } = snapshot.session;
          lines.push(`  ${c.bold('5-hour session')}  ${bar(used, limit)}  ${used}/${limit}`);
          lines.push(`  ${c.dim('resets in ' + fmtCountdown(resetsAtUnix))}`);
          lines.push('');
        }
        if (snapshot.weekly) {
          const { used, limit, resetsAtUnix } = snapshot.weekly;
          lines.push(`  ${c.bold('Weekly window ')}  ${bar(used, limit)}  ${used}/${limit}`);
          lines.push(`  ${c.dim('resets in ' + fmtCountdown(resetsAtUnix))}`);
          lines.push('');
        }
        lines.push(c.dim('  Tip: /usage session, /usage weekly, /usage check'));
        lines.push(c.dim('  Need a higher limit? Email team@burtson.ai to upgrade.'));
        return lines.join('\n');
      } catch (err) {
        return c.red(`Usage fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  },
  {
    name: 'update',
    description: 'Check for and (with --apply) install an update to bandit-stealth-cli',
    async run(args, ctx) {
      // Current version — bundled package.json sits next to dist/cli.js at
      // publish time, so this resolves identically whether the CLI is
      // installed globally or run from a `pnpm link` dev copy.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const current = (require('../package.json') as { version: string }).version;
      const apply = /\b(--apply|-y|now)\b/.test(args.trim());
      process.stdout.write(c.dim('checking registry…\n'));
      const latest = await fetchLatestVersion();
      if (!latest) {
        return [
          c.yellow(`${glyph.warn} Could not reach the registry.`),
          c.dim(`Check your ~/.npmrc has a token with read:packages scope, then run:`),
          `  ${c.cyan('npm view ' + REGISTRY_PACKAGE + ' version')}`,
          c.dim('to confirm connectivity.')
        ].join('\n');
      }
      const cmp = semverCompare(current, latest);
      if (cmp === 0) {
        return `${c.green(glyph.check)} Up to date — ${c.accent(PACKAGE_NAME)}@${c.bold(current)} is the latest.`;
      }
      if (cmp > 0) {
        return [
          c.dim(`You're on ${c.bold(current)}, registry latest is ${c.bold(latest)}.`),
          c.dim('This probably means you are running a local dev build. Nothing to do.')
        ].join('\n');
      }
      // cmp < 0: update available. Without --apply we just print the
      // command — guarded against accidental local installs (a `npm i`
      // without `-g` from a non-package directory creates a node_modules
      // tree wherever the user ran bandit and leaves the global shim
      // pointing at the old version).
      if (!apply) {
        return [
          `${c.accent(glyph.spark)} Update available: ${c.bold(current)} → ${c.bold(latest)}`,
          '',
          c.dim('Install now without leaving the REPL:'),
          `  ${c.cyan('/update --apply')}   ${c.dim('(runs ' + c.cyan('npm i -g ' + PACKAGE_NAME) + ' for you, then exits)')}`,
          '',
          c.dim('Or do it manually — exit the REPL, then run one of:'),
          `  ${c.cyan('npm i -g ' + PACKAGE_NAME)}`,
          `  ${c.cyan('pnpm add -g ' + PACKAGE_NAME)}`,
          c.dim('(must include ') + c.cyan('-g') + c.dim(' or it installs locally and the global ') + c.cyan('bandit') + c.dim(' shim stays on the old version.)'),
          '',
          c.dim('Or see what changed:'),
          `  ${c.cyan('npm view ' + REGISTRY_PACKAGE + ' versions --json')}`
        ].join('\n');
      }
      // --apply path: run the global install ourselves so the user can't
      // forget the -g flag. We exit the REPL afterwards because the
      // currently-running process is still pinned to the old dist/cli.js
      // — the next `bandit` invocation picks up the new binary.
      process.stdout.write(c.dim('Running ') + c.cyan('npm i -g ' + PACKAGE_NAME) + c.dim(' …\n'));
      const result = await new Promise<{ code: number | null; err?: string }>((resolve) => {
        const proc = cp.spawn('npm', ['i', '-g', PACKAGE_NAME], {
          shell: false,
          stdio: ['ignore', 'inherit', 'inherit']
        });
        proc.on('close', (code) => resolve({ code }));
        proc.on('error', (err) => resolve({ code: null, err: err.message }));
      });
      if (result.code === 0) {
        process.stdout.write([
          '',
          `${c.green(glyph.check)} Installed ${c.bold(latest)}. Exiting — relaunch with ${c.cyan('bandit')} to use it.`
        ].join('\n') + '\n');
        ctx.exit();
        return '';
      }
      return [
        c.red(`${glyph.warn} Install failed${result.err ? `: ${result.err}` : ` (npm exited ${result.code})`}.`),
        c.dim('Run it manually from your shell:'),
        `  ${c.cyan('npm i -g ' + PACKAGE_NAME)}`
      ].join('\n');
    }
  },
  {
    name: 'exit',
    description: 'Exit the REPL',
    run(_args, ctx) {
      ctx.exit();
      return '';
    }
  },
  {
    name: 'quit',
    description: 'Alias for /exit',
    run(_args, ctx) {
      ctx.exit();
      return '';
    }
  }
];

export function findSlashCommand(line: string): { cmd: SlashCommand; args: string } | null {
  if (!line.startsWith('/')) return null;
  const space = line.indexOf(' ');
  const name = (space === -1 ? line.slice(1) : line.slice(1, space)).toLowerCase();
  const args = space === -1 ? '' : line.slice(space + 1);
  const cmd = slashCommands.find(c => c.name === name);
  return cmd ? { cmd, args } : null;
}

/**
 * `bandit runner` — the local half of remote control.
 *
 * Two modes:
 *   --dry-run "<prompt>"   Run ONE task locally, right now, printing the event
 *                          stream. No gateway, no cloud — proves the plan-mode
 *                          loop end to end and is useful on its own.
 *   (default)              Connect to the Bandit cloud gateway as a device and
 *                          execute tasks assigned from Bandit Stealth Web. Needs
 *                          a signed-in cloud account and the gateway's runner
 *                          endpoints (inbox + event ingest).
 *
 * SAFETY: tasks default to plan mode (read-only). The agent investigates and
 * proposes; it does not silently edit the user's machine. See planModeGate.ts.
 */
import * as os from 'node:os';
import { createDefaultLanguageAdapters, type ChatFn } from '@burtson-labs/agent-core';
import { getModelCapabilities } from '@burtson-labs/stealth-core-runtime';
import { c, glyph } from '../ansi';
import { loadConfigFiles, resolveConfig } from '../config';
import { CliToolExecutionContext } from '../cliToolContext';
import { buildCliChatFn } from '../agent/cliChatFn';
import { RemoteRunner } from './engine';
import { HttpRunnerGateway } from './httpGateway';
import { RUNNER_PROTOCOL_VERSION, type RemoteRunMode, type RunnerEvent, type RunnerGateway } from './contract';

const DEFAULT_GATEWAY = 'https://api.burtson.ai';
const VALID_MODES: RemoteRunMode[] = ['plan', 'ask', 'auto'];

interface RunnerFlags {
  dryRunPrompt?: string;
  mode: RemoteRunMode;
  gateway?: string;
  help?: boolean;
}

function parseFlags(argv: string[]): RunnerFlags {
  const flags: RunnerFlags = { mode: 'plan' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-d') flags.dryRunPrompt = argv[++i];
    else if (a === '--mode' || a === '-m') {
      const m = argv[++i];
      if (VALID_MODES.includes(m as RemoteRunMode)) flags.mode = m as RemoteRunMode;
    } else if (a === '--gateway' || a === '-g') flags.gateway = argv[++i];
    else if (a === '--help' || a === '-h') flags.help = true;
  }
  return flags;
}

function printHelp(): void {
  process.stdout.write(
    `${c.bold('bandit runner')} — run tasks driven remotely from Bandit Stealth Web\n\n` +
    `  bandit runner --dry-run "<prompt>"   Run one task locally now and print the events\n` +
    `  bandit runner                         Connect as a device and wait for assigned tasks\n\n` +
    `Options:\n` +
    `  -d, --dry-run <prompt>   Local, gateway-free plan-mode run (great for trying it out)\n` +
    `  -m, --mode <plan|auto>   Permission mode for tasks (default: plan — read-only)\n` +
    `  -g, --gateway <url>      Gateway base URL (default: ${DEFAULT_GATEWAY})\n\n` +
    `${c.dim('Remote tasks default to PLAN MODE: Bandit reads and proposes, it does not edit')}\n` +
    `${c.dim('your machine unattended. Destructive calls are always refused.')}\n`
  );
}

/** A RunnerGateway that just prints events — powers --dry-run (no network). */
class PrintGateway implements RunnerGateway {
  // eslint-disable-next-line require-yield
  async *inbox(): AsyncIterable<never> { return; }
  async publish(_taskId: string, event: RunnerEvent): Promise<void> {
    process.stdout.write(formatEvent(event) + '\n');
  }
}

function formatEvent(e: RunnerEvent): string {
  switch (e.type) {
    case 'turn.started':
      return c.dim(`  ${glyph.spark} started · ${e.mode} mode`);
    case 'tool.call':
      return `  ${c.gray(glyph.arrow)} ${c.cyan(e.tool)}${e.params.path ? c.dim(' ' + e.params.path) : e.params.cmd ? c.dim(' ' + e.params.cmd) : ''}`;
    case 'tool.result':
      return c.dim(`    ${e.ok ? glyph.check : glyph.cross} ${e.tool}${e.summary ? ' — ' + e.summary.split('\n')[0].slice(0, 80) : ''}`);
    case 'tool.blocked':
      return c.blue(`    ◆ blocked: ${e.tool}`) + c.dim(` — ${e.reason.split('.')[0]}`);
    case 'artifact.changed':
      return c.dim(`    ${glyph.check} ${e.kind} ${e.path}`);
    case 'assistant.delta':
      return '\n' + e.text + '\n';
    case 'turn.completed':
      return c.dim(`  ${glyph.check} completed · ${e.artifacts} change(s)${e.noChangeReason ? ' — ' + e.noChangeReason : ''}`);
    case 'turn.error':
      return c.red(`  ${glyph.cross} error [${e.code}] ${e.message}`);
  }
}

/** Stable-per-machine device id + label. */
function deviceIdentity(): { deviceId: string; deviceLabel: string } {
  const host = os.hostname() || 'device';
  return { deviceId: `cli-${host}`, deviceLabel: host };
}

export async function runRunnerCommand(argv: string[], cwd: string): Promise<void> {
  const flags = parseFlags(argv);
  if (flags.help) return printHelp();

  // Resolve the SAME provider/model bundle the REPL uses, then build the chat.
  // Dynamic import of buildProviderSettings avoids a static cli.ts ↔ runner cycle.
  const fileConfig = await loadConfigFiles(cwd);
  const resolved = resolveConfig(fileConfig, {});
  const { buildProviderSettings } = await import('../cli');
  const { settings, model } = buildProviderSettings(resolved);
  // Match the REPL's tool-calling wiring: cloud/tool-capable models call tools
  // through the provider's native tools field; without this they ignore the
  // injected text-tool block and just chat ("I can't see your files").
  const modelCaps = getModelCapabilities(model);
  const nativeTools = (settings.kind === 'ollama' || settings.kind === 'bandit' || settings.kind === 'openai-compatible')
    && modelCaps.supportsToolCalling;
  const compactToolBlock = modelCaps.tier === 'small';
  const contextFactory = (root: string): CliToolExecutionContext =>
    new CliToolExecutionContext(root, createDefaultLanguageAdapters());
  const chatFactory = (): Promise<ChatFn> =>
    buildCliChatFn({ settings, model, pendingImages: undefined, getThink: () => undefined });

  // --- Local dry run: prove the plan-mode loop with no gateway. ---
  if (flags.dryRunPrompt) {
    process.stdout.write(c.dim(`  running one task in ${flags.mode} mode against ${cwd}\n`));
    const runner = new RemoteRunner({
      gateway: new PrintGateway(), workspaceRoot: cwd, chatFactory, contextFactory,
      defaultMode: flags.mode, nativeTools, compactToolBlock
    });
    await runner.runTask({ protocol: RUNNER_PROTOCOL_VERSION, taskId: 'dry-run', prompt: flags.dryRunPrompt, mode: flags.mode });
    return;
  }

  // --- Connected mode: register as a device and wait for tasks. ---
  const token = resolved.apiKey;
  const baseUrl = (flags.gateway ?? process.env.BANDIT_GATEWAY_URL ?? resolved.apiUrl ?? DEFAULT_GATEWAY).replace(/\/$/, '');
  if (!token) {
    process.stderr.write(
      c.yellow(`  ${glyph.warn} Remote control needs a signed-in Bandit cloud account.\n`) +
      c.dim(`     Run ${c.cyan('bandit login')} (or set a key), then ${c.cyan('bandit runner')} again.\n`) +
      c.dim(`     To try plan-mode execution locally right now: ${c.cyan('bandit runner --dry-run "your task"')}\n`)
    );
    return;
  }

  const { deviceId, deviceLabel } = deviceIdentity();

  // Preflight the inbox so we fail loud instead of silently backing off forever
  // if the gateway's runner endpoints aren't deployed yet.
  const preflight = await probeInbox(baseUrl, token, deviceId);
  if (!preflight.ok) {
    process.stderr.write(
      c.yellow(`  ${glyph.warn} Couldn't reach the runner inbox at ${baseUrl} (${preflight.detail}).\n`) +
      c.dim(`     This is the client half of remote control — the gateway's runner endpoints\n`) +
      c.dim(`     (GET /api/stealth/runner/inbox + POST /api/stealth/tasks/{id}/events) must be live.\n`) +
      c.dim(`     Plan-mode execution works locally today: ${c.cyan('bandit runner --dry-run "your task"')}\n`)
    );
    return;
  }

  const gateway = new HttpRunnerGateway({ baseUrl, token, deviceId, deviceLabel });
  const runner = new RemoteRunner({
    gateway, workspaceRoot: cwd, chatFactory, contextFactory, defaultMode: flags.mode,
    nativeTools, compactToolBlock,
    onStatus: (m) => process.stderr.write(c.dim(`  · ${m}\n`))
  });

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  process.stdout.write(
    `${c.bold('Bandit runner online')} — device ${c.cyan(deviceLabel)}, ${flags.mode} mode\n` +
    c.dim(`  Waiting for tasks from Bandit Stealth Web. Ctrl+C to stop.\n`)
  );
  await runner.run(controller.signal);
}

async function probeInbox(baseUrl: string, token: string, deviceId: string): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${baseUrl}/api/stealth/runner/inbox`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, 'x-bandit-device-id': deviceId, accept: 'text/event-stream' },
      signal: controller.signal
    });
    // A live stream returns 200 + text/event-stream; anything else is not ready.
    if (res.ok && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      // Close the probe stream immediately; the real run reopens it.
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { ok: true, detail: 'connected' };
    }
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

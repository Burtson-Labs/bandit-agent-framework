/**
 * RemoteRunner — the local half of remote control.
 *
 * It subscribes to the gateway inbox, and for each task assigned to this
 * device runs the SAME tool-use loop the CLI runs — against the local
 * workspace — under a permission gate (plan mode by default), streaming the
 * event vocabulary the gateway already relays to Bandit Stealth Web.
 *
 * Everything external is injected (the gateway transport, the chat function,
 * the tool-execution context, the registry) so the engine is pure and testable
 * with an in-memory fake gateway + a deterministic chat.
 */
import {
  createCoreToolRegistry,
  createToolUseLoop,
  type ChatFn,
  type ToolExecutionContext
} from '@burtson-labs/agent-core';
import { createPlanModeGate } from './planModeGate';
import {
  RUNNER_PROTOCOL_VERSION,
  type RemoteRunMode,
  type RemoteTask,
  type RunnerEvent,
  type RunnerGateway
} from './contract';

const RUNNER_VERSION = '1.0.0';

/** Tools that, when they succeed, changed a file on disk. */
const EDIT_TOOLS = new Set(['write_file', 'apply_edit', 'replace_range', 'apply_patch', 'delete_file']);

function remoteSystemPrompt(mode: RemoteRunMode): string {
  // Lead with tool reality: driven remotely, the model has NO chat affordance
  // to ask for a paste, and its instinct is to say "I can't see your files".
  // It CAN — through its tools — so say so first and unambiguously, the same
  // way the cloud runner's prompt does.
  const base =
    'You are Bandit, an agent running ON the user\'s machine, driven remotely from another device. '
    + 'You HAVE tools that operate on this machine\'s real files right now: read_file, list_files, '
    + 'search_code, find_directory, and read-only shell via run_command (git diff/status/log, ls, grep). '
    + 'USE them to do the work. NEVER say you lack file-system access or ask the user to paste a file — '
    + 'you have direct access through your tools. The user is not at this machine; they watch your '
    + 'progress from a web app and review what you produce.';
  if (mode === 'plan') {
    return `${base}\n\nYou are in PLAN MODE (read-only). Read and search freely to understand the task. Every edit, write, state-changing command, delete, and network-write is BLOCKED and will be refused — do not attempt them. Once you've investigated with your tools, present a concise, concrete plan: the exact files you would change, the edits you would make, and the commands you would run. Then stop.`;
  }
  return `${base}\n\nAct decisively — keep changes minimal, correct, and consistent with the surrounding code. Anything destructive or irreversible is refused (nobody is here to approve it); when a call is blocked, describe what you would do instead of retrying.`;
}

export interface RemoteRunnerOptions {
  gateway: RunnerGateway;
  workspaceRoot: string;
  /** Fresh ChatFn per task (provider/model/auth). */
  chatFactory: () => Promise<ChatFn> | ChatFn;
  /** Tool-execution context rooted at the workspace. */
  contextFactory: (workspaceRoot: string) => ToolExecutionContext;
  /** Mode when a task omits one. Defaults to 'plan' — the safe default. */
  defaultMode?: RemoteRunMode;
  /** Registry factory — defaults to the core tool set. Injectable for tests. */
  registryFactory?: () => ReturnType<typeof createCoreToolRegistry>;
  /** Route tool calls through the provider's NATIVE tools field rather than the
   *  injected text-tool block. Cloud/tool-capable models ignore the text block
   *  and chat instead ("I can't see your files"); native tool-calling is what
   *  makes them act. The command derives this from the model's capabilities the
   *  same way the REPL does. Default false (text tools) for the test path. */
  nativeTools?: boolean;
  /** Use the compact text-tool block (small-tier models). No effect when
   *  nativeTools is true. */
  compactToolBlock?: boolean;
  /** Optional status sink for the runner's own logs (not task events). */
  onStatus?: (message: string) => void;
}

export class RemoteRunner {
  constructor(private readonly opts: RemoteRunnerOptions) {}

  /** Consume the inbox until `signal` aborts. One task's failure never stops
   *  the runner — it's reported as a `turn.error` and the loop continues. */
  async run(signal: AbortSignal): Promise<void> {
    this.opts.onStatus?.('runner online — waiting for tasks');
    for await (const task of this.opts.gateway.inbox(signal)) {
      if (signal.aborted) break;
      try {
        await this.runTask(task);
      } catch (err) {
        await this.safePublish(task.taskId, {
          type: 'turn.error',
          taskId: task.taskId,
          code: 'RUNNER_ERROR',
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
    this.opts.onStatus?.('runner stopped');
  }

  /** Run a single task through the loop under its permission gate, streaming
   *  events. Exposed so callers (and `--dry-run`) can run one task directly. */
  async runTask(task: RemoteTask): Promise<void> {
    const { taskId } = task;
    const mode = task.mode ?? this.opts.defaultMode ?? 'plan';
    this.opts.onStatus?.(`task ${taskId} — ${mode} mode`);

    // Ordered event pipe: emitEvent fires synchronously from the loop, but
    // publishing is async. Chain publishes so they leave in order, then await
    // the chain before returning so turn.completed/error is fully flushed.
    let chain: Promise<void> = Promise.resolve();
    const emit = (event: RunnerEvent): void => {
      chain = chain.then(() => this.safePublish(taskId, event));
    };

    emit({ type: 'turn.started', taskId, protocol: RUNNER_PROTOCOL_VERSION, runnerVersion: RUNNER_VERSION, mode });

    let artifacts = 0;
    // Params of the most recent call per tool, so a later artifact/blocked
    // event can name the path the model targeted.
    const lastParams = new Map<string, Record<string, string>>();

    const registry = (this.opts.registryFactory ?? createCoreToolRegistry)();
    const ctx = this.opts.contextFactory(this.opts.workspaceRoot);
    const gate = createPlanModeGate(mode, this.opts.workspaceRoot);

    const loop = createToolUseLoop(registry, ctx, {
      maxIterations: task.maxIterations ?? 12,
      beforeToolExecute: gate,
      nativeTools: this.opts.nativeTools ?? false,
      nativeToolFailureFallback: true,
      compactToolBlock: this.opts.compactToolBlock ?? false,
      emitEvent: (type, payload) => {
        const p = (payload ?? {}) as Record<string, unknown>;
        const tool = String(p.name ?? 'unknown');
        if (type === 'tool_loop:tool_execute') {
          const params = (p.params as Record<string, string>) ?? {};
          lastParams.set(tool, params);
          emit({ type: 'tool.call', taskId, tool, params });
        } else if (type === 'tool_loop:tool_blocked') {
          emit({ type: 'tool.blocked', taskId, tool, reason: String(p.reason ?? 'blocked') });
        } else if (type === 'tool_loop:tool_result') {
          const ok = !p.isError;
          emit({ type: 'tool.result', taskId, tool, ok, summary: String(p.outputSnippet ?? '').slice(0, 400) });
          if (ok && EDIT_TOOLS.has(tool)) {
            artifacts += 1;
            const path = lastParams.get(tool)?.path ?? '';
            if (path) {
              emit({ type: 'artifact.changed', taskId, path, kind: tool === 'delete_file' ? 'deleted' : 'modified' });
            }
          }
        } else if (type === 'tool_loop:tool_error') {
          emit({ type: 'tool.result', taskId, tool, ok: false, summary: String(p.error ?? p.message ?? 'tool error').slice(0, 400) });
        }
      }
    });

    try {
      const chat = await this.opts.chatFactory();
      const result = await loop.run(task.prompt, chat, remoteSystemPrompt(mode));
      emit({ type: 'assistant.delta', taskId, text: result.finalResponse });
      emit({
        type: 'turn.completed',
        taskId,
        artifacts,
        noChangeReason: artifacts === 0
          ? (result.hitLimit
              ? 'Iteration limit reached before any change was proposed.'
              : mode === 'plan'
                ? 'Plan mode is read-only — presented a plan without changing files.'
                : 'Answered without needing to change files.')
          : undefined,
        assistantText: result.finalResponse
      });
    } catch (err) {
      emit({
        type: 'turn.error',
        taskId,
        code: 'TURN_FAILED',
        message: err instanceof Error ? err.message : String(err)
      });
    }

    // Flush every queued publish before returning so the terminal event lands.
    await chain;
  }

  private async safePublish(taskId: string, event: RunnerEvent): Promise<void> {
    try {
      await this.opts.gateway.publish(taskId, event);
    } catch (err) {
      // A dropped event must never crash the runner. Surface it to the status
      // sink so a persistently failing gateway is visible.
      this.opts.onStatus?.(`publish failed (${event.type}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

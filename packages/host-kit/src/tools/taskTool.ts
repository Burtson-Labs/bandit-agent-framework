/**
 * Task tool — spawns a focused subagent to investigate a scoped question or
 * complete a bounded task without polluting the parent conversation.
 *
 * The subagent runs its own ToolUseLoop with:
 * - A scoped system prompt (focused on the stated goal, asked for a synopsis)
 * - Its own iteration budget (default 6, separate from the parent's)
 * - Access to the parent's tools EXCEPT `task` itself (no recursion)
 * - The parent's beforeToolExecute gate (so PreToolUse hooks still apply)
 *
 * The subagent's final response is returned as the tool result. The parent
 * model sees only the synopsis — not the subagent's intermediate tool calls.
 */

import {
  ToolUseLoop,
  ToolRegistry,
  type AgentTool,
  type ChatFn,
  type ToolExecutionContext,
  type ToolResult,
  type ToolUseLoopOptions
} from '@burtson-labs/agent-core';
import type { BackgroundTaskStore } from '../backgroundTasks';

type SubagentLoopOptions = Pick<
  ToolUseLoopOptions,
  'nativeTools' | 'nativeToolFailureFallback' | 'messageTokenBudget' | 'maxParallelTools' | 'maxTotalTools' | 'outputBudgetTokens' | 'outputBudgetRatio'
>;

function resolveSubagentLoopOptions(
  value: TaskToolOptions['subagentLoopOptions']
): SubagentLoopOptions {
  const resolved = typeof value === 'function' ? value() : value;
  return resolved ?? {};
}

/**
 * Strip reasoning fences (```bandit-reasoning … ``` and <think>…</think>)
 * from the subagent's final response so the synopsis the parent sees is
 * the actual analysis, not the model's internal monologue. Observed
 * 2026-05-06: subagents that stalled in reasoning without ever calling a
 * tool returned a `finalResponse` that was JUST the reasoning fence, and
 * the chat card in the IDE rendered "I need to actually emit tool calls.
 * Let me start by reading the package.json…" as the synopsis — looked
 * like the subagent had thoughts but hadn't shipped them. Now we strip
 * the fences first; if nothing useful remains, we surface that as a
 * "subagent stalled in reasoning" error instead of pretending we got an
 * answer.
 */
function sanitizeSubagentSynopsis(raw: string): string {
  return raw
    .replace(/```bandit-reasoning\b[\s\S]*?```/gi, '')
    .replace(/```bandit-reasoning\b[\s\S]*$/i, '')
    .replace(/<think\b[\s\S]*?<\/think\s*>/gi, '')
    .replace(/<think\b[\s\S]*$/i, '')
    .trim();
}

export interface TaskToolOptions {
  /** Streaming chat function — same signature as the parent loop uses. */
  chat: ChatFn;
  /** The parent's tool registry. Subagent gets a copy minus `task` itself. */
  parentRegistry: ToolRegistry;
  /** Execution context the subagent should use (usually the parent's). */
  ctx: ToolExecutionContext;
  /** Max iterations for the subagent. Default: 6. */
  maxIterations?: number;
  /** Optional hook gate — typically forwarded from the parent. */
  beforeToolExecute?: ToolUseLoopOptions['beforeToolExecute'];
  /** Called with every subagent event. Hosts can display progress inline. */
  onEvent?: (type: string, payload?: unknown) => void;
  /**
   * Optional background-task store. When present, the agent can pass
   * `run_in_background: true` to the `task` tool and the subagent runs
   * detached — the tool returns a task id immediately and the subagent
   * eventually pushes its synopsis through this store. Hosts that don't
   * supply a store get the legacy synchronous behaviour only.
   */
  backgroundStore?: BackgroundTaskStore;
  /**
   * Resolves the parent's full system prompt at subagent-spawn time.
   * When provided, the subagent inherits this prompt verbatim and a
   * thin scope wrapper is appended. This eliminates the dual-prompt
   * drift that caused subagents to stall: the hand-rolled fallback
   * below forbade `<tool_call>` markup in prose but never showed the
   * format anywhere, so the model would close its reasoning fence and
   * never emit a tool call (confirmed via diagnostic traces 2026-05-08
   * across 8 subagents — `hasToolCallMarkup: false` on every retry).
   *
   * Accepts string OR getter so callers can register the task tool
   * BEFORE per-turn prompt construction completes; the getter is
   * resolved when the subagent actually spawns.
   *
   * Falls back to the legacy SUBAGENT_PROMPT_FALLBACK when not set.
   */
  parentSystemPrompt?: string | (() => string | undefined);
  /**
   * Parent loop tuning that should carry into spawned subagents.
   * Critical for native-tool models such as bandit-logic/Qwen: without
   * `nativeTools`, the subagent gets XML prompt instructions but no
   * provider `tools` field, so the model reasons about tool calls without
   * emitting one. Keep this narrow to transport budget/protocol settings,
   * not lifecycle hooks owned by the task tool itself.
   */
  subagentLoopOptions?: SubagentLoopOptions | (() => SubagentLoopOptions | undefined);
  /**
   * Returns the parent loop's AbortSignal so subagents can honor it.
   * v1.7.338+: without this hookup, hitting Stop in the IDE aborted
   * the parent loop but background subagents kept running in their own
   * loops — backgroundStore stayed "N running" and the only way to
   * recover was to kill the extension process. With the getter wired
   * up, every spawned subagent (foreground OR background) passes the
   * parent signal as its loop's `signal`; when the parent aborts, the
   * subagent loop sees it on its next iteration check and exits
   * cleanly, the store records the task as cancelled, and the UI
   * clears.
   *
   * Getter rather than value so subagents spawned mid-turn pick up the
   * CURRENT turn's controller, not whichever one was active when the
   * tool was registered.
   */
  getParentSignal?: () => AbortSignal | undefined;
  /**
   * Maximum number of background subagents that can be running at once.
   * When the cap is hit, a `task(run_in_background)` call returns
   * immediately with a non-error result telling the model how many are
   * running and how to wait. Without this cap, the model can fan out
   * unboundedly — with 7 concurrent subagents all
   * hitting Ollama simultaneously, which starved the host's token
   * budget and left the chat card stuck on 0 iter / 0 tools.
   *
   * Defaults to 3 (a reasonable floor for parallel investigation
   * without overwhelming a local model server). Set to 0 to disable
   * the cap entirely. Foreground (synchronous) tasks ignore this cap
   * because they're already serial by construction.
   */
  maxConcurrentBackground?: number;
}

const DEFAULT_MAX_CONCURRENT_BACKGROUND = 3;

/**
 * Defensive fallback when the host doesn't pass `parentSystemPrompt`.
 *
 * Self-sufficient — works on its own without inheritance.
 * tightening: the format example is INLINE on a single line after a
 * colon (same pattern as the fix to extensionSystemPrompt.ts).
 * Putting it on its own line surrounded by whitespace triggers
 * Ollama's qwen parser as a real tool call, xml.Unmarshal hits EOF on
 * the JSON inside, and upstream returns 500. Don't reformat this.
 *
 * Why explicit + emphatic: subagents on bandit-logic 27B would
 * literally read the old prompt's "NEVER write <tool_call> markup"
 * rule and comply by closing their reasoning fence and stopping —
 * never emitting an actual tool call. The fix is to combine the
 * format example (inline, parser-safe) with explicit "your FIRST
 * response must emit one of these" framing so the model knows what
 * to do AND that it's required.
 */
const SUBAGENT_PROMPT_FALLBACK = `You are a focused coding subagent built by Burtson Labs. You have one bounded goal and the same tool registry as the parent agent (read, search, shell, write, git, todo_write) EXCEPT \`task\` — you cannot spawn further subagents.

Call tools by outputting on a single line: <tool_call>{"name": "tool_name", "params": {"key": "value"}}</tool_call>

Your FIRST response MUST contain a real tool call. Reasoning is fine — but the response must include an actual <tool_call> envelope, not just talk about one. The goal needs information you don't have; the only way to get it is via tools. Pick the most obvious starting tool (\`list_files\` for "what's in this dir", \`read_file\` for "what does X look like", \`search_code\` for "where is Y") and emit it.

When *describing* tool calls in prose (in synopsis or explanations), use words: "I called read_file with path=...". NEVER emit the literal angle-bracket markup outside an actual invocation — it breaks Ollama's qwen parser (xml.Unmarshal returns EOF on the JSON inside, upstream 500). Same rule for tool_result and think tokens: never as prose.

When the goal is complete, return a 2-6 line synopsis. No preamble. If the goal is ambiguous, make ONE reasonable interpretation and state it.`;

/**
 * Build the `task` tool. Register it on the parent agent's registry so the
 * model can delegate scoped work to a subagent.
 */
export function buildTaskTool(opts: TaskToolOptions): AgentTool {
  // Tool registry the subagent uses — same one whether the call is
  // foreground or background. Exclude `task` itself so subagents can't
  // spawn further subagents (recursion + budget blowup).
  const subRegistry = new ToolRegistry();
  for (const tool of opts.parentRegistry.getAll()) {
    if (tool.name === 'task') continue;
    subRegistry.register(tool);
  }

  const maxIterations = opts.maxIterations ?? 6;
  const emit = opts.onEvent ?? (() => undefined);

  /** Run a subagent loop and return its result. Used by both the
   * foreground and background paths so the actual run logic stays
   * in one place. The `progressEmitter` is called per-iteration with
   * the running iteration count + tool counts so the BackgroundTaskStore
   * can keep its progress fields current. */
  const runSubagent = async (
    goal: string,
    context: string | undefined,
    progressEmitter?: (info: { iterations: number; toolCalls: number; lastTool?: string }) => void,
    taskId?: string
  ) => {
    let iterations = 0;
    let toolCalls = 0;
    let lastTool: string | undefined;

    const inheritedLoopOptions = resolveSubagentLoopOptions(opts.subagentLoopOptions);
    const subagent = new ToolUseLoop(subRegistry, opts.ctx, {
      ...inheritedLoopOptions,
      maxIterations,
      beforeToolExecute: opts.beforeToolExecute,
      // Mark this loop as a subagent so the loop's iter-0-no-tool-call
      // detector can force a tool call when bandit-logic stalls in
      // reasoning. Without this, the model emits prose + reasoning on
      // iter 0 (not matching the announce-intent or narrate verb
      // patterns), the loop treats it as a final answer, and the
      // parent gets a 0-iteration "stalled in reasoning" failure.
      isSubagent: true,
      emitEvent: (type, payload) => {
        // Track progress fields that hosts care about — iteration count,
        // tool-call count, last tool name. Cheap counters, not the full
        // event log; the latter would be too noisy for the status display
        // that the agent / user actually look at.
        //
        // the loop never emits `iteration:start`. The
        // canonical per-iteration marker is `tool_loop:llm_start`,
        // whose payload carries the loop's own zero-indexed `iteration`
        // counter. Pre-fix, this branch listened for `iteration:start`
        // and the local counter never incremented, so every background
        // task in the host's grouped UI showed "0 iter" forever. Read
        // from the payload so the count tracks the loop's truth, not
        // a hand-rolled increment.
        if (type === 'tool_loop:llm_start') {
          const iter = (payload as { iteration?: number } | undefined)?.iteration;
          if (typeof iter === 'number' && Number.isFinite(iter)) {
            iterations = Math.max(iterations, iter + 1);
          }
        }
        if (type === 'tool_loop:tool_execute') {
          toolCalls += 1;
          const name = (payload as { name?: string } | undefined)?.name;
          if (typeof name === 'string') lastTool = name;
        }
        progressEmitter?.({ iterations, toolCalls, lastTool });
        // Tag every relayed event with the owning taskId when this is a
        // backgrounded run, so a host with multiple concurrent background
        // subagents can route events to the right card. Without this all
        // events arrive flat and the host can't tell tools-of-task-A from
        // tools-of-task-B — with 7 concurrent tasks
        // where the chat card stayed at 0 iter / 0 tools because the
        // single global buffer was being clobbered by every task:start.
        const tagged = taskId !== undefined && payload && typeof payload === 'object'
          ? { ...payload as Record<string, unknown>, taskId }
          : payload;
        emit(`subagent:${type}`, tagged);
      }
    });

    // Inherit the parent's system prompt verbatim when supplied — this is
    // the fix for the recurring subagent stall. A hand-rolled
    // subagent prompt always drifts from the parent's protocol (the
    // legacy SUBAGENT_PROMPT forbade `<tool_call>` markup but never
    // showed the format). Inheriting + appending a thin scope wrapper
    // keeps tool-call format, behavior policies, and operational hints
    // consistent across parent and subagent.
    const inherited = typeof opts.parentSystemPrompt === 'function'
      ? opts.parentSystemPrompt()
      : opts.parentSystemPrompt;
    const baseSystemPrompt = inherited && inherited.trim().length > 0
      ? inherited
      : SUBAGENT_PROMPT_FALLBACK;
    const subagentScope = [
      '',
      '',
      '## Subagent Scope',
      'You are operating as a SUBAGENT — a focused sub-process spawned by the parent agent to accomplish a single bounded goal.',
      '',
      `Your goal: ${goal}`,
      context ? `\nContext: ${context}` : '',
      '',
      'Subagent rules:',
      '- Stay strictly on the goal. No adjacent work, refactors, or "while I\'m here" cleanups.',
      '- When the goal is complete, return a 2-6 line synopsis. No preamble.',
      '- You CANNOT spawn further subagents (the `task` tool is not in your registry).',
      '- If the goal is ambiguous, make ONE reasonable interpretation and state it in your synopsis.',
      '- If you cannot reach the goal (tool errors, missing files, etc.), return what you learned and why you stopped.'
    ].filter((line, idx, arr) => !(line === '' && arr[idx - 1] === '')).join('\n');
    const systemPrompt = `${baseSystemPrompt}${subagentScope}`;

    // Telemetry: log the subagent's system prompt size +
    // inheritance source. Lets us correlate "huge inherited prompt"
    // with stalls/watchdog fires in the turn log without having to
    // recompute the size from chunks. Surfaced via subagent:task:spawn
    // event so hosts append it to the turn log alongside task:start.
    emit('subagent:task:spawn', {
      taskId,
      goal,
      systemPromptChars: systemPrompt.length,
      inheritedFromParent: Boolean(inherited && inherited.trim().length > 0),
      nativeTools: Boolean(inheritedLoopOptions.nativeTools),
      registryToolCount: subRegistry.getAll().length
    });

    // Pass the parent loop's AbortSignal through so Stop in the host
    // (Esc in CLI, cancel button in IDE) cascades down to in-flight
    // subagents. v1.7.338+: without this, hitting Stop aborted the
    // parent but every backgrounded subagent kept running and the
    // user had to kill the process to recover. The getter is read at
    // EACH spawn (not cached at registration time) so a subagent
    // spawned mid-turn picks up the current turn's controller.
    return subagent.run(goal, opts.chat, systemPrompt, {
      signal: opts.getParentSignal?.()
    });
  };

  return {
    name: 'task',
    description: 'Spawn a focused subagent to investigate a specific question or complete a bounded task. Do NOT use this for first-pass repo overviews like "what is this project" or "tell me about this repo" — answer those with direct list/read/search calls first. Use task for explicit exhaustive audits or a narrow branch of work whose intermediate details are not worth surfacing in the main conversation. The subagent returns a concise synopsis; its intermediate tool calls are hidden from you. Does NOT support nested task spawning. Pass run_in_background="true" for long-running or parallel investigations — the tool returns a task id immediately and the subagent\'s synopsis is delivered to you on a later turn so you can keep working with the user in the meantime.',
    parameters: [
      { name: 'goal', description: 'The specific question or task for the subagent. Be concrete — "find all call sites of foo() and list their files" beats "look at foo usage".', required: true },
      { name: 'context', description: 'Optional: one or two sentences of background the subagent needs that is not obvious from the goal alone.', required: false },
      { name: 'run_in_background', description: 'Optional. When "true", spawn the subagent in the background and return immediately with a task id. The subagent\'s synopsis is auto-injected into a later turn when it completes, so you can keep responding to the user while it runs. Use this for investigations that would otherwise take 30+ seconds and don\'t block the user\'s next question. Default: false (synchronous, parent waits).', required: false }
    ],
    async execute(params: Record<string, string>, _ctx: ToolExecutionContext): Promise<ToolResult> {
      const goal = params.goal?.trim();
      if (!goal) {
        return { output: 'Error: goal parameter is required.', isError: true };
      }
      const context = params.context?.trim();
      const wantsBackground = String(params.run_in_background ?? '').toLowerCase() === 'true';

      // Background path: spawn detached, return immediately with a task
      // id. Requires the host to have wired up a backgroundStore — fall
      // back to synchronous if the store isn't available, with a note
      // so the agent knows why it didn't actually go async.
      if (wantsBackground && opts.backgroundStore) {
        const store = opts.backgroundStore;
        // Concurrency cap: refuse to spawn when the configured ceiling
        // of in-flight backgrounds is already reached. This is flow
        // control, not an error — isError stays false so the model can
        // calmly pick from the offered options (wait, check_task on a
        // running id, or re-issue without backgrounding) without the
        // hallucination-prone "tool failed" framing.
        const cap = opts.maxConcurrentBackground ?? DEFAULT_MAX_CONCURRENT_BACKGROUND;
        if (cap > 0) {
          const running = store.listByStatus('running');
          if (running.length >= cap) {
            emit('task:cap-hit', {
              goal,
              cap,
              runningCount: running.length,
              runningIds: running.map((r) => r.id)
            });
            const ids = running.map((r) => r.id).join(', ');
            return {
              output:
                `Background subagent limit reached (${running.length} / ${cap} already running). ` +
                `Pick one: (a) wait for a running task to complete and call task(run_in_background="true") again, ` +
                `(b) call check_task on one of [${ids}] to block on a specific task, or ` +
                `(c) re-issue this task without run_in_background to run it inline now.`,
              isError: false
            };
          }
        }
        const taskId = store.start(goal);
        emit('task:start', { goal, maxIterations, background: true, taskId });
        // Detached run. We deliberately do NOT await — the parent tool
        // call returns synchronously below.
        void (async () => {
          try {
            const result = await runSubagent(goal, context, (p) => {
              store.progress(taskId, p);
            }, taskId);
            // Parent abort cascaded down — mark cancelled, NOT failed.
            // (v1.7.338+) Without this branch, a parent-aborted subagent
            // landed in the failure path with a misleading "stalled in
            // reasoning, 0 iterations" message, because cancelled
            // runs return finalResponse='[cancelled]' which strips to
            // an empty synopsis.
            if (result.cancelled) {
              store.cancel(taskId);
              emit('task:cancel', { goal, taskId, iterations: result.iterations });
              return;
            }
            const synopsis = sanitizeSubagentSynopsis(result.finalResponse);
            if (!synopsis) {
              const reason = result.iterations === 0
                ? 'Subagent stalled in reasoning without emitting a tool call or final answer (0 iterations). The model thought through the goal but never committed to an action.'
                : `Subagent finished in ${result.iterations} iteration(s) but returned no synopsis.${result.hitLimit ? ' (Hit iteration limit.)' : ''}`;
              store.fail(taskId, reason);
              emit('task:error', { goal, taskId, error: reason });
              return;
            }
            const limitNote = result.hitLimit ? `\n\n[Note: subagent hit ${maxIterations}-iteration limit, synopsis may be incomplete.]` : '';
            // same directive wrap as the sync path so the
            // parent's next turn treats the auto-injected background
            // synopsis as "the answer to my delegation" rather than
            // raw text it can ignore. See sync-path comment for the
            // observed-failure context.
            const bgDirective =
              '=== SUBAGENT REPORT — this is the answer to your delegation ===\n\n' +
              'The subagent you dispatched in the background has finished. The findings BELOW are what it found in the actual codebase. Synthesize THESE into your answer.\n\n' +
              'Do NOT speak as if the subagent is still running, restate your initial hypothesis, or invent gap categories that weren\'t in the report. DO cite the subagent\'s specific findings by name (file paths, function names, exact labels) and lead with anything it flagged as a real bug or missing capability.\n\n' +
              '--- Subagent findings ---\n\n';
            store.complete(taskId, `${bgDirective}${synopsis}${limitNote}`);
            emit('task:done', { goal, taskId, iterations: result.iterations, hitLimit: result.hitLimit });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            store.fail(taskId, msg);
            emit('task:error', { goal, taskId, error: msg });
          }
        })();
        return {
          output:
            `Spawned background subagent (task id: ${taskId}) — goal: "${goal}". ` +
            `You'll receive a synthetic system message with the synopsis when it completes. ` +
            `In the meantime, keep responding to the user. ` +
            `Call check_task with this id if you need to poll, or list_tasks to see all background work.`,
          isError: false
        };
      }
      if (wantsBackground && !opts.backgroundStore) {
        emit('task:warn', { goal, warning: 'background-not-supported' });
        // Fall through to synchronous path with a note appended.
      }

      // Synchronous path — same as v1.7.x and earlier. Parent waits.
      emit('task:start', { goal, maxIterations, background: false });
      try {
        const result = await runSubagent(goal, context);
        emit('task:done', { goal, iterations: result.iterations, hitLimit: result.hitLimit });
        const synopsis = sanitizeSubagentSynopsis(result.finalResponse);
        if (!synopsis) {
          const reason = result.iterations === 0
            ? 'Subagent stalled in reasoning without emitting a tool call or final answer (0 iterations). The model thought through the goal but never committed to an action.'
            : `Subagent finished in ${result.iterations} iteration(s) but returned no synopsis.${result.hitLimit ? ' (Hit iteration limit.)' : ''}`;
          return { output: reason, isError: true };
        }
        const limitNote = result.hitLimit ? `\n\n[Note: subagent hit ${maxIterations}-iteration limit, synopsis may be incomplete.]` : '';
        const fallbackNote = wantsBackground && !opts.backgroundStore
          ? '\n\n[Note: run_in_background was requested but this host does not support background tasks; ran synchronously.]'
          : '';
        // wrap the synopsis with a directive header so the
        // parent model treats this as "the answer to my delegation" and
        // synthesizes it into the final response. Without this header,
        // Gemma 4 (bandit-core-1) was ignoring real subagent findings
        // and restating its iter-0 hypothesis as if the subagent were
        // still running. turn 4kec: subagent
        // returned 2.2 KB of concrete findings (Underutilized Git
        // tools, missing LSP integration, semantic-search gap, real
        // technical debt in resolveRepoPath); parent's iter-1
        // response cloned the iter-0 prose with the same 4 invented
        // gaps and present-tense "while it digs into the source."
        // The header is structural ("=== SUBAGENT REPORT ===" + an
        // explicit directive) so it's hard to overlook even when the
        // model is in "restate-my-hypothesis" mode.
        const directive =
          '=== SUBAGENT REPORT — this is the answer to your delegation ===\n\n' +
          'The subagent you dispatched has finished its investigation. The findings BELOW are what it found in the actual codebase. Synthesize THESE into your final answer.\n\n' +
          'Do NOT:\n' +
          '  - Speak in present tense as if the subagent is still running ("while it digs into…").\n' +
          '  - Restate your initial hypothesis about what the subagent might find.\n' +
          '  - Invent gap categories that weren\'t in the report.\n\n' +
          'Do:\n' +
          '  - Cite the subagent\'s specific findings by name (file paths, function names, exact gap labels it used).\n' +
          '  - If the subagent flagged a real bug or missing capability, lead with that.\n' +
          '  - If the subagent\'s report contradicted your initial hypothesis, update your answer accordingly.\n\n' +
          '--- Subagent findings ---\n\n';
        return { output: `${directive}${synopsis}${limitNote}${fallbackNote}`, isError: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit('task:error', { goal, error: msg });
        // Categorize for the model so it knows whether to pivot
        // (upstream/network — try a different approach OR the same one
        // again later) or to give up (logic — won't get better on retry).
        // The most common failure in practice is an upstream gateway 5xx
        // during the subagent's chat call, which had been surfacing as
        // "Subagent crashed: 500 Internal Server Error" — easy to read
        // as a tool-denial issue. Now we tag it explicitly.
        const looksLikeUpstream =
          /\b(5\d\d)\b|upstream|gateway|fetch failed|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|aborted/i.test(msg);
        const tag = looksLikeUpstream
          ? 'Subagent failed: upstream/model error (this is NOT a tool-permission issue — the subagent\'s call to the LLM provider failed with a 5xx / network error). You can retry the same task tool call once; if it fails again, fall back to doing the work in the parent agent without delegating.'
          : 'Subagent crashed';
        return { output: `${tag}: ${msg}`, isError: true };
      }
    }
  };
}

/**
 * `check_task` tool — query the current state of a single background
 * subagent. Returns a friendly status line + the synopsis when the
 * task has completed. The agent rarely needs to call this because the
 * host auto-injects completion events into the next turn, but it's
 * here for explicit "are we there yet" polling and for cases where
 * the agent wants to wait on a specific task before doing the next
 * thing.
 */
export function buildCheckTaskTool(store: BackgroundTaskStore): AgentTool {
  return {
    name: 'check_task',
    description: 'Inspect the current state of a single background subagent task spawned via task(run_in_background="true"). Returns the running/completed/failed status, iteration count, and (when complete) the full synopsis. The output leads with the task\'s short title ("the security review is still running…") so when you narrate back to the user, use the title — not the raw id. Most of the time you do NOT need to call this — completed-task synopses are auto-injected as system messages on the next turn. Use this only when you want to explicitly wait on a specific task before doing the next thing.',
    parameters: [
      { name: 'task_id', description: 'The id returned from a previous task(run_in_background="true") call.', required: true }
    ],
    execute(params): Promise<ToolResult> {
      const id = params.task_id?.trim();
      if (!id) return Promise.resolve({ output: 'Error: task_id parameter is required.', isError: true });
      const record = store.get(id);
      if (!record) return Promise.resolve({ output: `No background task with id "${id}".`, isError: true });
      const seconds = ((record.endedAt ?? Date.now()) - record.startedAt) / 1000;
      const stamp = `${seconds.toFixed(1)}s, ${record.iterations} iter, ${record.toolCalls} tool calls`;
      // Lead with the task's GOAL (short title) so the agent's narration
      // back to the user reads "the security review is still running"
      // instead of "task bg-mpr7i4jb-hths is still running". The raw id
      // stays available in parentheses for explicit re-checks.
      const title = formatTaskTitle(record.goal);
      if (record.status === 'running') {
        return Promise.resolve({ output: `"${title}" — still running (${stamp}). Last tool: ${record.lastTool ?? '—'}. (id: ${id})`, isError: false });
      }
      if (record.status === 'completed') {
        store.markConsumed(id);
        return Promise.resolve({ output: `"${title}" — completed (${stamp}). (id: ${id})\n\n${record.synopsis ?? '(no synopsis)'}`, isError: false });
      }
      if (record.status === 'failed') {
        store.markConsumed(id);
        return Promise.resolve({ output: `"${title}" — failed (${stamp}): ${record.error ?? 'unknown error'} (id: ${id})`, isError: true });
      }
      // cancelled
      store.markConsumed(id);
      return Promise.resolve({ output: `"${title}" — cancelled (${stamp}). (id: ${id})`, isError: false });
    }
  };
}

/**
 * Format a task's goal into a short narratable title. Strips imperative
 * verb scaffolding ("Do a", "Investigate", "Perform a") so the title
 * reads naturally inside a sentence ("the security review is still
 * running" instead of "the do-a-security-review is still running").
 * Caps at 60 chars with an ellipsis so it stays in a single line of
 * the agent's narration.
 */
function formatTaskTitle(goal: string): string {
  let title = goal.trim();
  // Strip common imperative openers so the title reads as a noun phrase.
  title = title.replace(/^(do a|do an|perform a|perform an|investigate|investigate the|run a|run an|conduct a|conduct an)\s+/i, '');
  // Trim trailing punctuation that's part of the goal sentence.
  title = title.replace(/[.!?]+$/, '');
  // Single line. Models sometimes wrap goals with newlines; flatten.
  title = title.replace(/\s+/g, ' ');
  if (title.length > 60) {
    title = title.slice(0, 57).trimEnd() + '…';
  }
  return title || goal.slice(0, 60);
}

/**
 * `list_tasks` tool — list every background subagent task in the
 * current session. Cheap status overview; the agent typically only
 * calls this if the user asks "what's still running" or similar.
 */
export function buildListTasksTool(store: BackgroundTaskStore): AgentTool {
  return {
    name: 'list_tasks',
    description: 'List all background subagent tasks in this session (running and completed). Useful when the user asks "what\'s still running" or "what happened with that earlier task". Each entry leads with the task\'s short title (derived from its goal) — when narrating back to the user, refer to tasks by title ("the security review is still working") rather than by id.',
    parameters: [],
    execute(): Promise<ToolResult> {
      const tasks = store.list();
      if (tasks.length === 0) {
        return Promise.resolve({ output: 'No background tasks have been spawned in this session.', isError: false });
      }
      const lines = tasks.map((t) => {
        const seconds = ((t.endedAt ?? Date.now()) - t.startedAt) / 1000;
        const status = t.status === 'running' ? `running (${seconds.toFixed(0)}s)` : `${t.status} (${seconds.toFixed(1)}s)`;
        const title = formatTaskTitle(t.goal);
        return `- "${title}" · ${status} · ${t.iterations} iter (id: ${t.id})`;
      });
      return Promise.resolve({ output: lines.join('\n'), isError: false });
    }
  };
}

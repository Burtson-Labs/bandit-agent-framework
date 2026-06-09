/**
 * Turn-log replay harness.
 *
 * Reads a `.bandit/turns/*.jsonl` file produced by a real agent run,
 * extracts the captured LLM responses, and feeds them back through
 * a fresh `ToolUseLoop` with the same registry shape. The point: any
 * regression in the loop that would have changed the outcome of a
 * known-good (or known-broken) past run shows up immediately as a
 * test failure.
 *
 * Format reference: see `apps/bandit-stealth/src/extension.ts` and
 * `apps/bandit-cli/src/cli.ts` — they push events shaped like:
 * { t, type: 'user-prompt' | 'llm-start' | 'llm-response' | ... }
 *
 * Limitation: the host-side capture truncates `llm-response`
 * `responsePreview` to 2000 chars . Replay is faithful for
 * responses that fit; longer responses where the tool_call envelope
 * lives in the tail will fail to replay correctly. The
 * `replayCompleteness` flag on `extractParentScript` reports this
 * so callers can skip or warn rather than silently misinterpret.
 */
import * as fs from 'node:fs';
import { ToolUseLoop, ToolRegistry } from '../src/index';
import type { AgentTool, ToolResult, ToolUseLoopOptions } from '../src/index';
import { testCtx } from './_helpers';

export interface TurnLogEvent {
  t?: string;
  type: string;
  [key: string]: unknown;
}

/** Parse a JSONL turn log file into an ordered array of events. */
export function loadTurnLog(path: string): TurnLogEvent[] {
  const raw = fs.readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TurnLogEvent);
}

export interface ExtractedScript {
  /** The original user prompt that started the turn. */
  userPrompt: string;
  /** LLM response text, in order. Each entry is one chat() call. */
  responses: string[];
  /** Per-response metadata captured at log time — useful for
   * asserting hasToolCallMarkup and length parity after replay. */
  responseMeta: Array<{
    iteration: number;
    fullLength: number;
    hasToolCallMarkup: boolean;
    endsWithFenceClose: boolean;
    /** True when the captured preview equals the full response (no
     * truncation). When false, the replay may behave differently
     * from the original because the tail was clipped. */
    captureComplete: boolean;
  }>;
  /**
   * Whether every parent llm-response in the log fits in its
   * preview window. When false, callers should either skip replay
   * or accept that downstream behavior may diverge.
   */
  replayCompleteness: boolean;
}

/** Pull the parent agent's chat-call script out of a turn log. */
export function extractParentScript(events: TurnLogEvent[]): ExtractedScript {
  const userPromptEvent = events.find((e) => e.type === 'user-prompt');
  const userPrompt = (userPromptEvent?.prompt as string) ?? '';

  const responses: string[] = [];
  const responseMeta: ExtractedScript['responseMeta'] = [];
  for (const e of events) {
    if (e.type !== 'llm-response') continue;
    const preview = (e.responsePreview as string) ?? '';
    const fullLength = (e.responseLength as number) ?? preview.length;
    responses.push(preview);
    responseMeta.push({
      iteration: (e.iteration as number) ?? 0,
      fullLength,
      hasToolCallMarkup: Boolean(e.hasToolCallMarkup),
      endsWithFenceClose: Boolean(e.endsWithFenceClose),
      captureComplete: preview.length === fullLength
    });
  }

  const replayCompleteness = responseMeta.every((m) => m.captureComplete);
  return { userPrompt, responses, responseMeta, replayCompleteness };
}

/** Build a mock chat function that yields scripted responses in order. */
export function buildReplayChatFn(script: ExtractedScript): {
  chat: () => AsyncIterable<string>;
  callCount: () => number;
} {
  let cursor = 0;
  const callCount = () => cursor;
  const chat = function* () {
    const next = script.responses[cursor];
    cursor += 1;
    if (next === undefined) {
      return;
    }
    yield next;
  };
  return {
    chat: chat as unknown as () => AsyncIterable<string>,
    callCount
  };
}

/** No-op tool factory — registers a tool that records params and
 * returns a placeholder result. Useful for replay where the actual
 * tool output doesn't matter (the LLM responses are scripted). */
export function buildPlaceholderTool(name: string): AgentTool {
  return {
    name,
    description: `replay placeholder for ${name}`,
    parameters: [],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      void params;
      return { output: `[replay placeholder result for ${name}]` };
    }
  };
}

/**
 * Walk a turn log and pull every `tool-result` event into a per-tool
 * ordered list of output lengths. Lets the replay harness recreate
 * the message-size profile of the original run — important for
 * length-dependent behaviors like compaction (which only fires when
 * accumulated message tokens exceed the budget) and goal anchoring
 * (which fires when message tokens exceed 4000).
 */
export function extractToolOutputSizes(
  events: TurnLogEvent[]
): Map<string, number[]> {
  const sizes = new Map<string, number[]>();
  for (const e of events) {
    if (e.type !== 'tool-result') continue;
    const name = (e.name as string) ?? '';
    const length = (e.outputLength as number) ?? 0;
    if (!name) continue;
    const list = sizes.get(name) ?? [];
    list.push(length);
    sizes.set(name, list);
  }
  return sizes;
}

/**
 * Build a tool whose execute() returns a string of the size captured
 * in the original run. Each successive call uses the next size from
 * the list. After the list is exhausted, falls back to a small
 * placeholder so the loop doesn't crash on extra calls.
 */
export function buildSizeMatchingTool(name: string, sizes: number[]): AgentTool {
  let callIndex = 0;
  return {
    name,
    description: `replay size-matching for ${name}`,
    parameters: [],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      void params;
      const size = sizes[callIndex] ?? 64;
      callIndex += 1;
      // 'X' repeated to the captured length — exact content doesn't
      // matter for length-driven tests, only the size.
      return { output: 'X'.repeat(size) };
    }
  };
}

/** Default tool set populated with the names parent / subagent runs
 * most commonly invoke. Hosts typically have far more tools but the
 * loop only needs the names that show up in the script's tool_calls. */
const REPLAY_DEFAULT_TOOLS = [
  'read_file',
  'write_file',
  'apply_edit',
  'replace_range',
  'apply_patch',
  'list_files',
  'ls',
  'find_directory',
  'search_code',
  'run_command',
  'todo_write',
  'remember',
  'web_fetch',
  'task',
  'check_task',
  'list_tasks',
  'git_status',
  'git_diff',
  'git_log'
];

export interface ReplayTurnOptions extends ToolUseLoopOptions {
  /**
   * When true, build tools that return strings sized to match the
   * original run's tool-result outputs (extracted from `tool-result`
   * events in the log). Required for tests that care about
   * length-dependent behaviors like compaction and goal anchoring —
   * placeholder tools return 64-char strings which never trip those
   * gates. Defaults to false (placeholder mode) for tests that only
   * care about the model's response shape.
   */
  matchToolOutputSizes?: boolean;
}

/** Run a turn-log script through a fresh ToolUseLoop. Returns the
 * loop result and the captured emit events so tests can compare
 * against expectations derived from the original log. */
export async function replayTurn(
  events: TurnLogEvent[],
  options: ReplayTurnOptions = {}
): Promise<{
  script: ExtractedScript;
  emitted: Array<{ type: string; payload: unknown }>;
  result: Awaited<ReturnType<ToolUseLoop['run']>>;
}> {
  const script = extractParentScript(events);
  const { matchToolOutputSizes, ...loopOptions } = options;
  const registry = new ToolRegistry();
  if (matchToolOutputSizes) {
    const sizes = extractToolOutputSizes(events);
    for (const name of REPLAY_DEFAULT_TOOLS) {
      registry.register(buildSizeMatchingTool(name, sizes.get(name) ?? []));
    }
  } else {
    for (const name of REPLAY_DEFAULT_TOOLS) {
      registry.register(buildPlaceholderTool(name));
    }
  }
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const loop = new ToolUseLoop(registry, testCtx, {
    ...loopOptions,
    emitEvent: (type, payload) => emitted.push({ type, payload })
  });
  const { chat } = buildReplayChatFn(script);
  const result = await loop.run(script.userPrompt, chat as never);
  return { script, emitted, result };
}

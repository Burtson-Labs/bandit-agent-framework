/**
 * Tool history on the native-tools path.
 *
 * The tool loop keeps a turn as text: its own call is an assistant message
 * `<tool_call>{"name":…,"params":…}</tool_call>` and the result is a user message holding
 * `<tool_result name="…">…</tool_result>`. That is the right wire form when the model was
 * taught the text protocol in its system prompt. It is the wrong one when the request also
 * carries a native `tools` array: the model sees, in its own previous turn, a call written
 * as text, and writes its next call the same way.
 *
 * What that costs, measured on local Ollama 0.35.1 (BanditBench, 2026-10-05):
 *  - qwen3 (8b, 14b): Ollama's tool parser claims the `<tool_call>` tag, cannot read a
 *    `params`-keyed body and returns an empty message. Every tool step after the first
 *    then costs about three recovery round-trips.
 *  - qwen3-coder:30b: the server answers 500 `{"error":"EOF"}` on the second call in half
 *    the runs.
 *  - gemma4: writes the call as text, a long hand-written JSON body does not always parse,
 *    and the turn ends with "I've updated…" and no write.
 *
 * So when native tools are active the history is replayed in the provider's own message
 * format: assistant `tool_calls` plus `role: "tool"` results. Providers without native
 * tools, and requests without a `tools` array (including the loop's mid-turn fallback to
 * the text protocol), keep the text form untouched.
 */
import { parseToolCalls } from '@burtson-labs/agent-core';
import { getModelBehaviorProfile, type ToolHistoryMode } from './runtime/modelBehavior';

/** `ollama`: /api/chat messages. `openai`: /v1/chat/completions messages. */
export type ToolHistoryWire = 'ollama' | 'openai';

export type ToolHistoryProviderKind = 'bandit' | 'ollama' | 'openai-compatible';

export interface ReplayedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ReplayedToolResult {
  id: string;
  name: string;
  content: string;
}

/**
 * One entry of the rewritten conversation. `index` points at the source message so a
 * provider can carry over whatever else that message held (images, content parts).
 */
export type ToolHistoryEntry =
  | { kind: 'keep'; index: number }
  | { kind: 'assistant'; index: number; content: string; calls: ReplayedToolCall[] }
  | { kind: 'tool'; index: number; result: ReplayedToolResult }
  | { kind: 'user'; index: number; content: string };

const INLINE_TOOL_RESULT = /<tool_result name="([^"]*)"( status="error")?>\n?([\s\S]*?)\n?<\/tool_result>/g;

interface ParsedCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface ParsedResult {
  name: string;
  content: string;
}

/**
 * The calls in an assistant turn, read with the loop's own parser so the replay holds
 * exactly the calls the loop saw: the provider's `<tool_call>{json}</tool_call>`
 * translation of a native call, and whatever a model wrote by hand that the loop accepted
 * (a fenced block, Qwen3-Coder's `<function=…>` form). `rest` is the turn's prose.
 */
function parseCalls(content: string): { calls: ParsedCall[]; rest: string } {
  const parsed = parseToolCalls(content);
  if (parsed.length === 0) {return { calls: [], rest: content };}
  let rest = content;
  for (const call of parsed) {rest = rest.replace(call.raw, '');}
  // Ollama returns Qwen3-Coder's closing tag without its opener; a tag with no call left
  // around it is markup debris, not prose.
  rest = rest.replace(/<\/tool_call>/g, '').replace(/<tool_call>\s*$/, '').trim();
  return { calls: parsed.map((call) => ({ name: call.name, arguments: call.params })), rest };
}

function parseResults(content: string): { results: ParsedResult[]; rest: string } {
  const results: ParsedResult[] = [];
  if (!/^\s*<tool_result\b/.test(content)) {return { results, rest: content };}
  const rest = content.replace(INLINE_TOOL_RESULT, (_whole: string, name: string, errored: string | undefined, body: string) => {
    // The envelope's status attribute has no native counterpart; keep the fact in the text.
    results.push({ name, content: errored && !/^\s*error\b/i.test(body) ? `ERROR: ${body}` : body });
    return '';
  }).trim();
  return { results, rest };
}

/**
 * Which calls do the results answer? The loop can run fewer calls than the model emitted
 * (per-model parallel cap, duplicate removal, per-turn total), and a call with no result
 * reads, in native form, as a call that happened. Results come back in call order, so walk
 * both lists once and keep the calls that have an answer. Null when the results cannot be
 * attributed, in which case the pair is left as text.
 */
function pairCallsWithResults(calls: ParsedCall[], results: ParsedResult[]): ParsedCall[] | null {
  const answered: ParsedCall[] = [];
  let cursor = 0;
  for (const result of results) {
    while (cursor < calls.length && calls[cursor].name !== result.name) {cursor += 1;}
    if (cursor >= calls.length) {return null;}
    answered.push(calls[cursor]);
    cursor += 1;
  }
  return answered;
}

/**
 * Plan the native replay of a text-form conversation. A call is rewritten only together
 * with its results: an assistant turn whose calls have no result message after it (the loop
 * refused to run them, or the turn was cut off) and anything that does not parse stay
 * exactly as they were, which is the behaviour before this existed.
 */
export function planToolHistory(messages: ReadonlyArray<{ role: string; content: string }>): ToolHistoryEntry[] {
  const plan: ToolHistoryEntry[] = [];
  let nextId = 1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const next = messages[index + 1];
    if (message.role === 'assistant' && next?.role === 'user') {
      // Results first: only a turn the loop answered with results had calls it ran.
      const { results, rest: resultsRest } = parseResults(next.content);
      const { calls, rest } = results.length > 0 ? parseCalls(message.content) : { calls: [], rest: message.content };
      const answered = calls.length > 0 ? pairCallsWithResults(calls, results) : null;
      if (answered) {
        const replayed = answered.map((call) => ({ id: `call_${nextId++}`, name: call.name, arguments: call.arguments }));
        plan.push({ kind: 'assistant', index, content: rest, calls: replayed });
        results.forEach((result, position) => {
          plan.push({ kind: 'tool', index: index + 1, result: { id: replayed[position].id, name: result.name, content: result.content } });
        });
        // Notes the loop appends after the results ("only the first N were executed…").
        if (resultsRest) {plan.push({ kind: 'user', index: index + 1, content: resultsRest });}
        index += 1;
        continue;
      }
    }
    plan.push({ kind: 'keep', index });
  }
  return plan;
}

type WireMessage = Record<string, unknown> & { role: string };

/**
 * Rewrite Ollama /api/chat messages. Assistant calls become `tool_calls` with object
 * arguments; results become `role: "tool"` messages carrying `tool_name`.
 */
export function toOllamaToolHistory<T extends { role: string; content: string; images?: string[] }>(messages: T[]): WireMessage[] {
  const plan = planToolHistory(messages);
  const out: WireMessage[] = [];
  plan.forEach((entry, position) => {
    const source = messages[entry.index];
    switch (entry.kind) {
      case 'assistant':
        out.push({
          ...source,
          content: entry.content,
          tool_calls: entry.calls.map((call) => ({ function: { name: call.name, arguments: call.arguments } }))
        });
        break;
      case 'tool': {
        out.push({ role: 'tool', tool_name: entry.result.name, content: entry.result.content });
        // A tool message cannot carry images. If the results message had any and no user
        // remainder follows to hold them, keep them on a user message of their own.
        const following = plan[position + 1];
        if (source.images?.length && following?.index !== entry.index) {
          out.push({ role: 'user', content: '', images: source.images });
        }
        break;
      }
      case 'user':
        out.push({ ...source, content: entry.content });
        break;
      default:
        out.push(source);
    }
  });
  return out;
}

/**
 * Rewrite chat-completions messages (content given as parts), as sent to an
 * OpenAI-compatible server or to the Bandit gateway.
 *
 *  - `openai`: calls carry an id and JSON-string arguments; a result is a `role: "tool"`
 *    message answering that id.
 *  - `ollama`: the Bandit gateway forwards message fields to Ollama's /api/chat unchanged,
 *    so it needs Ollama's shape: object arguments and `tool_name`.
 */
export function toPartsToolHistory<T extends { role: string; content: Array<{ type: string; text?: string }> }>(
  messages: T[],
  wire: ToolHistoryWire
): WireMessage[] {
  const asText = messages.map((message) => ({
    role: message.role,
    content: message.content.every((part) => part.type === 'text')
      ? message.content.map((part) => part.text ?? '').join('\n')
      : '' // a message with images is never a tool call or a tool result
  }));
  return planToolHistory(asText).flatMap((entry): WireMessage[] => {
    switch (entry.kind) {
      case 'assistant':
        return [{
          role: 'assistant',
          content: entry.content,
          tool_calls: entry.calls.map((call) => wire === 'openai'
            ? { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }
            : { function: { name: call.name, arguments: call.arguments } })
        }];
      case 'tool':
        return [wire === 'openai'
          ? { role: 'tool', tool_call_id: entry.result.id, content: entry.result.content }
          : { role: 'tool', tool_name: entry.result.name, content: entry.result.content }];
      case 'user':
        return [{ role: 'user', content: [{ type: 'text', text: entry.content }] }];
      default:
        return [messages[entry.index]];
    }
  });
}

/**
 * How to replay tool history for a request that carries native tools.
 *
 *  1. `BANDIT_TOOL_HISTORY=text|native` forces one form for every model and provider.
 *     `text` is the behaviour before this existed.
 *  2. Direct Ollama: the model's behaviour profile decides (`protocol.toolHistory`, which a
 *     user profile can override per model family).
 *  3. The Bandit gateway and OpenAI-compatible servers stay on text unless forced: the
 *     native form is implemented for both but has only been measured against Ollama.
 */
export function resolveToolHistoryMode(modelId: string, providerKind: ToolHistoryProviderKind): ToolHistoryMode {
  const forced = (process.env.BANDIT_TOOL_HISTORY ?? '').trim().toLowerCase();
  if (forced === 'text' || forced === 'native') {return forced;}
  if (providerKind !== 'ollama') {return 'text';}
  return getModelBehaviorProfile(modelId).protocol.toolHistory;
}

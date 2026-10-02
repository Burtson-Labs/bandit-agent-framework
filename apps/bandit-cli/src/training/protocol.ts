/**
 * Bandit text protocol → canonical chat with native tool calls.
 *
 * In history the model's tool calls are inline `<tool_call>{"name","params"}</tool_call>`
 * blocks in assistant content and results come back as user messages holding one or
 * more `<tool_result name="x" [status="error"]>…</tool_result>` envelopes (there is no
 * `tool` role in ToolLoopMessage). Host-emitted ```bandit-*``` fences (bandit-tl,
 * bandit-run, bandit-subagent, bandit-permission) are UI cards, never model output;
 * bandit-reasoning wraps the model's thinking channel.
 */
import type { CanonicalMessage, CanonicalToolCall } from './types';

export const AUTOMATED_NUDGE_PREFIX_START = 'AUTOMATED HARNESS CHECK';

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const TOOL_RESULT_RE = /<tool_result\b([^>]*)>\n?([\s\S]*?)\n?<\/tool_result>/g;
// Opening fence of 3+ backticks with a bandit-* info string; closed by a line of the same length.
const BANDIT_FENCE_RE = /(^|\n)(`{3,})(bandit-[a-z0-9-]+)[^\n]*\n([\s\S]*?)(?:\n\2(?!`)[^\n]*|$(?![\s\S]))/g;
const THINK_RE = /<think>([\s\S]*?)<\/think>/g;
const TEMPLATE_LEAKS = [
  /<\/?start_of_turn>(?:model|user)?/g,
  /<end_of_turn>/g,
  /<\|im_(?:start|end)\|>(?:assistant|user|system)?/g,
  /<\|(?:eot_id|endoftext|end|start_header_id|end_header_id|channel|message|return|call)\|>/g,
  /<eos>|<bos>|<\/s>/g
];

export interface ParsedToolCall {
  name: string;
  params: Record<string, unknown>;
}

export interface ParsedAssistant {
  content: string;
  reasoning?: string;
  toolCalls: ParsedToolCall[];
  /** Tool-call blocks that did not parse as JSON (kept out of the example). */
  malformedCalls: number;
}

export interface ParsedToolResult {
  name: string;
  isError: boolean;
  content: string;
}

export function stripTemplateLeaks(text: string): string {
  let out = text;
  for (const re of TEMPLATE_LEAKS) out = out.replace(re, '');
  return out;
}

/** Remove host-emitted bandit-* fences; returns the text and any reasoning they held. */
export function stripBanditFences(text: string): { text: string; reasoning: string[] } {
  const reasoning: string[] = [];
  const out = text.replace(BANDIT_FENCE_RE, (_m, lead: string, _ticks: string, kind: string, body: string) => {
    if (kind === 'bandit-reasoning' && body.trim()) reasoning.push(body.trim());
    return lead;
  });
  return { text: out, reasoning };
}

function tidy(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function parseAssistant(raw: string): ParsedAssistant {
  let text = stripTemplateLeaks(raw);
  const fenced = stripBanditFences(text);
  text = fenced.text;
  const reasoning = [...fenced.reasoning];
  text = text.replace(THINK_RE, (_m, body: string) => {
    if (body.trim()) reasoning.push(body.trim());
    return '';
  });
  const toolCalls: ParsedToolCall[] = [];
  let malformedCalls = 0;
  text = text.replace(TOOL_CALL_RE, (_m, body: string) => {
    try {
      const parsed = JSON.parse(body) as { name?: unknown; params?: unknown; arguments?: unknown };
      const params = (parsed.params ?? parsed.arguments ?? {}) as unknown;
      if (typeof parsed.name === 'string' && params && typeof params === 'object' && !Array.isArray(params)) {
        toolCalls.push({ name: parsed.name, params: params as Record<string, unknown> });
      } else {
        malformedCalls++;
      }
    } catch {
      malformedCalls++;
    }
    return '';
  });
  return { content: tidy(text), reasoning: reasoning.length ? reasoning.join('\n\n') : undefined, toolCalls, malformedCalls };
}

function attr(attrs: string, key: string): string | undefined {
  const m = attrs.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`));
  return m?.[1];
}

/** A user message is a tool-result carrier when it is nothing but envelopes. */
export function parseToolResults(content: string): ParsedToolResult[] | null {
  if (!content.includes('<tool_result')) return null;
  const results: ParsedToolResult[] = [];
  const rest = content.replace(TOOL_RESULT_RE, (_m, attrs: string, body: string) => {
    results.push({
      name: attr(attrs, 'name') ?? 'unknown',
      isError: attr(attrs, 'status') === 'error',
      content: body
    });
    return '';
  });
  if (results.length === 0) return null;
  // Anything else in the message (rare: harness notes appended to results) rides on the last result.
  const leftover = stripTemplateLeaks(rest).trim();
  if (leftover) results[results.length - 1].content += `\n\n${leftover}`;
  return results;
}

export function isNudge(content: string): boolean {
  return content.trimStart().startsWith(AUTOMATED_NUDGE_PREFIX_START);
}

export interface ConvertOptions {
  keepNudges?: boolean;
}

export interface ConvertStats {
  toolCalls: number;
  toolErrors: number;
  malformedCalls: number;
  nudgesDropped: number;
  unmatchedResults: number;
}

/**
 * Convert a Bandit text-protocol transcript (user/assistant only) into canonical
 * messages. Tool results are matched to the preceding assistant's calls in order
 * (same name preferred); results with no open call are folded into a user note.
 */
export function convertTranscript(
  messages: Array<{ role: string; content: string }>,
  options: ConvertOptions = {}
): { messages: CanonicalMessage[]; stats: ConvertStats } {
  const out: CanonicalMessage[] = [];
  const stats: ConvertStats = { toolCalls: 0, toolErrors: 0, malformedCalls: 0, nudgesDropped: 0, unmatchedResults: 0 };
  let callSeq = 0;
  let open: CanonicalToolCall[] = [];

  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (msg.role === 'system') continue; // rebuilt by the collector
    if (msg.role === 'assistant') {
      const parsed = parseAssistant(content);
      stats.malformedCalls += parsed.malformedCalls;
      const calls: CanonicalToolCall[] = parsed.toolCalls.map(c => ({
        id: `call_${++callSeq}`,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.params) }
      }));
      stats.toolCalls += calls.length;
      if (!parsed.content && !parsed.reasoning && calls.length === 0) continue;
      const assistant: CanonicalMessage = { role: 'assistant', content: parsed.content };
      if (parsed.reasoning) assistant.reasoning = parsed.reasoning;
      if (calls.length) assistant.tool_calls = calls;
      out.push(assistant);
      open = calls.slice();
      continue;
    }
    // user
    const results = parseToolResults(content);
    if (results) {
      for (const r of results) {
        const idx = open.findIndex(c => c.function.name === r.name);
        const call = idx >= 0 ? open.splice(idx, 1)[0] : open.shift();
        if (r.isError) stats.toolErrors++;
        const body = r.isError ? `ERROR: ${r.content}` : r.content;
        if (call) {
          out.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: body });
        } else {
          // A result with no open call (duplicate envelope, call lost to compaction) has no
          // valid place in a native-tools transcript; leave it out rather than fake a turn.
          stats.unmatchedResults++;
        }
      }
      continue;
    }
    if (isNudge(content) && !options.keepNudges) {
      stats.nudgesDropped++;
      continue;
    }
    const text = stripTemplateLeaks(content).trim();
    if (text) out.push({ role: 'user', content: text });
    open = [];
  }
  return { messages: out, stats };
}

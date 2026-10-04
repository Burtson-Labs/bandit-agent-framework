/**
 * Context windowing: fit each example into the trainer's sequence length instead of
 * letting the trainer skip it as too long (the first 8B run skipped 515 of 1,013).
 *
 * A window is: system prompt + the session's first user task (when it fell outside the
 * window, with a compaction notice like the runtime's) + the most recent messages that
 * fit the budget, always ending on an assistant message. Windows never start on a tool
 * result (its tool_call would be missing). In `chunks` mode a long trajectory becomes
 * several consecutive windows, so the middle of a long tool loop (the reads, the edits)
 * is trained too, not just its tail. Oversized tool outputs are clipped head + tail.
 */
import type { CanonicalMessage, NativeToolSchema } from './types';

export type WindowMode = 'tail' | 'chunks';

export interface WindowOptions {
  /** Token budget for the whole example (system + tools + messages), char/4 estimate. */
  budgetTokens: number;
  mode: WindowMode;
  /** One tool output may use at most this many tokens (default: a quarter of the budget). */
  maxToolTokens?: number;
  /** The session's first real user task, re-attached when the window starts later. */
  firstTask?: CanonicalMessage | null;
  /**
   * Index (in `messages`, system included) where the example's own turn starts. In chunks
   * mode windows only end inside this turn: earlier history is context, not a new target.
   */
  targetFrom?: number;
}

export interface ExampleWindow {
  messages: CanonicalMessage[];
  /** 1-based position among the windows of the same trajectory. */
  index: number;
  of: number;
  /** Messages of the trajectory left out before this window starts. */
  droppedBefore: number;
}

export interface WindowResult {
  windows: ExampleWindow[];
  /** Estimated tokens of the unwindowed example (after tool-output clipping). */
  rawTokens: number;
  clippedToolOutputs: number;
  /** Assistant messages too large to fit even alone (their windows are not emitted). */
  oversized: number;
}

export function messageTokens(m: CanonicalMessage): number {
  return Math.ceil(JSON.stringify(m).length / 4);
}

export function toolsTokens(tools: NativeToolSchema[]): number {
  return tools.length ? Math.ceil(JSON.stringify(tools).length / 4) : 0;
}

export function exampleTokens(messages: CanonicalMessage[], tools: NativeToolSchema[] = []): number {
  return messages.reduce((n, m) => n + messageTokens(m), 0) + toolsTokens(tools);
}

/** Keep the head and tail of a long tool output with an elision marker in between. */
export function clipToolOutput(content: string, maxTokens: number): { content: string; clipped: boolean } {
  const maxChars = Math.max(400, maxTokens * 4);
  if (content.length <= maxChars) {return { content, clipped: false };}
  const head = content.slice(0, Math.floor(maxChars * 0.6));
  const tail = content.slice(content.length - Math.floor(maxChars * 0.35));
  const middle = content.slice(head.length, content.length - tail.length);
  const lines = middle.split('\n').length;
  return { content: `${head}\n[… ${lines} lines elided …]\n${tail}`, clipped: true };
}

export function compactionNotice(dropped: number): string {
  return `[Earlier conversation compacted: ${dropped} earlier message${dropped === 1 ? ' is' : 's are'} not shown. ` +
    'Use what was already learned; re-check details with the available tools before acting.]';
}

/**
 * Split one trajectory (system first) into windows that fit `budgetTokens`.
 * `tools` are counted against the budget because the trainer renders them into the prompt.
 */
export function windowExample(messages: CanonicalMessage[], tools: NativeToolSchema[], opts: WindowOptions): WindowResult {
  const system = messages[0]?.role === 'system' ? messages[0] : null;
  let body = system ? messages.slice(1) : messages.slice();
  const maxTool = opts.maxToolTokens ?? Math.floor(opts.budgetTokens / 4);
  let clippedToolOutputs = 0;
  body = body.map(m => {
    if (m.role !== 'tool') {return m;}
    const c = clipToolOutput(m.content, maxTool);
    if (c.clipped) {clippedToolOutputs++;}
    return c.clipped ? { ...m, content: c.content } : m;
  });
  // A trajectory ends on its last assistant message; trailing user/tool messages have no target.
  let lastAssistant = -1;
  body.forEach((m, i) => {
    if (m.role === 'assistant') {lastAssistant = i;}
  });
  const fixed = (system ? messageTokens(system) : 0) + toolsTokens(tools);
  const rawTokens = fixed + body.reduce((n, m) => n + messageTokens(m), 0);
  if (lastAssistant < 0) {return { windows: [], rawTokens, clippedToolOutputs, oversized: 0 };}
  body = body.slice(0, lastAssistant + 1);

  const available = opts.budgetTokens - fixed;
  const prefix = system ? [system] : [];
  const firstIdx = body.findIndex(m => m.role === 'user');
  const firstTask = opts.firstTask ?? (firstIdx >= 0 ? body[firstIdx] : null);
  const firstInBody = firstTask ? body.findIndex(m => m === firstTask || (m.role === 'user' && m.content === firstTask.content)) : -1;
  const headerFor = (start: number): CanonicalMessage | null => {
    if (!firstTask) {return null;}
    if (firstInBody >= 0 && start <= firstInBody) {return null;} // the task itself is in the window
    const dropped = firstInBody >= 0 ? start - firstInBody - 1 : start;
    if (dropped <= 0 && firstInBody >= 0) {return null;}
    return { role: 'user', content: `${firstTask.content}\n\n${compactionNotice(Math.max(1, dropped))}` };
  };

  // Fits whole: one window, unchanged apart from clipping.
  if (fixed + body.reduce((n, m) => n + messageTokens(m), 0) <= opts.budgetTokens) {
    return { windows: [{ messages: [...prefix, ...body], index: 1, of: 1, droppedBefore: 0 }], rawTokens, clippedToolOutputs, oversized: 0 };
  }

  /** Earliest valid start for a window ending at `end`, not earlier than `floor`; -1 when nothing fits. */
  const fitStart = (end: number, floor: number): number => {
    let total = 0;
    let best = -1;
    for (let s = end; s >= floor; s--) {
      total += messageTokens(body[s]);
      if (body[s].role === 'tool') {continue;}
      const header = headerFor(s);
      const need = total + (header ? messageTokens(header) : 0);
      if (need <= available) {best = s;}
      else if (total > available) {break;}
    }
    return best;
  };

  const minEnd = Math.max(0, (opts.targetFrom ?? 0) - (system ? 1 : 0));
  const spans: Array<{ start: number; end: number }> = [];
  let oversized = 0;
  let end = lastAssistant;
  while (end >= 0) {
    const start = fitStart(end, 0);
    if (start < 0) {
      // The assistant message at `end` (plus what it needs) cannot fit alone.
      oversized++;
    } else {
      spans.unshift({ start, end });
    }
    if (opts.mode === 'tail') {break;}
    // Next window ends at the last assistant message before this one starts.
    const from = start < 0 ? end - 1 : start - 1;
    let next = -1;
    for (let i = from; i >= 0; i--) {
      if (body[i].role === 'assistant') {
        next = i;
        break;
      }
    }
    end = next >= minEnd ? next : -1;
  }

  const windows = spans.map((span, i) => {
    const header = headerFor(span.start);
    const msgs = [...prefix, ...(header ? [header] : []), ...body.slice(span.start, span.end + 1)];
    return { messages: msgs, index: i + 1, of: spans.length, droppedBefore: span.start };
  });
  return { windows, rawTokens, clippedToolOutputs, oversized };
}

/**
 * Sessions + turn logs → canonical, scrubbed training examples.
 *
 * Granularity: one example per user turn. A CLI session holds many turns; each
 * example carries the earlier turns of the same session as compact history (user
 * prompt + final answer only — their tool traffic is dropped, which is also what
 * compaction does at runtime) followed by the full tool loop of its own turn.
 */
import * as crypto from 'crypto';
import { createDefaultSkillRegistry } from '@burtson-labs/agent-core';
import { buildSystemPrompt } from '../systemPrompt';
import { convertTranscript, parseToolResults, isNudge } from './protocol';
import { totalSecrets, type Scrubber } from './scrub';
import type { CliSession, HostTurn, StealthWebTurn } from './sources';
import type {
  CanonicalMessage,
  DroppedExample,
  ExampleLabels,
  ExampleStatus,
  NativeToolSchema,
  TrainingExample
} from './types';
import { emptyLabels, emptyRedactions } from './types';

export const SCRUB_VERSION = 'scrub-v1' as const;

// ---- tool schemas ------------------------------------------------------------------------

let cachedSchemas: Map<string, NativeToolSchema> | null = null;

export function knownToolSchemas(): Map<string, NativeToolSchema> {
  if (cachedSchemas) return cachedSchemas;
  const skills = createDefaultSkillRegistry();
  const { registry } = skills.buildToolRegistryWithMap(skills.getAll());
  cachedSchemas = new Map(registry.buildNativeToolsSchema().map(s => [s.function.name, s as NativeToolSchema]));
  return cachedSchemas;
}

/** Schemas for the tools an example uses; unknown (MCP) tools get a minimal string-param schema. */
export function schemasFor(messages: CanonicalMessage[]): NativeToolSchema[] {
  const known = knownToolSchemas();
  const out = new Map<string, NativeToolSchema>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const c of m.tool_calls) {
      const name = c.function.name;
      if (out.has(name)) continue;
      const schema = known.get(name);
      if (schema) {
        out.set(name, schema);
        continue;
      }
      let keys: string[] = [];
      try {
        keys = Object.keys(JSON.parse(c.function.arguments) as Record<string, unknown>);
      } catch { /* keep empty */ }
      out.set(name, {
        type: 'function',
        function: {
          name,
          description: '',
          parameters: { type: 'object', properties: Object.fromEntries(keys.map(k => [k, { type: 'string' }])), required: [] }
        }
      });
    }
  }
  return [...out.values()].sort((a, b) => a.function.name.localeCompare(b.function.name));
}

let cachedSystemPrompt: string | null = null;
/** The CLI's system prompt without the memory block (memory is personal; never exported). */
export function rebuiltSystemPrompt(): string {
  cachedSystemPrompt ??= buildSystemPrompt('');
  return cachedSystemPrompt;
}

// ---- drop rules --------------------------------------------------------------------------

const MAIL_TOOL_RE = /^(?:burtson-labs[.:_]|mail_|gmail|calendar|drive_|google[._-]?(?:mail|calendar|drive))/i;

export function dropReasonForTools(messages: CanonicalMessage[]): DroppedExample['reason'] | null {
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const c of m.tool_calls) {
      if (MAIL_TOOL_RE.test(c.function.name)) return 'email-or-calendar-tools';
      if (c.function.name === 'read_pdf' && /artifacts[\\/]/.test(c.function.arguments)) return 'client-document-tools';
    }
  }
  return null;
}

// ---- join --------------------------------------------------------------------------------

export function promptKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120).toLowerCase();
}

export interface JoinResult {
  /** turn index in the session → matched host turn */
  matches: Map<number, HostTurn>;
  matchedByPrompt: number;
  matchedByOrder: number;
}

const JOIN_SLACK_MS = 10 * 60 * 1000;

/**
 * Match a session's real user prompts (not tool results, not nudges) to host-kit turn
 * logs: same prompt prefix inside the session's time window first, then order within
 * the window for prompts that were expanded (mentions) before logging.
 */
export function joinSessionTurns(session: CliSession, turns: HostTurn[], used: Set<string>): JoinResult {
  const prompts: Array<{ index: number; key: string }> = [];
  let turnIndex = 0;
  for (const m of session.messages) {
    if (m.role !== 'user' || parseToolResults(m.content) || isNudge(m.content)) continue;
    prompts.push({ index: turnIndex++, key: promptKey(m.content) });
  }
  const start = (session.startedAt?.getTime() ?? session.endedAt.getTime()) - JOIN_SLACK_MS;
  const end = session.endedAt.getTime() + JOIN_SLACK_MS;
  const window = turns
    .filter(t => !used.has(t.path) && t.startedAt && t.startedAt.getTime() >= start && t.startedAt.getTime() <= end)
    .sort((a, b) => (a.startedAt!.getTime() - b.startedAt!.getTime()));

  const matches = new Map<number, HostTurn>();
  let matchedByPrompt = 0;
  let matchedByOrder = 0;
  for (const p of prompts) {
    const hit = window.find(t => !used.has(t.path) && promptKey(t.prompt) === p.key);
    if (hit) {
      matches.set(p.index, hit);
      used.add(hit.path);
      matchedByPrompt++;
    }
  }
  // Order fallback: walk unmatched prompts and unused window turns in time order.
  const leftover = window.filter(t => !used.has(t.path));
  for (const p of prompts) {
    if (matches.has(p.index)) continue;
    const prevMatched = [...matches.entries()].filter(([i]) => i < p.index).map(([, t]) => t.startedAt!.getTime());
    const after = prevMatched.length ? Math.max(...prevMatched) : -Infinity;
    const cand = leftover.find(t => !used.has(t.path) && t.startedAt!.getTime() > after);
    if (cand) {
      matches.set(p.index, cand);
      used.add(cand.path);
      matchedByOrder++;
    }
  }
  return { matches, matchedByPrompt, matchedByOrder };
}

function labelsFromTurn(turn: HostTurn | undefined, toolCalls: number, toolErrors: number): { labels: ExampleLabels; status: ExampleStatus; model: string | null } {
  const labels = emptyLabels();
  labels.toolCalls = toolCalls;
  labels.toolErrors = toolErrors;
  if (!turn) return { labels, status: 'unknown', model: null };
  labels.hitLimit = turn.summary.hitLimit;
  labels.permissionDenials = turn.summary.permissionDenials;
  labels.retries = turn.summary.retries;
  labels.compactions = turn.summary.compactions;
  labels.toolErrors = Math.max(toolErrors, turn.toolErrors);
  return { labels, status: turn.summary.status, model: turn.model };
}

// ---- example assembly --------------------------------------------------------------------

export interface BuildOptions {
  keepNudges?: boolean;
  maxSecrets?: number;
  /** Prior turns kept as history in each example. */
  maxHistoryTurns?: number;
  since?: Date;
}

export interface BuildAccumulator {
  examples: TrainingExample[];
  dropped: DroppedExample[];
  seenIds: Set<string>;
  stats: {
    sessions: number;
    sessionTurns: number;
    joinedByPrompt: number;
    joinedByOrder: number;
    unjoinedTurns: number;
    nudgesDropped: number;
    malformedToolCalls: number;
    unmatchedToolResults: number;
  };
}

export function newAccumulator(): BuildAccumulator {
  return {
    examples: [],
    dropped: [],
    seenIds: new Set(),
    stats: { sessions: 0, sessionTurns: 0, joinedByPrompt: 0, joinedByOrder: 0, unjoinedTurns: 0, nudgesDropped: 0, malformedToolCalls: 0, unmatchedToolResults: 0 }
  };
}

export function exampleId(messages: CanonicalMessage[]): string {
  return `ex_${crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex').slice(0, 12)}`;
}

/** Scrub, apply drop rules, dedupe, then keep or record the drop. Returns the drop reason, if any. */
export function finalizeExample(acc: BuildAccumulator, draft: TrainingExample, scrubber: Scrubber, options: BuildOptions): DroppedExample['reason'] | null {
  const toolDrop = dropReasonForTools(draft.messages);
  if (toolDrop) {
    acc.dropped.push({ ref: draft.sourceRef, source: draft.source, reason: toolDrop });
    return toolDrop;
  }
  if (!draft.messages.some(m => m.role === 'assistant')) {
    acc.dropped.push({ ref: draft.sourceRef, source: draft.source, reason: 'no-assistant-output' });
    return 'no-assistant-output';
  }
  const scrubbed = scrubber.scrubExample(draft);
  const secrets = totalSecrets(scrubbed.scrub.redactions);
  const max = options.maxSecrets ?? 25;
  if (secrets > max) {
    acc.dropped.push({ ref: scrubbed.sourceRef, source: draft.source, reason: 'too-many-secrets', detail: `${secrets} > ${max}` });
    return 'too-many-secrets';
  }
  scrubbed.id = exampleId(scrubbed.messages);
  if (acc.seenIds.has(scrubbed.id)) {
    acc.dropped.push({ ref: scrubbed.sourceRef, source: draft.source, reason: 'duplicate' });
    return 'duplicate';
  }
  acc.seenIds.add(scrubbed.id);
  acc.examples.push(scrubbed);
  return null;
}

/** Drops that taint the rest of a session: later turns may quote the mail or document. */
const SESSION_TAINT = new Set<DroppedExample['reason']>(['email-or-calendar-tools', 'client-document-tools', 'too-many-secrets']);

function draftExample(partial: Omit<TrainingExample, 'id' | 'tools' | 'scrub' | 'split'>): TrainingExample {
  return {
    ...partial,
    id: '',
    tools: schemasFor(partial.messages),
    scrub: { version: SCRUB_VERSION, redactions: emptyRedactions(), dropped: false },
    split: null
  };
}

/** Split a session's messages into turns: each starts at a real user prompt. */
export function splitTurns(messages: CliSession['messages']): Array<CliSession['messages']> {
  const turns: Array<CliSession['messages']> = [];
  let current: CliSession['messages'] | null = null;
  for (const m of messages) {
    const realPrompt = m.role === 'user' && !parseToolResults(m.content) && !isNudge(m.content);
    if (realPrompt) {
      current = [m];
      turns.push(current);
    } else if (current) {
      current.push(m);
    }
  }
  return turns;
}

export function addCliSession(
  acc: BuildAccumulator,
  session: CliSession,
  turns: HostTurn[],
  used: Set<string>,
  scrubber: Scrubber,
  options: BuildOptions
): void {
  acc.stats.sessions++;
  if (options.since && session.endedAt < options.since) return;
  const join = joinSessionTurns(session, turns, used);
  acc.stats.joinedByPrompt += join.matchedByPrompt;
  acc.stats.joinedByOrder += join.matchedByOrder;
  const sessionTurns = splitTurns(session.messages);
  acc.stats.sessionTurns += sessionTurns.length;
  const history: CanonicalMessage[] = [];
  const maxHistory = options.maxHistoryTurns ?? 3;
  let historyTurns = 0;
  let tainted: DroppedExample['reason'] | null = null;

  sessionTurns.forEach((turnMessages, i) => {
    if (tainted) {
      acc.dropped.push({ ref: `sessions/${session.id}#${i + 1}`, source: 'cli-session', reason: tainted, detail: 'later turn of a session with a sensitive turn' });
      return;
    }
    const { messages, stats } = convertTranscript(turnMessages, { keepNudges: options.keepNudges });
    acc.stats.nudgesDropped += stats.nudgesDropped;
    acc.stats.malformedToolCalls += stats.malformedCalls;
    acc.stats.unmatchedToolResults += stats.unmatchedResults;
    const host = join.matches.get(i);
    const { labels, status, model } = labelsFromTurn(host, stats.toolCalls, stats.toolErrors);
    labels.historyTurns = historyTurns;
    const draft = draftExample({
      source: 'cli-session',
      sourceRef: `sessions/${session.id}#${i + 1}`,
      createdAt: (host?.startedAt ?? session.startedAt ?? session.endedAt).toISOString(),
      model,
      status,
      labels,
      messages: [{ role: 'system', content: rebuiltSystemPrompt() }, ...history, ...messages]
    });
    const dropped = finalizeExample(acc, draft, scrubber, options);
    if (dropped && SESSION_TAINT.has(dropped)) {
      tainted = dropped;
      return;
    }

    // Compact history for later turns: prompt + final answer only.
    const prompt = messages.find(m => m.role === 'user');
    const final = [...messages].reverse().find(m => m.role === 'assistant' && !m.tool_calls?.length && m.content);
    if (prompt && final) {
      history.push(prompt, { role: 'assistant', content: final.content });
      historyTurns++;
      while (historyTurns > maxHistory) {
        history.splice(0, 2);
        historyTurns--;
      }
    }
  });
}

export function addStealthWebTurn(acc: BuildAccumulator, turn: StealthWebTurn, scrubber: Scrubber, options: BuildOptions): void {
  const ref = `stealth-web/${turn.id}`;
  if (turn.provider === 'import') {
    acc.dropped.push({ ref, source: 'stealth-web', reason: 'imported-transcript' });
    return;
  }
  if (options.since && turn.startedAt && turn.startedAt < options.since) return;
  // Rebuild a text-protocol transcript from events so one converter handles both hosts.
  const transcript: Array<{ role: string; content: string }> = [];
  let pendingCalls: Array<Record<string, unknown>> = [];
  const flushCalls = (): void => {
    if (!pendingCalls.length) return;
    const lastAssistant = [...transcript].reverse().find(m => m.role === 'assistant');
    const callsMarkup = pendingCalls
      .map(c => `<tool_call>${JSON.stringify({ name: c.name, params: c.params ?? {} })}</tool_call>`)
      .join('\n');
    // Only add markup for calls the assistant text did not already carry inline.
    if (lastAssistant && !lastAssistant.content.includes('<tool_call>')) lastAssistant.content += `\n${callsMarkup}`;
    else if (!lastAssistant) transcript.push({ role: 'assistant', content: callsMarkup });
    transcript.push({
      role: 'user',
      content: pendingCalls
        .map(c => `<tool_result name="${String(c.name)}"${c.isError ? ' status="error"' : ''}>\n${typeof c.output === 'string' ? c.output : ''}\n</tool_result>`)
        .join('\n')
    });
    pendingCalls = [];
  };
  for (const e of turn.events) {
    if (e.type === 'message' && (e.role === 'user' || e.role === 'assistant') && typeof e.content === 'string') {
      if (e.role === 'user') flushCalls();
      if (e.role === 'assistant' && pendingCalls.length) flushCalls();
      transcript.push({ role: e.role, content: e.content });
    } else if (e.type === 'tool_call') {
      pendingCalls.push(e);
    }
  }
  flushCalls();
  const final = turn.end?.finalResponse;
  if (final && !transcript.some(m => m.role === 'assistant' && m.content.includes(final.slice(0, 40)))) {
    transcript.push({ role: 'assistant', content: final });
  }
  const { messages, stats } = convertTranscript(transcript, { keepNudges: options.keepNudges });
  acc.stats.nudgesDropped += stats.nudgesDropped;
  acc.stats.malformedToolCalls += stats.malformedCalls;
  const labels = emptyLabels();
  labels.toolCalls = stats.toolCalls;
  labels.toolErrors = stats.toolErrors;
  labels.hitLimit = !!turn.end?.hitLimit;
  const status: ExampleStatus = !turn.end ? 'unknown' : turn.end.cancelled ? 'cancelled' : turn.end.hitLimit ? 'failed' : 'completed';
  finalizeExample(acc, draftExample({
    source: 'stealth-web',
    sourceRef: ref,
    createdAt: (turn.startedAt ?? new Date(0)).toISOString(),
    model: turn.model,
    status,
    labels,
    messages: [{ role: 'system', content: rebuiltSystemPrompt() }, ...messages]
  }), scrubber, options);
}

/** BanditBench traces are already canonical (written by `eval --trace-out`); they still get scrubbed. */
export function addBanditBenchTrace(acc: BuildAccumulator, trace: TrainingExample, ref: string, scrubber: Scrubber, options: BuildOptions): void {
  if (!Array.isArray(trace.messages)) {
    acc.dropped.push({ ref, source: 'banditbench', reason: 'unparseable' });
    return;
  }
  finalizeExample(acc, { ...trace, source: 'banditbench', sourceRef: ref, tools: trace.tools?.length ? trace.tools : schemasFor(trace.messages) }, scrubber, options);
}

// ---- manifest ----------------------------------------------------------------------------

export function estimateTokens(example: TrainingExample): number {
  return Math.ceil(JSON.stringify(example.messages).length / 4);
}

export interface Manifest {
  datasetId: string;
  createdAt: string;
  scrubVersion: typeof SCRUB_VERSION;
  format: 'openai-chat-tools-v1';
  examples: number;
  dropped: number;
  bySource: Record<string, number>;
  byStatus: Record<string, number>;
  byModel: Record<string, number>;
  byTool: Record<string, number>;
  tokens: { total: number; mean: number; p50: number; p95: number; max: number; histogram: Record<string, number> };
  redactions: Record<string, number>;
  collector: { host: 'bandit-cli'; version: string; options: Record<string, unknown> };
  selfCheck: { passed: boolean; hits: number };
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

export function buildManifest(examples: TrainingExample[], dropped: DroppedExample[], extra: { version: string; options: Record<string, unknown>; selfCheckHits: number }): Manifest {
  const bySource: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  const redactions: Record<string, number> = {};
  const tokens: number[] = [];
  for (const ex of examples) {
    bump(bySource, ex.source);
    bump(byStatus, ex.status);
    bump(byModel, ex.model ?? 'unknown');
    for (const m of ex.messages) {
      if (m.role === 'assistant' && m.tool_calls) for (const c of m.tool_calls) bump(byTool, c.function.name);
    }
    for (const [k, v] of Object.entries(ex.scrub.redactions)) bump(redactions, k, v);
    tokens.push(estimateTokens(ex));
  }
  tokens.sort((a, b) => a - b);
  const pct = (p: number): number => (tokens.length ? tokens[Math.min(tokens.length - 1, Math.floor(p * tokens.length))] : 0);
  const histogram: Record<string, number> = {};
  for (const t of tokens) {
    const bucket = t <= 1024 ? '≤1k' : t <= 4096 ? '1k-4k' : t <= 8192 ? '4k-8k' : t <= 16384 ? '8k-16k' : t <= 32768 ? '16k-32k' : '>32k';
    bump(histogram, bucket);
  }
  const total = tokens.reduce((a, b) => a + b, 0);
  const createdAt = new Date().toISOString();
  const hash = crypto.createHash('sha256').update(examples.map(e => e.id).join(',')).digest('hex').slice(0, 8);
  return {
    datasetId: `ds_${createdAt.slice(0, 10).replace(/-/g, '')}_${hash}`,
    createdAt,
    scrubVersion: SCRUB_VERSION,
    format: 'openai-chat-tools-v1',
    examples: examples.length,
    dropped: dropped.length,
    bySource,
    byStatus,
    byModel,
    byTool,
    tokens: { total, mean: tokens.length ? Math.round(total / tokens.length) : 0, p50: pct(0.5), p95: pct(0.95), max: tokens[tokens.length - 1] ?? 0, histogram },
    redactions,
    collector: { host: 'bandit-cli', version: extra.version, options: extra.options },
    selfCheck: { passed: extra.selfCheckHits === 0, hits: extra.selfCheckHits }
  };
}

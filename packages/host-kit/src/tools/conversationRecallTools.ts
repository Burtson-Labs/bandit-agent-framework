/**
 * Conversation recall: `search_conversations` and `read_conversation`.
 *
 * The agent's way to read what the user actually said in an earlier Bandit
 * chat instead of guessing from a title or from memory. Both tools call the
 * gateway's recall endpoints:
 *
 *   GET {gateway}/api/v1/conversations/search?q=&limit=&before=
 *   GET {gateway}/api/v1/conversations/{id}/recall?maxMessages=&fromTurn=
 *
 * The server scopes every request to the signed-in account:
 *
 *   - only the user's own conversations, and only the ones synced to their
 *     Bandit account (sync off or a local model means the server never saw them);
 *   - never another user's chats, a teammate's included;
 *   - never history from another AI provider;
 *   - within a Team workspace's retention period when one is set.
 *
 * The endpoints sit behind [BurtsonAuthorize] (gateway JWT), so a `bai_`
 * device key is exchanged first (resolveGatewayToken), like the Stash tools.
 * Cloud-only: hosts register these only for a Bandit Cloud session and never
 * in offline mode; both names are in NETWORK_TOOLS, so they also ask by
 * default and the offline gate refuses them.
 *
 * Same tool names, parameters and output text as the Stealth IDE/CLI/Chrome
 * copies (bandit-stealth packages/bandit-skills/src/conversationRecall.ts),
 * so a model sees one tool everywhere.
 */
import type { AgentTool, ToolResult } from '@burtson-labs/agent-core';
import { resolveGatewayToken } from '../artifacts';

export const SEARCH_CONVERSATIONS_TOOL_NAME = 'search_conversations';
export const READ_CONVERSATION_TOOL_NAME = 'read_conversation';
export const CONVERSATION_RECALL_TOOL_NAMES: readonly string[] = [
  SEARCH_CONVERSATIONS_TOOL_NAME,
  READ_CONVERSATION_TOOL_NAME
];

export const CONVERSATION_SEARCH_PATH = '/api/v1/conversations/search';
export const conversationRecallPath = (id: string): string =>
  `/api/v1/conversations/${encodeURIComponent(id)}/recall`;

/** Longest tool output either tool returns; the rest is cut with a note. */
export const RECALL_OUTPUT_CAP = 60_000;
export const SEARCH_LIMIT_MAX = 20;
export const READ_TURNS_MAX = 50;

/** What the tools tell the model about their reach, in one line. */
export const RECALL_SCOPE_LINE =
  "Covers the user's own Bandit conversations that are synced to their Bandit account: not other people's chats, not local-only chats (sync off or a local model), not history from other AI assistants.";

export interface ConversationRecallToolOptions {
  /** Bandit cloud credential: a `bai_` device key (exchanged) or a gateway JWT. */
  token: string;
  /** Gateway origin, e.g. https://api.burtson.ai (no trailing /api). */
  gatewayBaseUrl: string;
  /** AuthApi base for the `bai_` → JWT exchange; defaults to auth.burtson.ai. */
  authBaseUrl?: string;
  /** Which client is asking, sent as X-Bandit-Origin (e.g. "vscode"). */
  origin?: string;
  fetchImpl?: typeof fetch;
}

// ── Response shapes (GatewayApi ConversationRecallModels) ───────────────────

export interface ConversationSearchSnippet {
  turnIndex: number | null;
  role: 'title' | 'user' | 'assistant' | string;
  text: string;
}

export interface ConversationSearchHit {
  id: string;
  title: string;
  updatedAt: string;
  model?: string | null;
  projectId?: string | null;
  turnCount: number;
  snippet: ConversationSearchSnippet;
  matchedTerms: number;
}

export interface ConversationSearchResponse {
  query: string;
  results: ConversationSearchHit[];
  hasMore: boolean;
  nextBefore?: string | null;
  scope?: string;
}

export interface ConversationRecallTurn {
  index: number;
  question: string;
  answer: string;
  questionTruncated?: boolean;
  answerTruncated?: boolean;
  toolsUsed?: string[] | null;
}

export interface ConversationRecallResponse {
  id: string;
  title: string;
  updatedAt: string;
  model?: string | null;
  projectId?: string | null;
  summary?: string | null;
  turnCount: number;
  fromTurn: number;
  turns: ConversationRecallTurn[];
  hasEarlier: boolean;
  hasLater: boolean;
  scope?: string;
}

/** A gateway JSON GET's outcome; status 0 means it never got an answer. */
export interface RecallHttpResult {
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
}

// ── Formatting for the model ────────────────────────────────────────────────

function day(iso: string | undefined): string {
  if (!iso) {return 'unknown date';}
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

function cap(text: string, max = RECALL_OUTPUT_CAP): string {
  if (text.length <= max) {return text;}
  return `${text.slice(0, max)}\n… (cut at ${max} characters; ask for fewer turns with max_messages, or a later from_turn)`;
}

/** The search results as the model should read them: one line per conversation. */
export function formatSearchResults(res: ConversationSearchResponse): string {
  const results = Array.isArray(res.results) ? res.results : [];
  if (results.length === 0) {
    return (
      `No synced Bandit conversations match "${res.query}". ` +
      'Try other words from what the user said, or fewer words; a chat with sync off or from another assistant will not be here. ' +
      RECALL_SCOPE_LINE
    );
  }
  const lines = results.map((hit, i) => {
    const where =
      hit.snippet?.role === 'title'
        ? 'matched the title'
        : `matched ${hit.snippet?.role === 'assistant' ? "Bandit's reply" : 'the user'} at turn ${hit.snippet?.turnIndex ?? '?'}`;
    const snippet = hit.snippet?.text ? `: "${hit.snippet.text}"` : '';
    return `${i + 1}. id=${hit.id} — "${hit.title || '(untitled)'}" — ${day(hit.updatedAt)}, ${hit.turnCount} turn${hit.turnCount === 1 ? '' : 's'}; ${where}${snippet}`;
  });
  const parts = [
    `${results.length} synced Bandit conversation${results.length === 1 ? ' matches' : 's match'} "${res.query}" (newest first):`,
    ...lines
  ];
  if (res.hasMore && res.nextBefore) {
    parts.push(`Older matches exist: call ${SEARCH_CONVERSATIONS_TOOL_NAME} again with before="${res.nextBefore}".`);
  }
  parts.push(
    `Next: call ${READ_CONVERSATION_TOOL_NAME} with the id of each likely conversation and answer from what was actually said, not from the title.`
  );
  parts.push(RECALL_SCOPE_LINE);
  return cap(parts.join('\n'));
}

/** One conversation's turns as a transcript the model can quote from. */
export function formatConversation(res: ConversationRecallResponse): string {
  const turns = Array.isArray(res.turns) ? res.turns : [];
  const first = turns[0]?.index ?? res.fromTurn;
  const last = turns.length ? turns[turns.length - 1].index : res.fromTurn;
  const header = [
    `Conversation "${res.title || '(untitled)'}" (id=${res.id}), last updated ${day(res.updatedAt)}, ${res.turnCount} turn${res.turnCount === 1 ? '' : 's'} in total${res.model ? `, model ${res.model}` : ''}.`
  ];
  if (res.summary) {header.push(`Summary on file: ${res.summary}`);}
  if (turns.length === 0) {
    header.push('It has no messages.');
    return header.join('\n');
  }
  header.push(
    `Showing turns ${first}–${last}${res.hasLater ? '' : ' (the newest)'}.` +
      (res.hasEarlier ? ` Earlier turns exist: call again with from_turn=0 (or any index below ${first}).` : '') +
      (res.hasLater ? ` Later turns exist: call again with from_turn=${last + 1}.` : '')
  );
  const body = turns.map((t) => {
    const lines = [`--- turn ${t.index} ---`, `User: ${t.question}${t.questionTruncated ? ' [cut]' : ''}`];
    if (t.toolsUsed && t.toolsUsed.length) {lines.push(`(Bandit used: ${t.toolsUsed.join(', ')})`);}
    lines.push(`Bandit: ${t.answer}${t.answerTruncated ? ' [cut]' : ''}`);
    return lines.join('\n');
  });
  return cap([...header, ...body].join('\n'));
}

// ── Shared plumbing ─────────────────────────────────────────────────────────

/** A user-facing line for a failed gateway call, by status. */
export function describeRecallFailure(tool: string, res: RecallHttpResult): string {
  switch (res.status) {
    case 401:
    case 403:
      return `${tool}: Bandit Cloud did not accept this session (${res.status}). Sign in again and retry.`;
    case 404:
      return `${tool}: no such conversation in this account. It may belong to someone else, have been deleted, never been synced, or be past your workspace's retention period. Search again rather than guessing the id.`;
    case 429:
      return `${tool}: too many recall calls in a minute. Wait a moment, then try once more with a narrower search.`;
    case 0:
      return `${tool}: could not reach Bandit Cloud${res.error ? ` (${res.error})` : ''}.`;
    default:
      return `${tool}: Bandit Cloud answered ${res.status}${res.error ? `: ${res.error}` : ''}.`;
  }
}

function intParam(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || value === null || String(value).trim() === '') {return undefined;}
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) {return undefined;}
  return Math.min(max, Math.max(min, n));
}

/** GET a recall endpoint with the session's credential. Never throws. */
export async function recallGetJson(
  opts: ConversationRecallToolOptions,
  path: string,
  query: Record<string, string | number | undefined>
): Promise<RecallHttpResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let bearer: string;
  try {
    bearer = await resolveGatewayToken(opts.token, { authBaseUrl: opts.authBaseUrl, fetchImpl });
  } catch (err) {
    // The key exchange failed: treat it as the session not being accepted.
    return { ok: false, status: 401, data: null, error: err instanceof Error ? err.message : String(err) };
  }
  let url: URL;
  try {
    url = new URL(`${opts.gatewayBaseUrl.replace(/\/+$/, '')}${path}`);
  } catch {
    return { ok: false, status: 0, data: null, error: `bad gateway URL "${opts.gatewayBaseUrl}"` };
  }
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {url.searchParams.set(key, String(value));}
  }
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: 'application/json',
        ...(opts.origin ? { 'x-bandit-origin': opts.origin } : {})
      }
    });
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err instanceof Error ? err.message : String(err) };
  }
  const text = await res.text().catch(() => '');
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const body = (data ?? {}) as { error?: unknown; message?: unknown };
  const reason = [body.error, body.message].find((v) => typeof v === 'string' && v.trim());
  return {
    ok: res.ok,
    status: res.status,
    data,
    error: res.ok ? undefined : ((reason as string | undefined) ?? `${res.status} ${res.statusText ?? ''}`.trim())
  };
}

// ── The tools ───────────────────────────────────────────────────────────────

export function buildSearchConversationsTool(opts: ConversationRecallToolOptions): AgentTool {
  return {
    name: SEARCH_CONVERSATIONS_TOOL_NAME,
    description:
      "Search the user's own past Bandit conversations (the ones synced to their Bandit account) by words in the title or in the messages. " +
      'Use it whenever the user refers to an earlier chat or to something settled before: "what did we decide about…", "my chats about X", "last time we talked about…", "the plan we made", "remind me what you suggested". ' +
      `Do not guess from conversation titles or from memory: search, then call ${READ_CONVERSATION_TOOL_NAME} on the likely conversations and answer from the actual messages. ` +
      'Returns matches newest first with an id, title, date, turn count and a snippet around the match. ' +
      RECALL_SCOPE_LINE,
    parameters: [
      {
        name: 'query',
        description:
          'Words to look for in titles and messages (2–8 distinct words work best; quote a phrase to match it exactly). Use the words the user is likely to have typed, not a question.',
        required: true
      },
      {
        name: 'limit',
        description: `How many conversations to return (1–${SEARCH_LIMIT_MAX}; default 10).`,
        required: false
      },
      {
        name: 'before',
        description: 'ISO date-time from a previous result\'s "before" hint, to page to older matches.',
        required: false
      }
    ],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      const query = String(params?.query ?? '').trim();
      if (!query) {
        return { output: `${SEARCH_CONVERSATIONS_TOOL_NAME}: "query" is required.`, isError: true };
      }
      const limit = intParam(params?.limit, 1, SEARCH_LIMIT_MAX);
      const before = String(params?.before ?? '').trim() || undefined;
      const res = await recallGetJson(opts, CONVERSATION_SEARCH_PATH, { q: query, limit, before });
      if (!res.ok) {
        return { output: describeRecallFailure(SEARCH_CONVERSATIONS_TOOL_NAME, res), isError: true };
      }
      const body = (res.data ?? {}) as Partial<ConversationSearchResponse>;
      return {
        output: formatSearchResults({
          query: body.query ?? query,
          results: body.results ?? [],
          hasMore: Boolean(body.hasMore),
          nextBefore: body.nextBefore ?? null
        })
      };
    }
  };
}

export function buildReadConversationTool(opts: ConversationRecallToolOptions): AgentTool {
  return {
    name: READ_CONVERSATION_TOOL_NAME,
    description:
      `Read the messages of one of the user's own past Bandit conversations, by the id ${SEARCH_CONVERSATIONS_TOOL_NAME} returned. ` +
      'Returns the newest turns by default (user message and Bandit reply, in order, with turn numbers); pass from_turn to start earlier and max_messages for more at once. ' +
      'Quote or summarise from what was actually said; if the first page does not settle the question, read the earlier turns before answering. ' +
      RECALL_SCOPE_LINE,
    parameters: [
      {
        name: 'id',
        description: `The conversation id from ${SEARCH_CONVERSATIONS_TOOL_NAME}.`,
        required: true
      },
      {
        name: 'max_messages',
        description: `How many turns to return (1–${READ_TURNS_MAX}; default 20). A turn is one user message and its reply.`,
        required: false
      },
      {
        name: 'from_turn',
        description: 'Zero-based turn index to start from. Omit to get the newest turns.',
        required: false
      }
    ],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      const id = String(params?.id ?? '').trim();
      if (!id) {
        return {
          output: `${READ_CONVERSATION_TOOL_NAME}: "id" is required; get one from ${SEARCH_CONVERSATIONS_TOOL_NAME}.`,
          isError: true
        };
      }
      const maxMessages = intParam(params?.max_messages, 1, READ_TURNS_MAX);
      const fromTurn = intParam(params?.from_turn, 0, Number.MAX_SAFE_INTEGER);
      const res = await recallGetJson(opts, conversationRecallPath(id), { maxMessages, fromTurn });
      if (!res.ok) {
        return { output: describeRecallFailure(READ_CONVERSATION_TOOL_NAME, res), isError: true };
      }
      const body = (res.data ?? {}) as Partial<ConversationRecallResponse>;
      return {
        output: formatConversation({
          id: body.id ?? id,
          title: body.title ?? '',
          updatedAt: body.updatedAt ?? '',
          model: body.model ?? null,
          summary: body.summary ?? null,
          turnCount: body.turnCount ?? body.turns?.length ?? 0,
          fromTurn: body.fromTurn ?? 0,
          turns: body.turns ?? [],
          hasEarlier: Boolean(body.hasEarlier),
          hasLater: Boolean(body.hasLater)
        })
      };
    }
  };
}

/**
 * Tool-use transcript logger — records every LLM response, tool call, and
 * tool result to a JSONL file under the workspace's .bandit/turns/ folder.
 *
 * Motivation: the agent occasionally claims to have done something it
 * didn't. Without a record of what it emitted, diagnosis is impossible.
 * This writes a per-turn log we can point at later to answer "what did
 * the model actually try?".
 *
 * Format: one JSON object per line. Events:
 *   { t, type: 'user-prompt', prompt }
 *   { t, type: 'llm-response', iteration, textPreview }
 *   { t, type: 'tool-execute', iteration, name, params }
 *   { t, type: 'tool-result', iteration, name, isError, outputPreview }
 *   { t, type: 'tool-error', iteration, name, error }
 *   { t, type: 'tool-blocked', iteration, name, reason }
 *   { t, type: 'permission-request', name, primary, risk }
 *   { t, type: 'permission-decision', name, primary, choice }
 *   { t, type: 'permission-denied', name, primary, source, reason }
 *   { t, type: 'final-response', iterations, hitLimit, finalPreview }
 *
 * Keeping this in host-kit so both CLI and extension can use the same
 * logger without duplicating code.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MAX_PREVIEW_CHARS = 2048;
const LOG_DIR = '.bandit/turns';

export interface TurnLogger {
  append(event: Record<string, unknown>): Promise<void>;
  readonly filePath: string;
}

export interface TurnLogEvent {
  t?: string;
  type: string;
  [key: string]: unknown;
}

export interface TurnTrace {
  id: string;
  filePath: string;
  events: TurnLogEvent[];
  summary: TurnTraceSummary;
}

export type TurnTraceScope = 'workspace' | 'global' | 'external';

export interface TurnTraceSummary {
  id: string;
  filePath: string;
  scope: TurnTraceScope;
  workspace: string;
  startedAt?: string;
  prompt?: string;
  finalPreview?: string;
  iterations: number;
  hitLimit: boolean;
  toolCalls: number;
  tools: string[];
  blockedTools: number;
  errors: number;
  retries: number;
  nativeFallbacks: number;
  permissionRequests: number;
  permissionDecisions: number;
  permissionDenials: number;
  compactions: number;
  checkpoints: number;
  status: 'completed' | 'failed' | 'blocked' | 'cancelled' | 'unknown';
}

export interface TurnTraceListOptions {
  limit?: number;
  includeGlobal?: boolean;
  status?: TurnTraceSummary['status'] | TurnTraceSummary['status'][];
}

interface ReadTurnTraceOptions {
  workspaceRoot?: string;
}

function normalizeListOptions(optionsOrLimit?: number | TurnTraceListOptions): Required<Omit<TurnTraceListOptions, 'status'>> & Pick<TurnTraceListOptions, 'status'> {
  if (typeof optionsOrLimit === 'number') {
    return { limit: optionsOrLimit, includeGlobal: false, status: undefined };
  }
  return {
    limit: optionsOrLimit?.limit ?? 20,
    includeGlobal: optionsOrLimit?.includeGlobal ?? false,
    status: optionsOrLimit?.status
  };
}

/**
 * Open a log file for a single agent turn. The filename includes a UTC
 * timestamp and a random suffix so parallel turns (rare) can't collide.
 */
export async function openTurnLog(workspaceRoot: string): Promise<TurnLogger> {
  const dir = path.resolve(workspaceRoot, LOG_DIR);
  await fs.promises.mkdir(dir, { recursive: true });
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  const filePath = path.join(dir, `turn-${iso}-${rand}.jsonl`);
  return {
    filePath,
    async append(event: Record<string, unknown>): Promise<void> {
      try {
        const line = JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n';
        await fs.promises.appendFile(filePath, line);
      } catch {
        // Logging must never break the agent. Swallow write errors.
      }
    }
  };
}

/** Truncate a string for log preview — protects against multi-MB tool outputs. */
export function previewText(s: unknown): string {
  const str = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  return str.length > MAX_PREVIEW_CHARS ? str.slice(0, MAX_PREVIEW_CHARS) + `\n[…truncated, full length ${str.length}]` : str;
}

function traceDirs(workspaceRoot: string, includeGlobal: boolean): string[] {
  const dirs = [path.resolve(workspaceRoot, LOG_DIR)];
  if (includeGlobal) dirs.push(path.join(os.homedir(), LOG_DIR));
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

function isInside(childPath: string, parentPath: string): boolean {
  const rel = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function traceScope(filePath: string, workspaceRoot?: string): TurnTraceScope {
  if (workspaceRoot && isInside(filePath, path.resolve(workspaceRoot, LOG_DIR))) return 'workspace';
  if (isInside(filePath, path.join(os.homedir(), LOG_DIR))) return 'global';
  return 'external';
}

function expandHome(value: string): string {
  const home = os.homedir();
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

function collectStringValues(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStringValues(item, out);
  }
}

function inferWorkspaceFromText(value: string): string | null {
  const home = os.homedir();
  const expanded = expandHome(value);
  const githubRoot = path.join(home, 'Documents', 'GitHub') + path.sep;
  const githubIndex = expanded.indexOf(githubRoot);
  if (githubIndex >= 0) {
    const rest = expanded.slice(githubIndex + githubRoot.length);
    const repo = rest.split(/[/"'`\s:]+/)[0];
    if (repo) return path.join(githubRoot, repo);
  }
  return null;
}

function inferTraceWorkspace(events: TurnLogEvent[], fallbackWorkspace: string): string {
  const candidates = new Map<string, number>();
  for (const event of events) {
    const values: string[] = [];
    collectStringValues(event.prompt, values);
    collectStringValues(event.params, values);
    collectStringValues(event.outputPreview, values);
    collectStringValues(event.outputSnippet, values);
    collectStringValues(event.finalPreview, values);
    collectStringValues(event.responsePreview, values);
    for (const value of values) {
      const inferred = inferWorkspaceFromText(value);
      if (inferred) candidates.set(inferred, (candidates.get(inferred) ?? 0) + 1);
    }
  }
  const [top] = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
  return top?.[0] ?? fallbackWorkspace;
}

function shortPath(value: string): string {
  const home = os.homedir();
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

export async function listTurnTraceFiles(workspaceRoot: string, optionsOrLimit: number | TurnTraceListOptions = 20): Promise<string[]> {
  const options = normalizeListOptions(optionsOrLimit);
  const dirs = traceDirs(workspaceRoot, options.includeGlobal);
  const seen = new Set<string>();
  const stamped: Array<{ filePath: string; mtime: number }> = [];
  for (const dir of dirs) {
    const entries = await listTurnTraceFilesInDir(dir);
    for (const entry of entries) {
      const key = path.resolve(entry.filePath);
      if (seen.has(key)) continue;
      seen.add(key);
      stamped.push(entry);
    }
  }
  stamped.sort((a, b) => b.mtime - a.mtime);
  return stamped.slice(0, Math.max(0, options.limit)).map((entry) => entry.filePath);
}

async function listTurnTraceFilesInDir(dir: string): Promise<Array<{ filePath: string; mtime: number }>> {
  try {
    const files = (await fs.promises.readdir(dir))
      .filter((file) => file.endsWith('.jsonl'));
    return Promise.all(files.map(async (file) => {
      const filePath = path.join(dir, file);
      try {
        const stat = await fs.promises.stat(filePath);
        return { filePath, mtime: stat.mtimeMs };
      } catch {
        return { filePath, mtime: 0 };
      }
    }));
  } catch {
    return [];
  }
}

export async function listTurnTraces(workspaceRoot: string, optionsOrLimit: number | TurnTraceListOptions = 20): Promise<TurnTrace[]> {
  const options = normalizeListOptions(optionsOrLimit);
  const files = await listTurnTraceFiles(workspaceRoot, options);
  const traces: TurnTrace[] = [];
  for (const filePath of files) {
    const trace = await readTurnTrace(filePath, { workspaceRoot });
    if (trace) traces.push(trace);
  }
  const statuses = Array.isArray(options.status)
    ? options.status
    : options.status
      ? [options.status]
      : null;
  return statuses ? traces.filter((trace) => statuses.includes(trace.summary.status)) : traces;
}

export async function readTurnTrace(filePath: string, options: ReadTurnTraceOptions = {}): Promise<TurnTrace | null> {
  try {
    const resolved = path.resolve(filePath);
    const text = await fs.promises.readFile(filePath, 'utf-8');
    const events = parseTurnLog(text);
    const id = traceIdFromPath(resolved);
    return {
      id,
      filePath: resolved,
      events,
      summary: summarizeTurnTrace(id, resolved, events, options)
    };
  } catch {
    return null;
  }
}

export async function readTurnTraceById(workspaceRoot: string, idOrPath: string, optionsOrLimit: number | TurnTraceListOptions = 200): Promise<TurnTrace | null> {
  const trimmed = idOrPath.trim();
  if (!trimmed) return null;
  if (trimmed.includes(path.sep) || trimmed.endsWith('.jsonl')) {
    return readTurnTrace(path.resolve(workspaceRoot, trimmed), { workspaceRoot });
  }
  const options = normalizeListOptions(optionsOrLimit);
  const searchLimit = typeof optionsOrLimit === 'number'
    ? options.limit
    : optionsOrLimit.limit ?? 500;
  const files = await listTurnTraceFiles(workspaceRoot, { ...options, limit: searchLimit });
  const match = files.find((filePath) => traceIdFromPath(filePath) === trimmed || path.basename(filePath) === trimmed);
  return match ? readTurnTrace(match, { workspaceRoot }) : null;
}

export function parseTurnLog(text: string): TurnLogEvent[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return typeof parsed.type === 'string' ? parsed as TurnLogEvent : null;
      } catch {
        return null;
      }
    })
    .filter((event): event is TurnLogEvent => event !== null);
}

export function summarizeTurnTrace(id: string, filePath: string, events: TurnLogEvent[], options: ReadTurnTraceOptions = {}): TurnTraceSummary {
  const tools = new Set<string>();
  let toolCalls = 0;
  let blockedTools = 0;
  let errors = 0;
  let retries = 0;
  let nativeFallbacks = 0;
  let permissionRequests = 0;
  let permissionDecisions = 0;
  let permissionDenials = 0;
  let compactions = 0;
  let checkpoints = 0;
  let iterations = 0;
  let hitLimit = false;
  let prompt: string | undefined;
  let finalPreview: string | undefined;
  let status: TurnTraceSummary['status'] = 'unknown';

  for (const event of events) {
    const type = event.type;
    const iteration = typeof event.iteration === 'number' ? event.iteration : undefined;
    if (iteration !== undefined) iterations = Math.max(iterations, iteration);
    if (type === 'user-prompt' && typeof event.prompt === 'string') prompt = event.prompt;
    if (type === 'final-response') {
      status = 'completed';
      finalPreview = typeof event.finalPreview === 'string'
        ? event.finalPreview
        : typeof event.response === 'string'
          ? event.response
          : finalPreview;
      hitLimit = !!event.hitLimit;
      if (typeof event.iterations === 'number') iterations = Math.max(iterations, event.iterations);
    }
    if (type === 'tool-execute' || type === 'subagent-tool-execute') {
      toolCalls++;
      if (typeof event.name === 'string') tools.add(event.name);
    }
    if (type === 'tool-calls' || type === 'subagent-tool-calls') {
      const emitted = Array.isArray(event.tools) ? event.tools.filter((tool): tool is string => typeof tool === 'string') : [];
      emitted.forEach((tool) => tools.add(tool));
    }
    if (type === 'tool-blocked' || type === 'subagent-tool-blocked') {
      blockedTools++;
      status = status === 'unknown' ? 'blocked' : status;
    }
    if (type.includes('error') || type === 'tool-not-found') {
      errors++;
      status = status === 'unknown' ? 'failed' : status;
    }
    if (type === 'cancelled') status = 'cancelled';
    if (type.endsWith('retry') || type === 'llm-retry' || type === 'empty-retry' || type === 'parse-retry') retries++;
    if (type === 'native-tool-fallback') nativeFallbacks++;
    if (type === 'permission-request') permissionRequests++;
    if (type === 'permission-decision') permissionDecisions++;
    if (type === 'permission-denied') {
      permissionDenials++;
      status = status === 'unknown' ? 'blocked' : status;
    }
    if (type === 'compacted') compactions++;
    if (type === 'checkpoint') checkpoints++;
  }

  if (hitLimit && status === 'completed') status = 'failed';

  const scope = traceScope(filePath, options.workspaceRoot);
  const workspace = inferTraceWorkspace(events, options.workspaceRoot ?? process.cwd());

  return {
    id,
    filePath,
    scope,
    workspace,
    startedAt: events.find((event) => typeof event.t === 'string')?.t,
    prompt,
    finalPreview,
    iterations,
    hitLimit,
    toolCalls,
    tools: Array.from(tools).sort(),
    blockedTools,
    errors,
    retries,
    nativeFallbacks,
    permissionRequests,
    permissionDecisions,
    permissionDenials,
    compactions,
    checkpoints,
    status
  };
}

export function formatTurnTraceMarkdown(trace: TurnTrace, options: { maxEvents?: number } = {}): string {
  const { summary } = trace;
  const maxEvents = options.maxEvents ?? 40;
  const tools = summary.tools.length > 0 ? summary.tools.join(', ') : '(none)';
  const lines: string[] = [
    `## Trace ${summary.id}`,
    '',
    `- Status: ${summary.status}${summary.hitLimit ? ' (iteration limit)' : ''}`,
    `- Started: ${summary.startedAt ?? '(unknown)'}`,
    `- Iterations: ${summary.iterations}`,
    `- Tools: ${summary.toolCalls} calls · ${tools}`,
    `- Recovery: ${summary.retries} retries · ${summary.nativeFallbacks} native fallbacks · ${summary.compactions} compactions`,
    `- Permissions: ${summary.permissionRequests} prompts · ${summary.permissionDecisions} decisions · ${summary.permissionDenials} denials`,
    `- Blocks/errors: ${summary.blockedTools} blocked · ${summary.errors} errors`,
    `- Source: ${summary.scope} · ${shortPath(summary.workspace)}`,
    `- File: \`${summary.filePath}\``
  ];
  if (summary.prompt) {
    lines.push('', '### Prompt', fence(summary.prompt));
  }
  lines.push('', '### Timeline');
  const timeline = trace.events.slice(0, maxEvents).map(formatTraceEventLine);
  lines.push(...(timeline.length ? timeline : ['_No events recorded._']));
  if (trace.events.length > maxEvents) {
    lines.push(`_… ${trace.events.length - maxEvents} more events hidden._`);
  }
  if (summary.finalPreview) {
    lines.push('', '### Final', fence(summary.finalPreview));
  }
  return lines.join('\n');
}

function traceIdFromPath(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl$/, '');
}

function formatTraceEventLine(event: TurnLogEvent): string {
  const iter = typeof event.iteration === 'number' ? ` i${event.iteration}` : '';
  const at = typeof event.t === 'string' ? event.t.slice(11, 19) : '--:--:--';
  if (event.type === 'permission-request') {
    const details = [
      typeof event.name === 'string' ? event.name : '',
      typeof event.displayPrimary === 'string' ? event.displayPrimary : typeof event.primary === 'string' ? event.primary : '',
      typeof event.risk === 'string' ? event.risk : ''
    ].filter(Boolean).join(' · ');
    return `- ${at}${iter} \`${event.type}\`${details ? ` — ${details}` : ''}`;
  }
  if (event.type === 'permission-decision') {
    const details = [
      typeof event.choice === 'string' ? event.choice : '',
      typeof event.name === 'string' ? event.name : '',
      typeof event.primary === 'string' ? event.primary : ''
    ].filter(Boolean).join(' · ');
    return `- ${at}${iter} \`${event.type}\`${details ? ` — ${details}` : ''}`;
  }
  if (event.type === 'permission-denied') {
    const source = typeof event.source === 'string' ? `source:${event.source}` : '';
    const details = [
      source,
      typeof event.name === 'string' ? event.name : '',
      typeof event.primary === 'string' ? event.primary : '',
      typeof event.reason === 'string' ? event.reason : typeof event.notes === 'string' ? event.notes : ''
    ].filter(Boolean).join(' · ');
    return `- ${at}${iter} \`${event.type}\`${details ? ` — ${details}` : ''}`;
  }
  const details: string[] = [];
  if (typeof event.name === 'string') details.push(event.name);
  if (Array.isArray(event.tools)) details.push(event.tools.filter((tool) => typeof tool === 'string').join(', '));
  if (typeof event.reason === 'string') details.push(event.reason);
  if (typeof event.error === 'string') details.push(event.error);
  if (typeof event.attempt === 'number') details.push(`attempt ${event.attempt}`);
  const suffix = details.filter(Boolean).join(' · ');
  return `- ${at}${iter} \`${event.type}\`${suffix ? ` — ${suffix}` : ''}`;
}

function fence(value: string): string {
  const trimmed = value.trim();
  return ['```', trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}\n…` : trimmed, '```'].join('\n');
}

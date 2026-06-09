/**
 * `bandit insights` — generate a stand-alone HTML report from local
 * session + turn-log data so the user can see how they (and the agent)
 * are actually using bandit. Written as a single self-contained .html
 * file with inline CSS and inline SVG charts — no server, no external
 * resources, opens in any browser, sharable as one file.
 *
 * Data sources (all local, no network):
 * - ~/.bandit/sessions/*.jsonl — every REPL session, role+content
 * - <cwd>/.bandit/turns/*.jsonl — per-turn telemetry for the
 * current workspace (tool calls,
 * results, errors, timestamps)
 * - <cwd>/.bandit/agent-report.json (when present, for plan goals)
 *
 * The pipeline is intentionally tolerant — corrupt JSONL lines are
 * skipped, missing files are no-ops, individual turn-log fields can be
 * absent. The goal is "show what we have," not "fail because one
 * record was malformed."
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface SessionFile {
  id: string;          // filename without .jsonl
  startedAt: number;   // ms epoch parsed from the YYYYMMDD-HHMMSS prefix
  prompts: number;
  assistantTurns: number;
  approxChars: number;
  toolCallCount: number;
  toolNames: Map<string, number>;
}

interface TurnEvent {
  t: string;
  type: string;
  name?: string;
  prompt?: string;
  finalPreview?: string;
  responsePreview?: string;
  outputSnippet?: string;
  reason?: string;
  taskId?: string;
  isError?: boolean;
  error?: string;
  /** turnLog.ts writes tool-result events with `outputPreview`, not
   * `error`. When isError is true and ev.error is missing, the actual
   * error text lives here. The aggregate fallback reads this so the
   * "Top error patterns" panel matches the error counts in the tools
   * table (was empty even when 100+ errors were tallied — bug shipped
   * pre-1.7.116). */
  outputPreview?: string;
  iteration?: number;
  outputLength?: number;
  /** Tool-execute events carry the params dict — we mine it for file
   * paths (write_file, apply_edit, replace_range, apply_patch), git subcommands, and test-runner
   * invocations to power the "accomplishments" section. Stored as
   * `unknown` because the shape varies per tool. */
  params?: Record<string, unknown>;
}

interface TurnFile {
  workspace: string;          // absolute path to the workspace whose .bandit/turns/ this lives in
  filename: string;
  startedAt: number;
  events: TurnEvent[];
}

/** AI-generated summary of what the user got done and where Bandit
 * got in the way. Optional — only populated when the slash command
 * passes an `ai` callback (provider available + user consent for
 * cloud). The framing prompt instructs the model to attribute every
 * friction point to Bandit, never the user — the goal is empathetic
 * product feedback, not a postmortem of the human. */
export interface AiSummary {
  /** Display label for the model that generated the summary, e.g.
   * "qwen3.6:27b-it-q4_K_M" or "bandit-logic". Rendered in the
   * section header so the user knows which model wrote the prose. */
  modelLabel: string;
  /** 2-4 narrative paragraphs reading as a journal entry — "you did X,
   * then you debugged Y, you also picked at Z." Optional so older
   * AiSummary producers (and the deterministic fallback) stay valid. */
  storyline?: string[];
  /** 3 bullets, accomplishment framing. */
  shipped: string[];
  /** 3 bullets, every line owns the miss as Bandit's, not the user's. */
  friction: string[];
  /** 3 bullets, behavioral patterns — HOW the user works (apply_edit
   * vs write_file mix, commit cadence, debugging style, tool diversity).
   * Distinct from `shipped` (what got done) — patterns describe the
   * user's working style, not their accomplishments. */
  patterns: string[];
}

/** Sentiment counts mined deterministically from the user's prompt
 * history — keyword-based, fast, runs locally before the AI call.
 * Surfaces honest visibility into emotional cues so the user sees
 * their own frustration / satisfaction signal across sessions. */
export interface SentimentCounts {
  satisfied: number;
  happy: number;
  excited: number;
  frustrated: number;
  unsatisfied: number;
  /** Up to 3 short, redacted example phrases from frustration moments —
   * surfaced in the report so the user sees concrete context. Profanity
   * itself is NOT surfaced (replaced with [redacted]); the count is. */
  notable: string[];
}

/** Payload handed to an AI summarizer for narrative generation.
 *
 * Consent boundary: the caller's slash command surfaces what's about
 * to be sent and asks for explicit allow/deny before the first call.
 * Local Ollama runs auto-consent (bytes never leave the machine);
 * cloud runs prompt once and persist the answer. The payload includes
 * verbatim prompt excerpts (up to 280 chars × 25 prompts) and work-
 * highlight details (full prompts + topFiles + commands) so the LLM
 * has enough material to write a SPECIFIC narrative — not template
 * prose. Without this richness the storyline reads as generic counts.
 */
export interface AiSummaryInput {
  totalPrompts: number;
  totalSessions: number;
  filesTouched: number;
  filesWritten: number;
  editsApplied: number;
  gitOperations: number;
  subagentsSpawned: number;
  testsRun: number;
  /** Coverage window in days, derived from sessions[].at — gives the LLM
   *  a sense of "the last week" vs "the last 3 months" so the storyline
   *  can scale tense and granularity. */
  windowDays: number;
  topTools: { name: string; calls: number; errors: number; errorRate: number }[];
  topErrors: { tool: string; error: string; count: number }[];
  recentPromptExcerpts: { date: string; text: string }[];
  /** Per-highlight detail handed to the LLM so it can name specific
   *  accomplishments in prose. Full prompt up to 400 chars, top 4 file
   *  paths, top commands. Areas + language counts come along too so
   *  the LLM can color the narrative ("you focused on TypeScript on
   *  the agent core"). */
  workHighlights: {
    date: string;
    title: string;
    area: string;
    category: string;
    outcome: string;
    prompt: string;
    turns: number;
    filesTouched: number;
    filesInspected: number;
    externalActions: number;
    testsRun: number;
    gitOperations: number;
    subagentsSpawned: number;
    commands: string[];
    topFiles: string[];
    languages: string[];
  }[];
  /** Larger arcs grouped by repo area/domain. Includes top files so
   *  the LLM can write "the work concentrated in clients.ts" etc. */
  workThemes: {
    title: string;
    turns: number;
    filesTouched: number;
    testsRun: number;
    externalActions: number;
    subagentsSpawned: number;
    latest: string;
    sampleTitles: string[];
    outcomes: string[];
    topFiles: string[];
    languages: string[];
  }[];
  /** Sentiment counts scanned deterministically from prompt history —
   * passed to the AI so its `patterns` and `friction` bullets can
   * reference the user's emotional signal without the AI having to
   * count words itself (counting is reliable; AI summarization is not). */
  sentiment: SentimentCounts;
}

export interface WorkHighlight {
  timestamp: number;
  date: string;
  title: string;
  prompt: string;
  area: string;
  category: string;
  summary: string;
  outcome: string;
  turns: number;
  score: number;
  turnFile: string;
  filesTouched: number;
  filesInspected: number;
  writes: number;
  edits: number;
  externalActions: number;
  testsRun: number;
  gitOperations: number;
  commitsMade: number;
  subagentsSpawned: number;
  errors: number;
  commands: string[];
  topFiles: { path: string; touches: number }[];
  languages: { label: string; count: number }[];
  tools: { name: string; calls: number }[];
}

export interface WorkTheme {
  title: string;
  area: string;
  turns: number;
  score: number;
  latestAt: number;
  latestDate: string;
  filesTouched: number;
  filesInspected: number;
  editsAndWrites: number;
  externalActions: number;
  testsRun: number;
  gitOperations: number;
  subagentsSpawned: number;
  topFiles: { path: string; touches: number }[];
  languages: { label: string; count: number }[];
  sampleTitles: string[];
  outcomes: string[];
}

export type AiSummaryFn = (input: AiSummaryInput) => Promise<AiSummary | null>;

export interface InsightsData {
  generatedAt: number;
  cwd: string;
  sessions: SessionFile[];
  turnFiles: TurnFile[];
  /** Per-tool aggregates across every turn file. */
  toolStats: Map<string, { calls: number; errors: number; lastError?: string }>;
  /** Top error patterns across every turn file. Key is tool name, value is array of distinct error strings + counts. */
  errorClusters: Map<string, { error: string; count: number }[]>;
  /** Total prompts across every session. */
  totalPrompts: number;
  /** Approx total tokens across sessions (chars / 4 — same convention the rest of the CLI uses). */
  totalApproxTokens: number;
  /** Headline accomplishment counters mined from turn logs. Used to
   * surface "what got done" in the report instead of just raw tool
   * call counts. */
  accomplishments: {
    /** Distinct files written (write_file) or edited (apply_edit). */
    filesTouched: number;
    /** Number of write_file calls (file creates / full rewrites). */
    filesWritten: number;
    /** Number of apply_edit calls (targeted edits). */
    editsApplied: number;
    /** Distinct git commands run (git_status, git_diff, git_commit, run_command "git ..."). */
    gitOperations: number;
    /** Subset of gitOperations that were `git_commit` specifically. */
    commitsMade: number;
    /** Number of subagent task spawns. */
    subagentsSpawned: number;
    /** Number of test-related run_command invocations (npm test, pytest, vitest, etc). */
    testsRun: number;
    /** Top 8 most-touched file paths, ordered by hit count. Paths
     * under the user's home directory are normalized to ~/... so
     * the report doesn't leak absolute /Users/<name>/... layouts when
     * shared. */
    topFiles: { path: string; touches: number }[];
    /** Languages touched, bucketed by file extension. Keys are
     * display labels ("TypeScript", "Python"); values are the
     * count of distinct files that ext is associated with. */
    languages: { label: string; count: number }[];
  };
  /** Human-readable reconstruction of the actual work, mined from
   *  prompt + turn telemetry. This is the part that keeps repeated
   *  /insights runs from feeling like the same generic dashboard. */
  work: {
    highlights: WorkHighlight[];
    themes: WorkTheme[];
  };
  /** Deterministic narrative built locally from prompts, final
   * responses, changed files, and mutating external-tool actions. This
   * renders when the optional AI summary is disabled or fails so the
   * report still tells a story instead of falling back to counters. */
  localStory: string[];
  /** Activity-based metrics derived from session timestamps. */
  streak: {
    /** Consecutive days ending today (0 if today had no sessions). */
    current: number;
    /** Longest run of consecutive days the user has ever had. */
    longest: number;
  };
  /** The single calendar day with the most prompts. Null if no data. */
  peakDay: { date: string; prompts: number } | null;
  /** ms-epoch of the very first session — drives the "since first run" line. */
  firstSeenAt: number | null;
  /** Sentiment counts mined from prompt history — deterministic, no
   * AI required. Surfaced directly in the report so the user sees
   * their frustration / satisfaction signal across sessions. */
  sentiment: SentimentCounts;
  /** Optional AI-generated summary. Only set when the slash command
   * hands an AI callback in and the call completes successfully. */
  ai?: AiSummary;
}

const HOME = os.homedir();

/**
 * Walk every .jsonl session file in `~/.bandit/sessions/`, parse what
 * we can, and aggregate per-session stats. Tolerant: any individual
 * line that doesn't parse as JSON gets skipped silently. We never
 * throw on individual file failures — a corrupt session shouldn't
 * block the whole report.
 */
function loadSessions(): SessionFile[] {
  const dir = path.join(HOME, '.bandit', 'sessions');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const sessions: SessionFile[] = [];
  for (const filename of files) {
    const id = filename.replace(/\.jsonl$/, '');
    // Filenames look like YYYYMMDD-HHMMSS-xxxx. Parse to ms-epoch when
    // we can; fall back to the file's mtime when the name is non-standard.
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id);
    let startedAt: number;
    if (m) {
      const [, y, mo, d, h, mi, s] = m;
      startedAt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).getTime();
    } else {
      try { startedAt = fs.statSync(path.join(dir, filename)).mtimeMs; }
      catch { startedAt = 0; }
    }

    let prompts = 0;
    let assistantTurns = 0;
    let approxChars = 0;
    let toolCallCount = 0;
    const toolNames = new Map<string, number>();
    try {
      const text = fs.readFileSync(path.join(dir, filename), 'utf-8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let parsed: { role?: string; content?: string } | null = null;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (!parsed || typeof parsed.content !== 'string') continue;
        approxChars += parsed.content.length;
        if (parsed.role === 'user') {
          // Tool-result messages are stored as user-role with a
          // <tool_result> wrapper — exclude those from "user prompts."
          // True user prompts are the rest.
          if (!parsed.content.startsWith('<tool_result')) prompts += 1;
        } else if (parsed.role === 'assistant') {
          assistantTurns += 1;
          // Count tool calls in the assistant content. Cheap regex,
          // tolerant of either text-style <tool_call> or native JSON.
          const matches = parsed.content.matchAll(/<tool_call>\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"/g);
          for (const match of matches) {
            toolCallCount += 1;
            const name = match[1];
            toolNames.set(name, (toolNames.get(name) ?? 0) + 1);
          }
        }
      }
    } catch {
      /* unreadable file — skip with default zeros */
    }
    sessions.push({ id, startedAt, prompts, assistantTurns, approxChars, toolCallCount, toolNames });
  }
  return sessions.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Walk turn logs from both scopes Bandit has used historically:
 *
 * - nearest workspace `.bandit/turns`
 * - global `~/.bandit/turns`
 *
 * The report itself is global (`~/.bandit/insights.html`) and sessions
 * are global, so excluding the global turn directory makes the report
 * miss cross-repo arcs like Gmail/MCP cleanup or portfolio work that
 * happened outside the repo where `/insights` was invoked.
 */
function loadTurnFiles(cwd: string): TurnFile[] {
  const dirs: Array<{ dir: string; workspace: string }> = [];
  const seenDirs = new Set<string>();

  let workspace = cwd;
  for (let depth = 0; depth < 6 && workspace !== '/'; depth += 1) {
    const candidate = path.join(workspace, '.bandit', 'turns');
    if (fs.existsSync(candidate)) {
      dirs.push({ dir: candidate, workspace });
      seenDirs.add(path.resolve(candidate));
      break;
    }
    workspace = path.dirname(workspace);
  }

  const globalTurns = path.join(HOME, '.bandit', 'turns');
  if (fs.existsSync(globalTurns) && !seenDirs.has(path.resolve(globalTurns))) {
    dirs.push({ dir: globalTurns, workspace: HOME });
  }

  const out: TurnFile[] = [];
  for (const source of dirs) {
    loadTurnFilesFromDir(source.dir, source.workspace, out);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

function loadTurnFilesFromDir(dir: string, fallbackWorkspace: string, out: TurnFile[]): void {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('turn-') && f.endsWith('.jsonl'));
  for (const filename of files) {
    let startedAt = 0;
    const m = /^turn-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(filename);
    if (m) {
      const [, y, mo, d, h, mi, s] = m;
      startedAt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`).getTime();
    }
    const events: TurnEvent[] = [];
    try {
      const text = fs.readFileSync(path.join(dir, filename), 'utf-8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line) as TurnEvent); } catch { /* skip */ }
      }
    } catch {
      /* unreadable — skip */
    }
    out.push({ workspace: inferTurnWorkspace(events, fallbackWorkspace), filename, startedAt, events });
  }
}

/**
 * Mine turn logs for "what got accomplished" — distinct from raw tool
 * counts. The numbers here go in the accomplishments hero section so
 * the user sees outcomes ("47 files touched, 12 git operations") not
 * just ("write_file ×34, apply_edit ×18, run_command ×62"). Heuristic
 * but high-signal: the params dict is the source of truth for which
 * file an edit hit, what a run_command was actually running, etc.
 */
/** File extensions → display labels for the "languages touched"
 * breakdown. Anything not on the list collapses to "Other". Order
 * doesn't matter — the render sorts by count. */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  rb: 'Ruby', php: 'PHP', swift: 'Swift', cs: 'C#', cpp: 'C++', cc: 'C++', cxx: 'C++', c: 'C', h: 'C/C++', hpp: 'C++',
  scala: 'Scala', clj: 'Clojure', ex: 'Elixir', exs: 'Elixir', erl: 'Erlang',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', fish: 'Shell',
  md: 'Markdown', mdx: 'Markdown', html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
  sql: 'SQL', graphql: 'GraphQL', proto: 'Protobuf',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
  dockerfile: 'Docker', tf: 'Terraform'
};

// Test-runner pattern: matches the most common JS/Python/.NET/Go
// test invocations. The agent shells out to these via run_command,
// but newer builds also expose `test_run` and some skills expose
// `run_tests`, so the accomplishment pass recognizes all three.
const TEST_RUNNER_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|\bvitest\b|\bjest\b|\bpytest\b|\bdotnet\s+test\b|\bgo\s+test\b|\bcargo\s+test\b|\bmix\s+test\b/i;

const EDIT_TOOLS = new Set(['write_file', 'apply_edit', 'replace_range', 'apply_patch']);
const READ_TOOLS = new Set(['read_file', 'ls', 'list_files', 'search_code', 'web_fetch']);
const GIT_TOOLS = new Set(['git_status', 'git_diff', 'git_log', 'git_commit', 'git_branch', 'git_checkout', 'git_stash', 'git_pull', 'git_push']);
const EXTERNAL_READ_PREFIX_RE = /^(?:list|get|search|read|fetch|triage|inspect|check|describe|lookup|find)/i;
const EXTERNAL_MUTATION_RE = /^(?:create|update|modify|delete|remove|trash|archive|send|post|add|insert|replace|rename|move|copy|upload|revoke|grant|apply|set|mark|label)/i;

/** Replace a leading absolute home path with `~/...` so shared reports
 * don't leak `/Users/<name>/` layouts. Anything that isn't under the
 * active home directory is returned unchanged. */
function normalizePath(p: string): string {
  if (p.startsWith(HOME + '/')) return '~/' + p.slice(HOME.length + 1);
  if (p === HOME) return '~';
  return p;
}

function detectLanguage(filePath: string): string | null {
  const base = filePath.split('/').pop() ?? '';
  if (base.toLowerCase() === 'dockerfile') return 'Docker';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!ext) return null;
  return LANG_BY_EXT[ext] ?? null;
}

function asParamString(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === 'string' ? v : '';
}

function commandLine(params: Record<string, unknown>): string {
  const cmd = asParamString(params, 'cmd');
  const args = asParamString(params, 'args');
  return `${cmd} ${args}`.trim();
}

function normalizeToolName(name: string): string {
  const withoutMcpPrefix = name.replace(/^mcp__[^_]+__/, '');
  const parts = withoutMcpPrefix.split('.');
  return parts[parts.length - 1] || withoutMcpPrefix;
}

function isExternalMutatingTool(name: string): boolean {
  if (!name.includes('.') && !name.startsWith('mcp__')) return false;
  const bare = normalizeToolName(name);
  return EXTERNAL_MUTATION_RE.test(bare) && !EXTERNAL_READ_PREFIX_RE.test(bare);
}

function expandHome(value: string): string {
  if (value === '~') return HOME;
  if (value.startsWith('~/')) return path.join(HOME, value.slice(2));
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
  const expanded = expandHome(value);
  const githubRoot = path.join(HOME, 'Documents', 'GitHub') + path.sep;
  const githubIndex = expanded.indexOf(githubRoot);
  if (githubIndex >= 0) {
    const rest = expanded.slice(githubIndex + githubRoot.length);
    const repo = rest.split(/[/"'`\s:]+/)[0];
    if (repo) return path.join(githubRoot, repo);
  }
  const homePrefix = HOME + path.sep;
  if (expanded.startsWith(homePrefix)) {
    const rest = expanded.slice(homePrefix.length);
    const first = rest.split(/[/"'`\s:]+/)[0];
    if (first && /^[A-Za-z0-9._-]+$/.test(first) && !['Desktop', 'Documents', 'Downloads', 'Library'].includes(first)) {
      return path.join(HOME, first);
    }
  }
  return null;
}

function inferTurnWorkspace(events: TurnEvent[], fallbackWorkspace: string): string {
  const candidates = new Map<string, number>();
  for (const ev of events) {
    const values: string[] = [];
    collectStringValues(ev.params, values);
    collectStringValues(ev.prompt, values);
    collectStringValues(ev.outputSnippet, values);
    collectStringValues(ev.responsePreview, values);
    collectStringValues(ev.finalPreview, values);
    for (const value of values) {
      const inferred = inferWorkspaceFromText(value);
      if (inferred) candidates.set(inferred, (candidates.get(inferred) ?? 0) + 1);
    }
  }
  const [top] = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
  return top?.[0] ?? fallbackWorkspace;
}

function isToolExecuteEvent(ev: TurnEvent): boolean {
  return ev.type === 'tool-execute' || ev.type === 'subagent-tool-execute';
}

function isToolResultError(ev: TurnEvent): boolean {
  return (ev.type === 'tool-result' || ev.type === 'subagent-tool-result' || ev.type === 'tool-error' || ev.type === 'subagent-tool-error') &&
    (!!ev.isError || ev.type === 'tool-error' || ev.type === 'subagent-tool-error');
}

function addLanguage(langCounts: Map<string, Set<string>>, filePath: string): void {
  const lang = detectLanguage(filePath);
  if (!lang) return;
  const set = langCounts.get(lang) ?? new Set<string>();
  set.add(filePath);
  langCounts.set(lang, set);
}

function cleanSnippet(text: string, max = 160): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, ' ')
    .replace(/[#>*_`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Canonical titles are deliberately hand-picked — they collapse
// recurring multi-area efforts (self-eval sweeps, subagent research
// drills, repo explanations) into ONE highlight card aggregating all
// areas touched. Free-form prompt titles aren't canonical and stay
// per-area so they don't false-merge unrelated work.
const CANONICAL_TITLES = new Set<string>();
function canonicalize(title: string): { title: string; canonical: boolean } {
  CANONICAL_TITLES.add(title);
  return { title, canonical: true };
}

function titleFromPrompt(prompt: string): { title: string; canonical: boolean } {
  const cleaned = prompt
    .replace(/\s+/g, ' ')
    .replace(/^please\s+/i, '')
    .trim();
  if (!cleaned) return { title: 'Untitled turn', canonical: false };
  const lower = cleaned.toLowerCase();
  if (/\b(?:gmail|inbox|email)\b/.test(lower) && /\b(?:mcp|archive|label|filter|cleanup|triage|clean)\b/.test(lower)) {
    return canonicalize('Google MCP inbox automation and cleanup');
  }
  if (/deep self[- ]evaluation|what (?:are you|is .*?) missing|better agent/.test(lower)) {
    return canonicalize('Deep self-evaluation of Bandit agent capabilities');
  }
  if (/test using .*sub ?agents?|sub ?agents? to research/.test(lower)) {
    return canonicalize('Subagent research test on this repo');
  }
  if (/explain what this repo does/.test(lower)) {
    return canonicalize('Repo explanation');
  }
  if (/screenshot.*answer honestly|answer honestly.*screenshot/.test(lower)) {
    return canonicalize('Honest assessment of screenshot prompt');
  }
  const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0] ?? cleaned;
  const title = firstSentence.length > 110 ? firstSentence.slice(0, 107).trimEnd() + '...' : firstSentence;
  return { title, canonical: false };
}

function isCanonicalTitle(title: string): boolean {
  return CANONICAL_TITLES.has(title);
}

function categoryFromPrompt(prompt: string, tools: Map<string, number>): string {
  const p = prompt.toLowerCase();
  if (/\b(fix|bug|broken|error|failing|failure|regression|crash)\b/.test(p)) return 'Debugging';
  if (/\b(test|verify|validation|coverage|smoke)\b/.test(p) || tools.has('test_run') || tools.has('run_tests')) return 'Validation';
  if (/\b(refactor|cleanup|clean up|restructure|split|extract)\b/.test(p)) return 'Refactor';
  if (/\b(add|build|create|implement|ship|make|scaffold)\b/.test(p)) return 'Build';
  if (/\b(review|audit|inspect|scan|evaluate|investigate|deep dive|self[- ]evaluation|improve|missing)\b/.test(p)) return 'Investigation';
  if (/\b(doc|readme|email|draft|write|copy)\b/.test(p)) return 'Writing';
  if (/\b(deploy|publish|release|version|npm|vsx|marketplace)\b/.test(p)) return 'Release';
  if (tools.has('task')) return 'Delegation';
  return 'Working session';
}

function areaFromFilesAndPrompt(files: string[], prompt: string): string {
  const buckets: Array<{ label: string; re: RegExp; score: number }> = [
    { label: 'Bandit CLI', re: /^apps\/bandit-cli\//, score: 0 },
    { label: 'VS Code extension', re: /^apps\/bandit-stealth\//, score: 0 },
    { label: 'Stealth web app', re: /^apps\/bandit-stealth-web\//, score: 0 },
    { label: 'Agent core', re: /^packages\/agent-core\//, score: 0 },
    { label: 'Stealth runtime', re: /^packages\/stealth-core-runtime\//, score: 0 },
    { label: 'Host kit', re: /^packages\/host-kit\//, score: 0 },
    { label: 'Agent UI', re: /^packages\/agent-ui\//, score: 0 },
    { label: 'Adapters', re: /^packages\/agent-adapters\//, score: 0 },
    { label: 'Deploy/Helm', re: /^(deploy|charts|apps\/[^/]+\/charts)\//, score: 0 },
    { label: 'Docs/roadmap', re: /^(docs|README\.md|SECURITY\.md|CONTRIBUTING\.md)/, score: 0 },
    { label: 'Examples', re: /^examples\//, score: 0 }
  ];
  for (const f of files) {
    const rel = f.replace(/^\.\//, '');
    for (const b of buckets) {
      if (b.re.test(rel)) b.score += 1;
    }
  }
  const p = prompt.toLowerCase();
  if (/\b(gmail|inbox|email|google mcp|mcp service|mcp server)\b/.test(p)) buckets.push({ label: 'Email/MCP work', re: /$a/, score: 4 });
  if (/\binsights?\b/.test(p)) buckets.push({ label: 'Insights reporting', re: /$a/, score: 3 });
  if (/\bmcp\b|connector/.test(p)) buckets.push({ label: 'MCP/connectors', re: /$a/, score: 3 });
  if (/\bsubagent|background task|\/tasks\b/.test(p)) buckets.push({ label: 'Subagents/background work', re: /$a/, score: 3 });
  if (/\bpermission|approval|security|secret|redact/.test(p)) buckets.push({ label: 'Safety/security', re: /$a/, score: 3 });
  if (/\bcli\b|terminal|slash command|\/[a-z]/.test(p)) buckets.push({ label: 'Bandit CLI', re: /$a/, score: 2 });
  if (/\bvs code|extension|cursor\b/.test(p)) buckets.push({ label: 'VS Code extension', re: /$a/, score: 2 });
  const top = buckets.sort((a, b) => b.score - a.score)[0];
  return top && top.score > 0 ? top.label : 'General Bandit work';
}

function computeAccomplishments(turnFiles: TurnFile[]): InsightsData['accomplishments'] {
  let filesWritten = 0;
  let editsApplied = 0;
  let gitOperations = 0;
  let commitsMade = 0;
  let subagentsSpawned = 0;
  let testsRun = 0;
  const fileTouches = new Map<string, number>();
  const langCounts = new Map<string, Set<string>>();

  for (const tf of turnFiles) {
    for (const ev of tf.events) {
      if (!isToolExecuteEvent(ev) || !ev.name) continue;
      const params = ev.params ?? {};

      if (EDIT_TOOLS.has(ev.name)) {
        if (ev.name === 'write_file') filesWritten += 1;
        else editsApplied += 1;
        const filePath = typeof params.path === 'string' ? params.path : null;
        if (filePath) {
          fileTouches.set(filePath, (fileTouches.get(filePath) ?? 0) + 1);
          addLanguage(langCounts, filePath);
        }
      } else if (ev.name === 'task') {
        subagentsSpawned += 1;
      } else if (GIT_TOOLS.has(ev.name)) {
        gitOperations += 1;
        if (ev.name === 'git_commit') commitsMade += 1;
      } else if (ev.name === 'run_command') {
        const cmd = asParamString(params, 'cmd');
        const args = asParamString(params, 'args');
        const full = commandLine(params);
        if (cmd === 'git') {
          gitOperations += 1;
          if (/^\s*commit\b/.test(args)) commitsMade += 1;
        }
        if (TEST_RUNNER_RE.test(full)) testsRun += 1;
      } else if (ev.name === 'test_run' || ev.name === 'run_tests') {
        testsRun += 1;
      }
    }
  }

  const topFiles = [...fileTouches.entries()]
    .map(([p, touches]) => ({ path: normalizePath(p), touches }))
    .sort((a, b) => b.touches - a.touches)
    .slice(0, 8);

  const languages = [...langCounts.entries()]
    .map(([label, set]) => ({ label, count: set.size }))
    .sort((a, b) => b.count - a.count);

  return {
    filesTouched: fileTouches.size,
    filesWritten,
    editsApplied,
    gitOperations,
    commitsMade,
    subagentsSpawned,
    testsRun,
    topFiles,
    languages
  };
}

function summarizeHighlight(h: Omit<WorkHighlight, 'summary'>): string {
  const parts: string[] = [];
  if (h.turns > 1) parts.push(`${h.turns} related turns`);
  if (h.filesTouched > 0) {
    const changes = h.edits + h.writes;
    parts.push(`${changes} ${changes === 1 ? 'change' : 'changes'} across ${h.filesTouched} file${h.filesTouched === 1 ? '' : 's'}`);
  }
  if (h.filesInspected > 0) parts.push(`${h.filesInspected} file${h.filesInspected === 1 ? '' : 's'} inspected`);
  if (h.externalActions > 0) parts.push(`${h.externalActions} external action${h.externalActions === 1 ? '' : 's'}`);
  if (h.testsRun > 0) parts.push(`${h.testsRun} test run${h.testsRun === 1 ? '' : 's'}`);
  if (h.subagentsSpawned > 0) parts.push(`${h.subagentsSpawned} subagent${h.subagentsSpawned === 1 ? '' : 's'} spawned`);
  if (h.gitOperations > 0) parts.push(`${h.gitOperations} git op${h.gitOperations === 1 ? '' : 's'}`);
  if (h.commands.length > 0) parts.push(`commands: ${h.commands.slice(0, 2).join(', ')}`);
  if (parts.length === 0) return cleanSnippet(h.prompt, 140);
  return parts.join(' · ');
}

function extractOutcome(events: TurnEvent[]): string {
  const final = [...events].reverse().find((ev) =>
    ev.type === 'final-response' && typeof ev.finalPreview === 'string' && ev.finalPreview.trim().length > 0
  )?.finalPreview;
  const response = final ?? [...events].reverse().find((ev) =>
    typeof ev.responsePreview === 'string' &&
    ev.responsePreview.trim().length > 0 &&
    !ev.responsePreview.includes('<tool_call>')
  )?.responsePreview;
  const raw = response ?? '';
  if (!raw) return '';
  const cleaned = cleanSnippet(raw, 420)
    .replace(/\bHere'?s what (?:I|we) (?:did|added|changed|shipped):?/gi, '')
    .replace(/\bWhat(?:'|’)s done:?/gi, '')
    .trim();
  const successLine = cleaned
    .split(/\s*(?:\n| {2,}|[-*]\s+)/)
    .map((line) => line.trim())
    .find((line) => /^(?:done|shipped|pushed|committed|created|fixed|added|all\b|success|the fix|changes are now applied)/i.test(line));
  const candidate = successLine || cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
  if (/\b(?:cannot recall|nothing confirmed shipped|not yet|i have not|let me|full access|bandit-reasoning|the user wants|findings)\b/i.test(candidate)) {
    return '';
  }
  const startsLikeOutcome = /^(?:done|shipped|pushed|committed|created|fixed|added|all\b|success|built|archived|cleaned|moved|updated|marked read|the fix|the changes are now applied|(?:the issue|the bug|the failure|the problem) (?:is|was )?(?:fixed|resolved)|i(?:'ve| have) (?:created|built|fixed|updated|added|pushed|committed|shipped))/i.test(candidate);
  if (!startsLikeOutcome) {
    return '';
  }
  return candidate.length > 220 ? candidate.slice(0, 217).trimEnd() + '...' : candidate;
}

function collapseSimilarHighlights(items: WorkHighlight[]): WorkHighlight[] {
  const groups = new Map<string, WorkHighlight>();
  // Track distinct areas that fell into a canonical-title group so the
  // merged card can show "spanned 4 areas" instead of pretending it
  // was scoped to one.
  const areasByKey = new Map<string, Set<string>>();
  for (const h of items) {
    const titleKey = h.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
    // Canonical titles (self-eval sweeps, subagent research drills,
    // repo explanations) collapse cross-area — same effort repeated
    // against different parts of the codebase is one highlight, not N.
    // Free-form titles stay area-scoped so unrelated "fix the bug"
    // prompts in different areas don't false-merge.
    const key = isCanonicalTitle(h.title)
      ? `canonical::${titleKey}`
      : `${h.area}::${titleKey}`;
    const cur = groups.get(key);
    if (!cur) {
      groups.set(key, { ...h, topFiles: [...h.topFiles], languages: [...h.languages], tools: [...h.tools], commands: [...h.commands] });
      areasByKey.set(key, new Set([h.area]));
      continue;
    }
    areasByKey.get(key)!.add(h.area);

    const fileMap = new Map<string, number>();
    for (const f of cur.topFiles) fileMap.set(f.path, (fileMap.get(f.path) ?? 0) + f.touches);
    for (const f of h.topFiles) fileMap.set(f.path, (fileMap.get(f.path) ?? 0) + f.touches);
    const langMap = new Map<string, number>();
    for (const l of cur.languages) langMap.set(l.label, (langMap.get(l.label) ?? 0) + l.count);
    for (const l of h.languages) langMap.set(l.label, (langMap.get(l.label) ?? 0) + l.count);
    const toolMap = new Map<string, number>();
    for (const t of cur.tools) toolMap.set(t.name, (toolMap.get(t.name) ?? 0) + t.calls);
    for (const t of h.tools) toolMap.set(t.name, (toolMap.get(t.name) ?? 0) + t.calls);

    cur.turns += h.turns;
    cur.score += h.score;
    if (h.timestamp > cur.timestamp) {
      cur.timestamp = h.timestamp;
      cur.date = h.date;
      cur.turnFile = h.turnFile;
    }
    cur.filesTouched += h.filesTouched;
    cur.filesInspected += h.filesInspected;
    cur.writes += h.writes;
    cur.edits += h.edits;
    cur.externalActions += h.externalActions;
    cur.testsRun += h.testsRun;
    cur.gitOperations += h.gitOperations;
    cur.commitsMade += h.commitsMade;
    cur.subagentsSpawned += h.subagentsSpawned;
    cur.errors += h.errors;
    for (const cmd of h.commands) {
      if (!cur.commands.includes(cmd) && cur.commands.length < 5) cur.commands.push(cmd);
    }
    cur.topFiles = [...fileMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([path, touches]) => ({ path, touches }));
    cur.languages = [...langMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ label, count }));
    cur.tools = [...toolMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, calls]) => ({ name, calls }));
    cur.summary = summarizeHighlight(cur);
    if (h.timestamp >= cur.timestamp && h.outcome) cur.outcome = h.outcome;
  }
  // Stamp merged-area scope onto canonical-title highlights so the
  // card reflects the cross-area reality. Free-form titles still
  // carry their single area.
  for (const [key, h] of groups) {
    const areas = areasByKey.get(key);
    if (areas && areas.size > 1) {
      const sorted = [...areas].sort();
      h.area = sorted.length <= 3
        ? sorted.join(' + ')
        : `${sorted.slice(0, 2).join(', ')} +${sorted.length - 2} more`;
    }
  }
  return [...groups.values()];
}

function computeWork(turnFiles: TurnFile[]): InsightsData['work'] {
  const highlights: WorkHighlight[] = [];

  for (const tf of turnFiles) {
    const prompt = tf.events.find((ev) => ev.type === 'user-prompt' && typeof ev.prompt === 'string')?.prompt?.trim() ?? '';
    if (!prompt) continue;

    let timestamp = tf.startedAt;
    if (!timestamp) {
      const firstTs = tf.events.find((ev) => ev.t)?.t;
      timestamp = firstTs ? Date.parse(firstTs) : 0;
    }

    let writes = 0;
    let edits = 0;
    let testsRun = 0;
    let gitOperations = 0;
    let commitsMade = 0;
    let subagentsSpawned = 0;
    let externalActions = 0;
    let errors = 0;
    const fileTouches = new Map<string, number>();
    const filesInspected = new Map<string, number>();
    const langCounts = new Map<string, Set<string>>();
    const tools = new Map<string, number>();
    const commands: string[] = [];

    for (const ev of tf.events) {
      if (isToolResultError(ev)) errors += 1;
      if (ev.type === 'subagent-spawn') subagentsSpawned += 1;
      if (!isToolExecuteEvent(ev) || !ev.name) continue;

      const params = ev.params ?? {};
      tools.set(ev.name, (tools.get(ev.name) ?? 0) + 1);
      if (isExternalMutatingTool(ev.name)) externalActions += 1;

      if (EDIT_TOOLS.has(ev.name)) {
        const filePath = asParamString(params, 'path');
        if (ev.name === 'write_file') writes += 1;
        else edits += 1;
        if (filePath) {
          fileTouches.set(filePath, (fileTouches.get(filePath) ?? 0) + 1);
          addLanguage(langCounts, filePath);
        }
      } else if (READ_TOOLS.has(ev.name)) {
        const filePath = asParamString(params, 'path') || asParamString(params, 'pattern') || asParamString(params, 'query') || asParamString(params, 'url');
        if (filePath) filesInspected.set(filePath, (filesInspected.get(filePath) ?? 0) + 1);
      } else if (ev.name === 'task') {
        // Count concrete `subagent-spawn` events when present so the
        // same task is not double-counted. Older logs without spawn
        // telemetry get a fallback after this loop.
      } else if (GIT_TOOLS.has(ev.name)) {
        gitOperations += 1;
        if (ev.name === 'git_commit') commitsMade += 1;
      } else if (ev.name === 'run_command') {
        const cmd = asParamString(params, 'cmd');
        const args = asParamString(params, 'args');
        const full = commandLine(params);
        if (full && commands.length < 5) commands.push(full);
        if (cmd === 'git') {
          gitOperations += 1;
          if (/^\s*commit\b/.test(args)) commitsMade += 1;
        }
        if (TEST_RUNNER_RE.test(full)) testsRun += 1;
      } else if (ev.name === 'test_run' || ev.name === 'run_tests') {
        testsRun += 1;
      }
    }
    if (subagentsSpawned === 0 && tools.has('task')) subagentsSpawned = tools.get('task') ?? 0;

    const allFiles = [...fileTouches.keys(), ...filesInspected.keys()];
    const category = categoryFromPrompt(prompt, tools);
    const area = areaFromFilesAndPrompt(allFiles, prompt);
    const topFiles = [...fileTouches.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([p, touches]) => ({ path: normalizePath(p), touches }));
    const languages = [...langCounts.entries()]
      .map(([label, set]) => ({ label, count: set.size }))
      .sort((a, b) => b.count - a.count);
    const toolList = [...tools.entries()]
      .map(([name, calls]) => ({ name, calls }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 6);

    const score =
      (writes + edits) * 6 +
      fileTouches.size * 4 +
      Math.min(filesInspected.size, 30) * 0.7 +
      testsRun * 4 +
      externalActions * 5 +
      gitOperations * 2 +
      subagentsSpawned * 3 +
      toolList.reduce((sum, t) => sum + Math.min(t.calls, 5) * 0.15, 0) -
      errors * 0.4;

    if (score < 1.5 && toolList.length === 0) continue;

    const base = {
      timestamp,
      date: timestamp ? new Date(timestamp).toISOString().slice(0, 10) : 'unknown',
      title: titleFromPrompt(prompt).title,
      prompt,
      area,
      category,
      turns: 1,
      score,
      turnFile: tf.filename,
      filesTouched: fileTouches.size,
      filesInspected: filesInspected.size,
      writes,
      edits,
      outcome: extractOutcome(tf.events),
      externalActions,
      testsRun,
      gitOperations,
      commitsMade,
      subagentsSpawned,
      errors,
      commands,
      topFiles,
      languages,
      tools: toolList
    };
    highlights.push({ ...base, summary: summarizeHighlight(base) });
  }

  const collapsedHighlights = collapseSimilarHighlights(highlights);

  // Build themes from the PRE-COLLAPSE highlights so per-area grouping
  // is preserved — the cross-area collapse on highlights produces nice
  // single-card summaries, but themes are meant to be per-area arcs.
  // Using collapsed highlights here would turn "Self-eval sweeps that
  // touched 5 areas" into a theme labeled "Agent core, Docs/roadmap +3
  // more" which is the wrong shape for the "Bigger arcs" panel.
  const themesByArea = new Map<string, {
    area: string;
    turns: number;
    score: number;
    latestAt: number;
    fileTouches: Map<string, number>;
    filesInspected: number;
    langCounts: Map<string, Set<string>>;
    editsAndWrites: number;
    externalActions: number;
    testsRun: number;
    gitOperations: number;
    subagentsSpawned: number;
    sampleTitles: string[];
    outcomes: string[];
  }>();

  for (const h of highlights) {
    const cur = themesByArea.get(h.area) ?? {
      area: h.area,
      turns: 0,
      score: 0,
      latestAt: 0,
      fileTouches: new Map<string, number>(),
      filesInspected: 0,
      langCounts: new Map<string, Set<string>>(),
      editsAndWrites: 0,
      externalActions: 0,
      testsRun: 0,
      gitOperations: 0,
      subagentsSpawned: 0,
      sampleTitles: [],
      outcomes: []
    };
    cur.turns += h.turns;
    cur.score += h.score;
    cur.latestAt = Math.max(cur.latestAt, h.timestamp);
    cur.editsAndWrites += h.edits + h.writes;
    cur.externalActions += h.externalActions;
    cur.testsRun += h.testsRun;
    cur.gitOperations += h.gitOperations;
    cur.subagentsSpawned += h.subagentsSpawned;
    for (const f of h.topFiles) cur.fileTouches.set(f.path, (cur.fileTouches.get(f.path) ?? 0) + f.touches);
    cur.filesInspected += h.filesInspected;
    for (const l of h.languages) {
      const set = cur.langCounts.get(l.label) ?? new Set<string>();
      for (let i = 0; i < l.count; i += 1) set.add(`${h.turnFile}:${l.label}:${i}`);
      cur.langCounts.set(l.label, set);
    }
    if (!cur.sampleTitles.includes(h.title) && cur.sampleTitles.length < 4) cur.sampleTitles.push(h.title);
    if (h.outcome && !cur.outcomes.includes(h.outcome) && cur.outcomes.length < 3) cur.outcomes.push(h.outcome);
    themesByArea.set(h.area, cur);
  }

  const themes = [...themesByArea.values()]
    .map((t): WorkTheme => ({
      title: t.area,
      area: t.area,
      turns: t.turns,
      score: t.score,
      latestAt: t.latestAt,
      latestDate: t.latestAt ? new Date(t.latestAt).toISOString().slice(0, 10) : 'unknown',
      filesTouched: t.fileTouches.size,
      filesInspected: t.filesInspected,
      editsAndWrites: t.editsAndWrites,
      externalActions: t.externalActions,
      testsRun: t.testsRun,
      gitOperations: t.gitOperations,
      subagentsSpawned: t.subagentsSpawned,
      topFiles: [...t.fileTouches.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([p, touches]) => ({ path: p, touches })),
      languages: [...t.langCounts.entries()]
        .map(([label, set]) => ({ label, count: set.size }))
        .sort((a, b) => b.count - a.count),
      sampleTitles: t.sampleTitles,
      outcomes: t.outcomes
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  return {
    highlights: collapsedHighlights
      .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
      .slice(0, 16),
    themes
  };
}

function buildLocalStory(data: InsightsData): string[] {
  const paragraphs: string[] = [];
  const usedThemes = new Set<string>();
  const findTheme = (patterns: RegExp[]) => {
    const titleMatch = data.work.themes.find((theme) =>
      !usedThemes.has(theme.title) &&
      patterns.some((pattern) =>
        pattern.test(theme.title) ||
        theme.sampleTitles.some((title) => pattern.test(title))
      )
    );
    if (titleMatch) return titleMatch;
    return data.work.themes.find((theme) =>
      !usedThemes.has(theme.title) &&
      patterns.some((pattern) => theme.outcomes.some((outcome) => pattern.test(outcome)))
    );
  };
  const addTheme = (theme: WorkTheme | undefined, copy: (theme: WorkTheme, outcome: string) => string) => {
    if (!theme) return;
    const outcome = theme.outcomes.find(Boolean) ?? '';
    paragraphs.push(copy(theme, outcome));
    usedThemes.add(theme.title);
  };
  const countLabel = (n: number, singular: string, plural = `${singular}s`) => `${n} ${n === 1 ? singular : plural}`;
  const turnWord = (n: number) => countLabel(n, 'turn');

  addTheme(findTheme([/Google\/MCP/i, /\bGmail\b/i, /\binbox\b/i, /\bMCP server\b/i]), (theme, outcome) => {
    const details = [
      turnWord(theme.turns),
      theme.filesTouched > 0 ? `${countLabel(theme.filesTouched, 'file')} touched` : '',
      theme.testsRun > 0 ? countLabel(theme.testsRun, 'validation run') : '',
      theme.externalActions > 0 ? countLabel(theme.externalActions, 'Gmail/MCP action') : ''
    ].filter(Boolean).join(', ');
    return `The Google/MCP work now shows up as a real cross-repo arc: ${details}. Bandit can see both the server buildout and the Gmail cleanup/tooling work instead of treating them as disconnected snippets.${outcome ? ` One logged outcome: ${outcome}` : ''}`;
  });

  addTheme(findTheme([/\bPortfolio\b/i, /\bBurtson\.io\b/i, /\bApp\.(?:jsx|tsx)\b/i]), (theme, outcome) => {
    const details = [
      turnWord(theme.turns),
      theme.filesTouched > 0 ? `${countLabel(theme.filesTouched, 'file')} touched` : '',
      theme.editsAndWrites > 0 ? `${theme.editsAndWrites} edits/writes` : '',
      theme.testsRun > 0 ? countLabel(theme.testsRun, 'validation run') : ''
    ].filter(Boolean).join(', ');
    return `The portfolio work reads as an iterative product push, not a one-off edit: ${details}. The turn history captures content passes, repo/path fixes, and larger refactor loops across the portfolio codebase.${outcome ? ` One logged outcome: ${outcome}` : ''}`;
  });

  addTheme(findTheme([/^Bandit CLI$/i, /^VS Code extension$/i, /^Agent core$/i, /^Host kit$/i, /^Stealth runtime$/i]), (theme, outcome) => {
    const details = [
      turnWord(theme.turns),
      theme.filesTouched > 0 ? `${countLabel(theme.filesTouched, 'file')} touched` : '',
      theme.editsAndWrites > 0 ? `${theme.editsAndWrites} edits/writes` : '',
      theme.subagentsSpawned > 0 ? countLabel(theme.subagentsSpawned, 'subagent') : ''
    ].filter(Boolean).join(', ');
    return `Bandit itself has a visible improvement arc: ${details}. The report can now pull together CLI, extension, host-kit, and agent-core work so product polish does not disappear inside raw tool counts.${outcome ? ` One logged outcome: ${outcome}` : ''}`;
  });

  for (const theme of data.work.themes) {
    if (paragraphs.length >= 4) break;
    if (usedThemes.has(theme.title)) continue;
    const details = [
      turnWord(theme.turns),
      theme.filesTouched > 0 ? `${countLabel(theme.filesTouched, 'file')} touched` : '',
      theme.editsAndWrites > 0 ? `${theme.editsAndWrites} edits/writes` : '',
      theme.testsRun > 0 ? countLabel(theme.testsRun, 'validation run') : '',
      theme.externalActions > 0 ? countLabel(theme.externalActions, 'external action') : ''
    ].filter(Boolean).join(', ');
    const title = theme.sampleTitles[0] ?? theme.title;
    paragraphs.push(`${theme.title} was another active lane: ${details}. Representative work: ${title}.${theme.outcomes[0] ? ` One logged outcome: ${theme.outcomes[0]}` : ''}`);
    usedThemes.add(theme.title);
  }

  return paragraphs.slice(0, 4);
}

/** Compute current/longest streak of consecutive days the user had at
 * least one session, plus the single peak day. Walks session
 * timestamps; cheap even with thousands of sessions. */
function computeActivityMetrics(sessions: SessionFile[]): {
  streak: InsightsData['streak'];
  peakDay: InsightsData['peakDay'];
  firstSeenAt: number | null;
} {
  if (sessions.length === 0) {
    return { streak: { current: 0, longest: 0 }, peakDay: null, firstSeenAt: null };
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const promptsByDay = new Map<string, number>();
  for (const s of sessions) {
    if (!s.startedAt) continue;
    const day = new Date(s.startedAt).toISOString().slice(0, 10);
    promptsByDay.set(day, (promptsByDay.get(day) ?? 0) + Math.max(s.prompts, s.toolCallCount > 0 ? 1 : 0));
  }
  // Longest streak — sort active days, walk for consecutive runs.
  const activeDays = [...promptsByDay.keys()].sort();
  let longest = 0;
  let run = 0;
  let prevTs = 0;
  for (const day of activeDays) {
    const ts = new Date(day + 'T00:00:00Z').getTime();
    if (prevTs && ts - prevTs === dayMs) run += 1;
    else run = 1;
    if (run > longest) longest = run;
    prevTs = ts;
  }
  // Current streak — count back from today.
  const todayKey = new Date().toISOString().slice(0, 10);
  let current = 0;
  let cursorTs = new Date(todayKey + 'T00:00:00Z').getTime();
  while (promptsByDay.has(new Date(cursorTs).toISOString().slice(0, 10))) {
    current += 1;
    cursorTs -= dayMs;
  }
  // Peak day — single calendar day with the most prompts.
  let peakDay: InsightsData['peakDay'] = null;
  for (const [date, prompts] of promptsByDay.entries()) {
    if (!peakDay || prompts > peakDay.prompts) peakDay = { date, prompts };
  }
  const firstSeenAt = sessions
    .map((s) => s.startedAt)
    .filter((ts) => ts > 0)
    .reduce((min, ts) => (ts < min ? ts : min), Number.MAX_SAFE_INTEGER);
  return {
    streak: { current, longest },
    peakDay,
    firstSeenAt: firstSeenAt === Number.MAX_SAFE_INTEGER ? null : firstSeenAt
  };
}

/**
 * Roll per-tool stats and group error strings by tool. Errors get
 * de-duped to "this tool failed N times with these distinct messages"
 * so the user sees patterns, not a flat noisy list.
 */
function aggregate(turnFiles: TurnFile[]): {
  toolStats: InsightsData['toolStats'];
  errorClusters: InsightsData['errorClusters'];
} {
  const toolStats: InsightsData['toolStats'] = new Map();
  const errorBuckets = new Map<string, Map<string, number>>();
  for (const tf of turnFiles) {
    for (const ev of tf.events) {
      if (ev.type === 'tool-execute' && ev.name) {
        const cur = toolStats.get(ev.name) ?? { calls: 0, errors: 0 };
        cur.calls += 1;
        toolStats.set(ev.name, cur);
      } else if ((ev.type === 'tool-result' || ev.type === 'tool-error') && ev.name && (ev.isError || ev.type === 'tool-error')) {
        const cur = toolStats.get(ev.name) ?? { calls: 0, errors: 0 };
        cur.errors += 1;
        // tool-error events carry `error`; tool-result events with
        // isError=true carry the message in `outputPreview`. Without
        // the fallback, errorBuckets stayed empty for tool-result
        // errors and the "Top error patterns" panel rendered "clean
        // run" even when the tools table tallied 100+ errors.
        const errText = ev.error ?? ev.outputPreview;
        if (errText) cur.lastError = errText.slice(0, 200);
        toolStats.set(ev.name, cur);
        if (errText) {
          const bucket = errorBuckets.get(ev.name) ?? new Map<string, number>();
          // Trim error to a stable key — common prefixes match across runs.
          const key = errText.slice(0, 120);
          bucket.set(key, (bucket.get(key) ?? 0) + 1);
          errorBuckets.set(ev.name, bucket);
        }
      }
    }
  }
  const errorClusters: InsightsData['errorClusters'] = new Map();
  for (const [tool, bucket] of errorBuckets.entries()) {
    const sorted = [...bucket.entries()]
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    errorClusters.set(tool, sorted);
  }
  return { toolStats, errorClusters };
}

/**
 * Scan recent user prompts for emotional cues and tally them. Pure
 * keyword matching — fast, deterministic, runs locally. Output drives
 * both the report's sentiment chip row and the AI callback's input
 * (so the AI can reference frustration moments without doing arithmetic
 * itself, which it routinely does badly).
 *
 * Categories:
 * satisfied — "thanks", "got it", "works", "good", "ok"
 * happy — "ty", "thx", "nice", "lol"
 * excited — "love", "awesome", "amazing", "perfect", "blown away", "🔥"
 * frustrated — profanity stems, "wtf", "ugh", "stop", "still broken",
 * "didn't work", "again?", "this isn't working"
 * unsatisfied — "doesn't work", "still wrong", "not what I asked",
 * "no", "wrong", "stuck"
 *
 * Profanity content is NOT surfaced. The notable[] array carries
 * redacted snippets ("[redacted] still broken") so the report shows
 * context without echoing the words back.
 */
function scanSentiment(sessions: SessionFile[]): SentimentCounts {
  const counts: SentimentCounts = {
    satisfied: 0,
    happy: 0,
    excited: 0,
    frustrated: 0,
    unsatisfied: 0,
    notable: []
  };
  // Deliberately matching common stems — case-insensitive, word-boundary
  // so "stuck" doesn't match "Stuckey" and "ass" doesn't match "class".
  const PROFANITY = /\b(f[*u@]ck(?:ing|er|ed)?|sh[*i!]t(?:ty|s)?|d[*a@]mn(?:it)?|b[*i!]tch|cr[*a@]p|hell|wtf|stfu)\b/i;
  const FRUSTRATED = /\b(ugh+|argh+|sigh|stop|still (?:broken|not working|wrong)|didn'?t work|isn'?t working|not working|again\??|why (?:isn'?t|aren'?t|won'?t|doesn'?t)|come on|seriously|stuck on|over and over|loop(?:ing)?|frustrat\w+|annoy\w+)\b/i;
  const UNSATISFIED = /\b(doesn'?t work|wrong|incorrect|not what i (?:asked|wanted)|that'?s? not (?:right|it)|nope|not (?:right|good|correct)|disappointed|underwhelm\w+)\b/i;
  const SATISFIED = /\b(thanks|thank you|got it|works|working now|cool|ok(?:ay)?|sounds good|makes sense|good (?:job|stuff|work)|nicely done|that worked)\b/i;
  const HAPPY = /\b(ty|thx|nice|haha|lol|sweet|neat)\b/i;
  const EXCITED = /\b(love (?:it|this|that)|awesome|amazing|incredible|perfect|fantastic|blown? away|brilliant|excellent|chef'?s? kiss|fabulous|legend\w*|impressive|so cool)|🔥|❤️|🎉|💯/i;

  const HOME_LOCAL = path.join(HOME, '.bandit', 'sessions');
  for (const session of sessions) {
    let prompts: string[] = [];
    try {
      const text = fs.readFileSync(path.join(HOME_LOCAL, session.id + '.jsonl'), 'utf-8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let parsed: { role?: string; content?: string } | null = null;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (!parsed || parsed.role !== 'user' || typeof parsed.content !== 'string') continue;
        if (parsed.content.startsWith('<tool_result')) continue;
        prompts.push(parsed.content);
      }
    } catch { continue; }

    for (const raw of prompts) {
      const p = raw.trim();
      if (!p) continue;
      const profMatch = PROFANITY.test(p);
      const frusMatch = FRUSTRATED.test(p);
      const unsatMatch = UNSATISFIED.test(p);
      // Frustration / profanity / "doesn't work" all roll into frustrated.
      // A profanity hit is also counted as frustrated (people don't curse
      // when they're delighted), but we keep them separate in `notable`
      // so the report can flag profanity with a softer label.
      if (profMatch || frusMatch) {
        counts.frustrated++;
        if (counts.notable.length < 3) {
          // Redact profanity for the snippet so the report doesn't echo
          // it. Keep the surrounding 60 chars for context.
          const redacted = p.replace(PROFANITY, '[redacted]').replace(/\s+/g, ' ').slice(0, 80);
          counts.notable.push(redacted);
        }
      }
      if (unsatMatch) counts.unsatisfied++;
      if (SATISFIED.test(p)) counts.satisfied++;
      if (HAPPY.test(p)) counts.happy++;
      if (EXCITED.test(p)) counts.excited++;
    }
  }
  return counts;
}

export function computeInsights(cwd: string): InsightsData {
  const sessions = loadSessions();
  const turnFiles = loadTurnFiles(cwd);
  const { toolStats, errorClusters } = aggregate(turnFiles);
  const accomplishments = computeAccomplishments(turnFiles);
  const work = computeWork(turnFiles);
  const totalPrompts = sessions.reduce((sum, s) => sum + s.prompts, 0);
  const totalApproxTokens = Math.round(sessions.reduce((sum, s) => sum + s.approxChars, 0) / 4);
  const { streak, peakDay, firstSeenAt } = computeActivityMetrics(sessions);
  const sentiment = scanSentiment(sessions);
  const data: InsightsData = {
    generatedAt: Date.now(),
    cwd,
    sessions,
    turnFiles,
    toolStats,
    errorClusters,
    totalPrompts,
    totalApproxTokens,
    accomplishments,
    work,
    localStory: [],
    streak,
    peakDay,
    firstSeenAt,
    sentiment
  };
  data.localStory = buildLocalStory(data);
  return data;
}

/** Build the privacy-aware payload handed to an AI summarizer.
 * Caps everything to small amounts of data — no raw turn logs, no
 * full session contents, prompt titles trimmed to first ~120 chars.
 * This is what gets sent to the user's LLM, so it must contain
 * nothing the user wouldn't paste into a chat themselves. */
function buildAiInput(data: InsightsData): AiSummaryInput {
  const topTools = [...data.toolStats.entries()]
    .map(([name, s]) => ({
      name,
      calls: s.calls,
      errors: s.errors,
      errorRate: s.calls > 0 ? s.errors / s.calls : 0
    }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 8);
  const topErrors = [...data.errorClusters.entries()]
    .flatMap(([tool, bucket]) => bucket.map((b) => ({ tool, error: b.error, count: b.count })))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
  // Pull recent prompt excerpts (up to 280 chars × 25) for narrative
  // material. Skips tool_result echoes and metadata-only entries. Each
  // excerpt is timestamped to the session date so the LLM can write
  // "earlier in the period you…" / "yesterday you…" naturally.
  const recentPromptExcerpts: { date: string; text: string }[] = [];
  const dir = path.join(HOME, '.bandit', 'sessions');
  for (const session of data.sessions.slice(0, 12)) {
    if (recentPromptExcerpts.length >= 25) break;
    const sessionDate = new Date(session.startedAt).toISOString().slice(0, 10);
    try {
      const text = fs.readFileSync(path.join(dir, session.id + '.jsonl'), 'utf-8');
      for (const line of text.split('\n')) {
        if (recentPromptExcerpts.length >= 25) break;
        if (!line.trim()) continue;
        let parsed: { role?: string; content?: string } | null = null;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (!parsed || parsed.role !== 'user' || typeof parsed.content !== 'string') continue;
        if (parsed.content.startsWith('<tool_result')) continue;
        if (parsed.content.startsWith('[Background tasks')) continue;
        const excerpt = parsed.content.replace(/\s+/g, ' ').trim().slice(0, 280);
        if (excerpt.length > 6) recentPromptExcerpts.push({ date: sessionDate, text: excerpt });
      }
    } catch {
      /* unreadable — skip */
    }
  }
  // windowDays — derived from oldest session timestamp so the LLM knows
  // whether to write "the last 3 days" or "the last 5 weeks".
  const sessionTimestamps = data.sessions
    .map((s) => s.startedAt)
    .filter((t): t is number => typeof t === 'number' && t > 0);
  const oldest = sessionTimestamps.length > 0 ? Math.min(...sessionTimestamps) : Date.now();
  const windowDays = Math.max(1, Math.round((Date.now() - oldest) / (24 * 60 * 60 * 1000)));
  return {
    totalPrompts: data.totalPrompts,
    totalSessions: data.sessions.length,
    filesTouched: data.accomplishments.filesTouched,
    filesWritten: data.accomplishments.filesWritten,
    editsApplied: data.accomplishments.editsApplied,
    gitOperations: data.accomplishments.gitOperations,
    subagentsSpawned: data.accomplishments.subagentsSpawned,
    testsRun: data.accomplishments.testsRun,
    windowDays,
    topTools,
    topErrors,
    recentPromptExcerpts,
    workHighlights: data.work.highlights.slice(0, 10).map((h) => ({
      date: h.date,
      title: h.title,
      area: h.area,
      category: h.category,
      outcome: h.outcome,
      prompt: h.prompt.replace(/\s+/g, ' ').trim().slice(0, 400),
      turns: h.turns,
      filesTouched: h.filesTouched,
      filesInspected: h.filesInspected,
      externalActions: h.externalActions,
      testsRun: h.testsRun,
      gitOperations: h.gitOperations,
      subagentsSpawned: h.subagentsSpawned,
      commands: h.commands.slice(0, 3),
      topFiles: h.topFiles.slice(0, 4).map((f) => f.path),
      languages: h.languages.slice(0, 4).map((l) => l.label)
    })),
    workThemes: data.work.themes.slice(0, 6).map((t) => ({
      title: t.title,
      turns: t.turns,
      filesTouched: t.filesTouched,
      testsRun: t.testsRun,
      externalActions: t.externalActions,
      subagentsSpawned: t.subagentsSpawned,
      latest: t.latestDate,
      sampleTitles: t.sampleTitles.slice(0, 3),
      outcomes: t.outcomes.slice(0, 2),
      topFiles: t.topFiles.slice(0, 3).map((f) => f.path),
      languages: t.languages.slice(0, 4).map((l) => l.label)
    })),
    sentiment: data.sentiment
  };
}

export { buildAiInput };

/**
 * Single non-streaming chat function — provided by the host (CLI builds
 * a fresh provider, IDE wraps its own provider settings). Same shape on
 * both sides so the callback below renders identically regardless of
 * which surface called it.
 */
export type OneShotChatFn = (
  prompt: string,
  opts?: { systemPrompt?: string; timeoutMs?: number }
) => Promise<string | null>;

/**
 * Build the AI summary callback handed to `writeInsightsReport({ ai })`.
 *
 * Centralised so the CLI's `/insights` and the VS Code extension's
 * `banditStealth.insights` produce byte-identical prompts and parse
 * the response the same way. Without this, every surface that wants AI
 * summaries had to duplicate the system prompt + JSON-extraction logic
 * and the two could drift — the IDE's report ended up skipping AI
 * entirely ( ) while the CLI rendered the full
 * shipped/friction blocks. One helper, one prompt, identical output.
 */
export function buildInsightsAiCallback(opts: {
  oneShotChat: OneShotChatFn;
  modelLabel: string;
  /** Override the default 30s timeout if the host wants tighter bounds. */
  timeoutMs?: number;
}): AiSummaryFn {
  const system = `You are Bandit, an AI coding assistant, writing a journal-entry-style narrative of what the user did over the last ${'${windowDays}'} days. Read the prompt excerpts and work highlights CAREFULLY — they contain the actual story. Your job is to tell it back in a way that's specific, honest, and never generic.

Output JSON with these fields, in this order:

1. "storyline" — 2 to 4 paragraphs of NARRATIVE PROSE, second person ("you"), written like the Claude.ai insights summary. Each paragraph 2-4 sentences. NAME SPECIFIC THINGS the user worked on (from recentPromptExcerpts and workHighlights[].prompt — pull verbatim phrases like "deep self-evaluation of Bandit", "MCP connectors", "open source prep"). Mention file paths only when they add color (e.g. "concentrated in clients.ts"). Catch side-quests and non-coding threads (career thoughts, frustration moments, meta prompts) when the excerpts reveal them. NEVER list counters as a sentence — weave them into prose ("you spawned 122 subagents to probe X" not "subagents: 122"). NEVER write a generic opener like "Over the last N days you worked on various projects." If you can't make it specific, write less.

2. "shipped" — 3 short bullets, accomplishment framing. Specific, like the storyline.

3. "patterns" — 3 short bullets, HOW the user works (tool mix, commit cadence, debug style, language focus, delegation to subagents). Reference sentiment + recent prompts.

4. "friction" — 3 short bullets where YOU (Bandit) got in the user's way. Own every miss as Bandit's behavior; never blame the user. If sentiment shows frustrated/unsatisfied counts or notable phrases, name what Bandit did to earn it.

Bullet length: under 22 words each. Storyline paragraphs: 2-4 sentences each, conversational.

Return JSON ONLY: {"storyline":[...2-4 paragraph strings...],"shipped":[...3 strings...],"patterns":[...3 strings...],"friction":[...3 strings...]} and nothing else. No code fences, no markdown, no commentary.`;
  return async (input) => {
    const systemWithWindow = system.replace('${windowDays}', String(input.windowDays));
    const userMsg = JSON.stringify({
      windowDays: input.windowDays,
      totalPrompts: input.totalPrompts,
      totalSessions: input.totalSessions,
      filesTouched: input.filesTouched,
      editsApplied: input.editsApplied,
      filesWritten: input.filesWritten,
      gitOperations: input.gitOperations,
      subagentsSpawned: input.subagentsSpawned,
      testsRun: input.testsRun,
      topTools: input.topTools.slice(0, 6),
      topErrors: input.topErrors.slice(0, 6),
      recentPromptExcerpts: input.recentPromptExcerpts.slice(0, 25),
      workHighlights: input.workHighlights.slice(0, 10),
      workThemes: input.workThemes.slice(0, 6),
      sentiment: input.sentiment
    }, null, 2);
    const raw = await opts.oneShotChat(userMsg, {
      systemPrompt: systemWithWindow,
      // Storyline output is materially longer than the old 3-bullet
      // shape (~120-400 words vs ~60 words), so bump the timeout to
      // give a 27B-class local model room to finish without truncating.
      timeoutMs: opts.timeoutMs ?? 60_000
    });
    if (!raw) return null;
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const parsed = JSON.parse(m[0]) as { storyline?: unknown; shipped?: unknown; friction?: unknown; patterns?: unknown };
      const storyline = Array.isArray(parsed.storyline)
        ? parsed.storyline.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 4)
        : [];
      const shipped = Array.isArray(parsed.shipped)
        ? parsed.shipped.filter((b): b is string => typeof b === 'string').slice(0, 3)
        : [];
      const friction = Array.isArray(parsed.friction)
        ? parsed.friction.filter((b): b is string => typeof b === 'string').slice(0, 3)
        : [];
      const patterns = Array.isArray(parsed.patterns)
        ? parsed.patterns.filter((b): b is string => typeof b === 'string').slice(0, 3)
        : [];
      if (storyline.length === 0 && shipped.length === 0 && friction.length === 0 && patterns.length === 0) return null;
      return { modelLabel: opts.modelLabel, storyline, shipped, friction, patterns };
    } catch {
      return null;
    }
  };
}

/**
 * Heuristic productivity tips. Each one is a (predicate, tip) pair —
 * fire when the predicate matches the user's data. Kept dumb on
 * purpose; tips show only when there's a clear signal in the numbers.
 */
function buildTips(data: InsightsData): string[] {
  const tips: string[] = [];
  // Tip 1: apply_edit error rate over 20% → suggest /think on
  const applyEdit = data.toolStats.get('apply_edit');
  if (applyEdit && applyEdit.calls >= 5 && applyEdit.errors / applyEdit.calls > 0.2) {
    const pct = Math.round((applyEdit.errors / applyEdit.calls) * 100);
    tips.push(
      `<strong>apply_edit failing ${pct}% of the time</strong> over ${applyEdit.calls} calls. ` +
      `The most common cause is whitespace drift between your model's recall and the file on disk. ` +
      `Try <code>/think on</code> for tricky edits, or pin a smaller surface-area edit (single line).`
    );
  }
  // Tip 2: huge sessions never compacted → suggest /compact
  const giant = data.sessions.find((s) => s.approxChars > 200_000);
  if (giant) {
    tips.push(
      `<strong>You have at least one massive session</strong> (${(giant.approxChars / 1000).toFixed(0)}KB of conversation). ` +
      `Use <code>/compact</code> mid-session to trim old tool results — keeps context small and turns fast.`
    );
  }
  // Tip 3: never used /tasks → tip about background subagents
  const usedTask = data.toolStats.has('task');
  if (data.totalPrompts > 30 && !usedTask) {
    tips.push(
      `<strong>You've never used the <code>task</code> tool.</strong> Long investigations ("audit every call site of X") ` +
      `block the conversation while they run. Try <code>task(run_in_background="true")</code> — the synopsis lands on a ` +
      `later turn so you can keep working in the meantime.`
    );
  }
  // Tip 4: many run_command failures → check the allowlist or shell escaping
  const runCmd = data.toolStats.get('run_command');
  if (runCmd && runCmd.calls >= 10 && runCmd.errors / runCmd.calls > 0.3) {
    const pct = Math.round((runCmd.errors / runCmd.calls) * 100);
    tips.push(
      `<strong>run_command failing ${pct}% of the time</strong> over ${runCmd.calls} calls. ` +
      `If you were on a pre-1.7.114 build, this was almost entirely the missing <code>mkdir</code> / <code>mv</code> / <code>cp</code> ` +
      `entries on the allow-list — those shipped in 1.7.114. After upgrading, the residual misses are usually arg-quoting ` +
      `(spaces in paths) or commands that genuinely need a package install first.`
    );
  }
  // Tip 5: never customized BANDIT.md → suggest /init
  const usedInit = [...data.toolStats.keys()].some((k) => k === 'create_skill') ||
    data.sessions.some((s) => s.toolNames.has('write_file'));
  if (data.totalPrompts > 20 && !usedInit) {
    tips.push(
      `<strong>The agent has access to project memory</strong>, but you haven't seeded one yet. ` +
      `Run <code>/init</code> in the workspace root — bandit scans the repo and writes a <code>BANDIT.md</code> ` +
      `with project conventions, build/test commands, and architecture notes. Every future prompt picks it up automatically.`
    );
  }
  // Always-on: encourage skill discovery if the agent has been heavily used.
  if (data.totalPrompts > 50 && tips.length < 4) {
    tips.push(
      `<strong>You've sent ${data.totalPrompts}+ prompts.</strong> Notice repeated workflows? ` +
      `Ask the agent: <em>"create a skill that does X"</em> — it'll write a markdown playbook to ` +
      `<code>.bandit/skills/</code> and the next prompt picks it up automatically.`
    );
  }
  return tips;
}

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtBytes = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
};

const fmtRelative = (ts: number, now: number): string => {
  const ms = now - ts;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  if (ms < 7 * 86_400_000) return `${Math.round(ms / 86_400_000)}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
};

/**
 * Render the data as a single self-contained HTML document. Inline
 * CSS, no JavaScript, no external resources — opens in any browser
 * and is share-as-a-single-file friendly. Intentionally simple:
 * tables, bar charts via flex-width divs, no chart library.
 */
export function renderInsightsHtml(data: InsightsData): string {
  const now = data.generatedAt;
  const tips = buildTips(data);

  // Top-N tools by call count
  const toolRows = [...data.toolStats.entries()]
    .map(([name, s]) => ({ name, ...s, errorRate: s.calls > 0 ? s.errors / s.calls : 0 }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 15);
  const maxCalls = toolRows.reduce((m, r) => Math.max(m, r.calls), 0) || 1;

  // Recent sessions: filter out the empty-launch noise (1 prompt, 0 tool
  // calls, file size near the JSONL header). These are aborted REPL
  // startups (user opens bandit, types /quit) — twelve of them in a row
  // hide the actual work. Keep sessions that ran at least one tool call,
  // or sent more than one prompt (a real conversation).
  const recentSessions = data.sessions
    .filter((s) => s.toolCallCount > 0 || s.prompts > 1)
    .slice(0, 12);

  // Error clusters: pick the top tool with the most errors
  const errorList = [...data.errorClusters.entries()]
    .flatMap(([tool, bucket]) => bucket.map((b) => ({ tool, ...b })))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Prompts-per-day for the last 14 days
  const dayMs = 24 * 60 * 60 * 1000;
  const promptsByDay = new Map<string, number>();
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(now - i * dayMs).toISOString().slice(0, 10);
    promptsByDay.set(d, 0);
  }
  for (const s of data.sessions) {
    const d = new Date(s.startedAt).toISOString().slice(0, 10);
    if (promptsByDay.has(d)) promptsByDay.set(d, (promptsByDay.get(d) ?? 0) + s.prompts);
  }
  const dayMax = Math.max(...promptsByDay.values(), 1);

  const tipsHtml = tips.length > 0
    ? `<ul>${tips.map((t) => `<li>${t}</li>`).join('')}</ul>`
    : `<p class="dim">Not enough data yet — keep using bandit and run <code>/insights</code> again later.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Bandit Insights — ${new Date(now).toISOString().slice(0, 10)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0f17;
    --panel: #131826;
    --border: #1f2638;
    --text: #e7e9ea;
    --muted: #71767b;
    --accent: #38bdf8;
    --accent-strong: #0ea5e9;
    --warn: #f5a524;
    --bad: #f87171;
    --good: #4ade80;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: "Inter", -apple-system, system-ui, "Segoe UI", Helvetica, sans-serif;
    -webkit-font-smoothing: antialiased;
    line-height: 1.5;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 80px; }
  header {
    display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--border);
  }
  h1 {
    margin: 0;
    font-size: 22px;
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 12px;
  }
  h1 .logo {
    width: 32px;
    height: 32px;
    object-fit: contain;
    /* Fall back gracefully if the CDN is unreachable (image is decorative). */
  }
  h1 .accent { color: var(--accent); }
  .meta { color: var(--muted); font-size: 13px; }
  h2 {
    margin: 32px 0 12px;
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    font-weight: 600;
  }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 18px;
  }
  .grid { display: grid; gap: 16px; }
  .grid-4 { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
  .stat { padding: 14px; }
  .stat .v { font-size: 28px; font-weight: 700; color: var(--accent); }
  .stat .l { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; }
  th { color: var(--muted); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.06em; border-bottom: 1px solid var(--border); }
  tr td { border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: 0; }
  td.right, th.right { text-align: right; font-variant-numeric: tabular-nums; }
  .bar-cell { padding: 4px 8px; }
  .bar { display: flex; align-items: center; gap: 8px; }
  .bar-track { flex: 1; height: 8px; background: rgba(56,189,248,0.08); border-radius: 999px; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--accent); }
  .bar-fill.warn { background: var(--warn); }
  .bar-fill.bad { background: var(--bad); }
  .err-rate { font-size: 11px; padding: 2px 6px; border-radius: 999px; }
  .err-rate.ok { background: rgba(74,222,128,0.12); color: var(--good); }
  .err-rate.warn { background: rgba(245,165,36,0.12); color: var(--warn); }
  .err-rate.bad { background: rgba(248,113,113,0.12); color: var(--bad); }
  .day-bar { display: flex; align-items: end; gap: 4px; height: 100px; padding: 8px 0; }
  .day-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .day-col .col { width: 100%; min-height: 2px; background: var(--accent); border-radius: 2px 2px 0 0; }
  .day-col .lab { font-size: 9px; color: var(--muted); transform: rotate(-45deg); transform-origin: center; }
  .day-col .v { font-size: 10px; color: var(--muted); }
  .errors li { margin-bottom: 8px; font-size: 13px; }
  .errors .tool { font-family: var(--mono, monospace); color: var(--accent); }
  .errors .err { color: var(--bad); font-size: 12px; word-break: break-word; }
  .tips li { margin-bottom: 12px; padding: 12px 14px; background: rgba(56,189,248,0.04); border-left: 3px solid var(--accent); border-radius: 0 6px 6px 0; }
  .tips code { background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 3px; font-size: 90%; }
  .dim { color: var(--muted); }
  .pill { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(56,189,248,0.12); color: var(--accent); margin-left: 6px; vertical-align: middle; }
  .ai-grid { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 720px) { .ai-grid { grid-template-columns: 1fr; } }
  .ai-card { padding: 16px 18px; }
  .storyline { padding: 22px 26px; margin-bottom: 16px; background: linear-gradient(135deg, rgba(56,189,248,0.05), rgba(255,255,255,0.02)); border-left: 3px solid var(--accent); }
  .storyline p { margin: 0 0 14px; font-size: 14.5px; line-height: 1.65; color: var(--text); }
  .storyline p:last-child { margin-bottom: 0; }
  .ai-card h3 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); font-weight: 600; }
  .ai-card.shipped h3 { color: var(--good); }
  .ai-card.friction h3 { color: var(--warn); }
  .ai-card.patterns h3 { color: var(--accent); }
  .sent-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .sent-chip { font-size: 12px; padding: 5px 12px; border-radius: 999px; background: rgba(56,189,248,0.05); border: 1px solid var(--border); color: var(--text); }
  .sent-chip.sent-pos { background: rgba(34,197,94,0.07); border-color: rgba(34,197,94,0.25); }
  .sent-chip.sent-pos strong { color: var(--good); }
  .sent-chip.sent-neg { background: rgba(248,113,113,0.07); border-color: rgba(248,113,113,0.25); }
  .sent-chip.sent-neg strong { color: var(--warn); }
  .sent-notable { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
  .sent-notable-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 6px; }
  .sent-notable ul { margin: 0; padding-left: 18px; }
  .sent-notable li { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .ai-card ul { padding-left: 18px; margin: 0; }
  .ai-card li { margin-bottom: 8px; font-size: 13px; line-height: 1.55; }
  .work-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  .work-card h3 { margin: 0 0 6px; font-size: 15px; line-height: 1.3; }
  .work-card .sub { font-size: 12px; color: var(--muted); margin-bottom: 10px; }
  .work-card .summary { font-size: 13px; color: var(--text); margin-bottom: 10px; }
  .work-card .outcome { font-size: 12px; color: var(--good); padding: 8px 10px; margin: 8px 0 10px; border-radius: 6px; background: rgba(74,222,128,0.07); border: 1px solid rgba(74,222,128,0.16); }
  .work-card .file-list { margin: 8px 0 0; padding-left: 0; list-style: none; }
  .work-card .file-list li { font-size: 12px; color: var(--muted); margin-bottom: 4px; word-break: break-word; }
  .theme-card h3 { margin: 0 0 8px; font-size: 16px; }
  .theme-meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 10px; }
  .theme-meta span { font-size: 11px; padding: 3px 8px; border-radius: 999px; background: rgba(255,255,255,0.05); color: var(--muted); }
  .theme-card ul { margin: 8px 0 0; padding-left: 18px; }
  .theme-card li { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .lang-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .lang-chip { font-size: 11px; padding: 4px 10px; border-radius: 999px; background: rgba(56,189,248,0.08); color: var(--text); border: 1px solid rgba(56,189,248,0.18); }
  .lang-chip strong { color: var(--accent); }
  .share-btn { display: inline-block; margin-top: 8px; padding: 8px 14px; background: var(--accent); color: var(--bg); text-decoration: none; border-radius: 6px; font-size: 13px; font-weight: 600; }
  .share-btn:hover { background: var(--accent-strong); }
  ul, ol { padding-left: 18px; }
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; text-align: center; }
  footer a { color: var(--accent); }
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>
    <img src="https://cdn.burtson.ai/logos/bandit-stealth.png" alt="Bandit" class="logo" />
    Bandit <span class="accent">insights</span>
  </h1>
  <span class="meta">generated ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} · ${escape(data.cwd)}</span>
</header>

<h2>At a glance</h2>
<div class="grid grid-4">
  <div class="panel stat"><div class="v">${data.sessions.length}</div><div class="l">sessions</div></div>
  <div class="panel stat"><div class="v">${data.totalPrompts}</div><div class="l">user prompts</div></div>
  <div class="panel stat"><div class="v">~${fmtBytes(data.totalApproxTokens)}</div><div class="l">tokens (est)</div></div>
  <div class="panel stat"><div class="v">${[...data.toolStats.values()].reduce((s, t) => s + t.calls, 0)}</div><div class="l">tool calls</div></div>
</div>
${data.streak.longest > 0 || data.peakDay || data.firstSeenAt ? `
<div class="grid grid-4" style="margin-top:12px">
  ${data.streak.longest > 0 ? `<div class="panel stat"><div class="v">${data.streak.longest}d</div><div class="l">longest streak${data.streak.current > 0 ? ` · ${data.streak.current} now` : ''}</div></div>` : ''}
  ${data.peakDay ? `<div class="panel stat"><div class="v">${data.peakDay.prompts}</div><div class="l">peak day · ${escape(data.peakDay.date)}</div></div>` : ''}
  ${data.firstSeenAt ? `<div class="panel stat"><div class="v">${Math.max(1, Math.floor((now - data.firstSeenAt) / (24 * 60 * 60 * 1000)))}d</div><div class="l">since first run</div></div>` : ''}
  ${data.accomplishments.commitsMade > 0 ? `<div class="panel stat"><div class="v">${data.accomplishments.commitsMade}</div><div class="l">commits made</div></div>` : ''}
</div>` : ''}
${data.ai ? `
<h2>Your story <span class="pill">${escape(data.ai.modelLabel)}</span></h2>
${data.ai.storyline && data.ai.storyline.length > 0 ? `
<div class="panel storyline">
  ${data.ai.storyline.map((p) => `<p>${escape(p)}</p>`).join('')}
</div>` : ''}
<div class="ai-grid">
  <div class="panel ai-card shipped">
    <h3>What you shipped</h3>
    <ul>${data.ai.shipped.map((b) => `<li>${escape(b)}</li>`).join('')}</ul>
  </div>
  ${data.ai.patterns && data.ai.patterns.length > 0 ? `
  <div class="panel ai-card patterns">
    <h3>How you work</h3>
    <ul>${data.ai.patterns.map((b) => `<li>${escape(b)}</li>`).join('')}</ul>
  </div>` : ''}
  <div class="panel ai-card friction">
    <h3>Where Bandit got in your way</h3>
    <ul>${data.ai.friction.map((b) => `<li>${escape(b)}</li>`).join('')}</ul>
  </div>
</div>` : ''}
${data.localStory.length > 0 ? `
<h2>Recent wins <span class="pill">local synthesis</span></h2>
<div class="panel storyline">
  ${data.localStory.map((p) => `<p>${escape(p)}</p>`).join('')}
</div>` : ''}
${(() => {
  const s = data.sentiment;
  const total = s.satisfied + s.happy + s.excited + s.frustrated + s.unsatisfied;
  if (total === 0) return '';
  const chip = (label: string, count: number, klass: string) =>
    count > 0 ? `<span class="sent-chip ${klass}">${escape(label)} <strong>${count}</strong></span>` : '';
  const notable = s.notable.length > 0
    ? `<div class="sent-notable"><div class="sent-notable-label">Frustration moments</div><ul>${s.notable.map(n => `<li>${escape(n)}</li>`).join('')}</ul></div>`
    : '';
  return `
<h2>How you felt</h2>
<div class="panel">
  <div class="sent-row">
    ${chip('excited', s.excited, 'sent-pos')}
    ${chip('happy', s.happy, 'sent-pos')}
    ${chip('satisfied', s.satisfied, 'sent-pos')}
    ${chip('unsatisfied', s.unsatisfied, 'sent-neg')}
    ${chip('frustrated', s.frustrated, 'sent-neg')}
  </div>
  ${notable}
</div>`;
})()}

${data.work.themes.length > 0 ? `
<h2>Bigger arcs</h2>
<div class="work-grid">
  ${data.work.themes.slice(0, 6).map((theme) => `
  <div class="panel theme-card">
    <h3>${escape(theme.title)}</h3>
    <div class="theme-meta">
      <span>${theme.turns} turn${theme.turns === 1 ? '' : 's'}</span>
      ${theme.filesTouched > 0 ? `<span>${theme.filesTouched} files touched</span>` : ''}
      ${theme.editsAndWrites > 0 ? `<span>${theme.editsAndWrites} edits/writes</span>` : ''}
      ${theme.externalActions > 0 ? `<span>${theme.externalActions} external actions</span>` : ''}
      ${theme.testsRun > 0 ? `<span>${theme.testsRun} tests</span>` : ''}
      ${theme.subagentsSpawned > 0 ? `<span>${theme.subagentsSpawned} subagents</span>` : ''}
      <span>latest ${escape(theme.latestDate)}</span>
    </div>
    ${theme.languages.length > 0 ? `<div class="lang-row">${theme.languages.slice(0, 5).map((l) => `<span class="lang-chip">${escape(l.label)} <strong>${l.count}</strong></span>`).join('')}</div>` : ''}
    ${theme.outcomes.length > 0 ? `<ul>${theme.outcomes.slice(0, 2).map((t) => `<li>${escape(t)}</li>`).join('')}</ul>` : ''}
    ${theme.sampleTitles.length > 0 ? `<ul>${theme.sampleTitles.slice(0, 3).map((t) => `<li>${escape(t)}</li>`).join('')}</ul>` : ''}
  </div>`).join('')}
</div>` : ''}

${data.work.highlights.length > 0 ? `
<h2>Largest work highlights</h2>
<div class="work-grid">
  ${data.work.highlights.slice(0, 10).map((h) => `
  <div class="panel work-card">
    <div class="sub">${escape(h.date)} · ${escape(h.area)} · ${escape(h.category)}</div>
    <h3>${escape(h.title)}</h3>
    <div class="summary">${escape(h.summary)}</div>
    ${h.outcome ? `<div class="outcome">${escape(h.outcome)}</div>` : ''}
    ${h.languages.length > 0 ? `<div class="lang-row">${h.languages.slice(0, 4).map((l) => `<span class="lang-chip">${escape(l.label)} <strong>${l.count}</strong></span>`).join('')}</div>` : ''}
    ${h.topFiles.length > 0 ? `<ul class="file-list">${h.topFiles.slice(0, 4).map((f) => `<li><code>${escape(f.path)}</code> ${escape('×' + f.touches)}</li>`).join('')}</ul>` : ''}
  </div>`).join('')}
</div>` : ''}

<h2>Accomplishments</h2>
<div class="grid grid-4">
  <div class="panel stat"><div class="v">${data.accomplishments.filesTouched}</div><div class="l">files touched</div></div>
  <div class="panel stat"><div class="v">${data.accomplishments.editsApplied + data.accomplishments.filesWritten}</div><div class="l">edits + writes</div></div>
  <div class="panel stat"><div class="v">${data.accomplishments.gitOperations}</div><div class="l">git operations</div></div>
  <div class="panel stat"><div class="v">${data.accomplishments.subagentsSpawned}</div><div class="l">subagents spawned</div></div>
</div>
${data.accomplishments.testsRun > 0 ? `<div class="panel" style="margin-top:8px"><strong>${data.accomplishments.testsRun}</strong> test runs detected (npm test, pytest, vitest, dotnet test, go test, cargo test).</div>` : ''}
${data.accomplishments.languages.length > 0 ? `
<div class="panel" style="margin-top:12px">
  <h3 style="margin:0 0 10px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;">Languages touched</h3>
  <div class="lang-row">
    ${data.accomplishments.languages.map((l) => `<span class="lang-chip">${escape(l.label)} <strong>${l.count}</strong></span>`).join('')}
  </div>
</div>` : ''}
${data.accomplishments.topFiles.length > 0 ? `
<div class="panel" style="margin-top:12px">
  <h3 style="margin:0 0 8px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;">Most-touched files</h3>
  <table>
    <tbody>
      ${data.accomplishments.topFiles.map((f) => `<tr>
        <td><code>${escape(f.path)}</code></td>
        <td class="right">${f.touches}× edited</td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>` : ''}

<h2>Activity (last 14 days)</h2>
<div class="panel">
  <div class="day-bar">
    ${[...promptsByDay.entries()].map(([day, count]) => {
      const h = Math.max(2, Math.round((count / dayMax) * 80));
      return `<div class="day-col" title="${day}: ${count} prompts">
        <div class="v">${count > 0 ? count : '·'}</div>
        <div class="col" style="height:${h}px"></div>
        <div class="lab">${day.slice(5)}</div>
      </div>`;
    }).join('')}
  </div>
</div>

<h2>Tool usage (top ${toolRows.length})</h2>
<div class="panel">
  ${toolRows.length === 0
    ? '<p class="dim">No tool-call telemetry yet — turn logs accumulate as the agent works.</p>'
    : `<table>
        <thead><tr><th>Tool</th><th class="right">Calls</th><th class="bar-cell">Volume</th><th class="right">Errors</th><th class="right">Error rate</th></tr></thead>
        <tbody>
          ${toolRows.map((r) => {
            const pct = Math.round((r.calls / maxCalls) * 100);
            const errPct = Math.round(r.errorRate * 100);
            const errClass = errPct >= 25 ? 'bad' : errPct >= 10 ? 'warn' : 'ok';
            const fillClass = errPct >= 25 ? 'bad' : errPct >= 10 ? 'warn' : '';
            return `<tr>
              <td><code>${escape(r.name)}</code></td>
              <td class="right">${r.calls}</td>
              <td class="bar-cell"><div class="bar"><div class="bar-track"><div class="bar-fill ${fillClass}" style="width:${pct}%"></div></div></div></td>
              <td class="right">${r.errors}</td>
              <td class="right"><span class="err-rate ${errClass}">${errPct}%</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`}
</div>

<h2>Productivity tips</h2>
<div class="panel tips">
  ${tipsHtml}
</div>

<h2>Recent sessions</h2>
<div class="panel">
  ${recentSessions.length === 0
    ? '<p class="dim">No sessions yet — run <code>bandit</code> in your terminal to start one.</p>'
    : `<table>
        <thead><tr><th>Session</th><th>When</th><th class="right">Prompts</th><th class="right">Tool calls</th><th class="right">Size</th></tr></thead>
        <tbody>
          ${recentSessions.map((s) => `<tr>
            <td><code>${escape(s.id)}</code></td>
            <td>${escape(fmtRelative(s.startedAt, now))}</td>
            <td class="right">${s.prompts}</td>
            <td class="right">${s.toolCallCount}</td>
            <td class="right">${fmtBytes(s.approxChars)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
</div>

<h2>Top error patterns</h2>
<div class="panel">
  ${errorList.length === 0
    ? '<p class="dim">No tool errors recorded — clean run.</p>'
    : `<ul class="errors">
        ${errorList.map((e) => `<li>
          <span class="tool">${escape(e.tool)}</span> · <strong>${e.count}×</strong>
          <div class="err">${escape(e.error)}</div>
        </li>`).join('')}
      </ul>`}
</div>

${(() => {
  // Mailto body uses ONLY aggregate counts — no paths, no prompt
  // titles, no error strings. The full report is the HTML file
  // itself; we tell the user to attach it manually if they want
  // to share more than the headline numbers. Subject + body are
  // URL-encoded so emojis / spaces don't break the mailto handler.
  const subject = `Bandit insights — ${new Date(now).toISOString().slice(0, 10)}`;
  const bodyParts: string[] = [
    `Sharing my Bandit usage to help make it better. Counts only — full report HTML attached separately if I'm sending the file.`,
    ``,
    `Sessions: ${data.sessions.length}`,
    `User prompts: ${data.totalPrompts}`,
    `Tool calls: ${[...data.toolStats.values()].reduce((s, t) => s + t.calls, 0)}`,
    `Files touched: ${data.accomplishments.filesTouched}`,
    `Edits + writes: ${data.accomplishments.editsApplied + data.accomplishments.filesWritten}`,
    `Git operations: ${data.accomplishments.gitOperations} (${data.accomplishments.commitsMade} commits)`,
    `Subagents spawned: ${data.accomplishments.subagentsSpawned}`,
    `Tests run: ${data.accomplishments.testsRun}`
  ];
  if (data.streak.longest > 0) bodyParts.push(`Longest streak: ${data.streak.longest} days (current: ${data.streak.current})`);
  if (data.peakDay) bodyParts.push(`Peak day: ${data.peakDay.date} (${data.peakDay.prompts} prompts)`);
  if (data.accomplishments.languages.length > 0) {
    bodyParts.push(`Languages touched: ${data.accomplishments.languages.map((l) => `${l.label} ${l.count}`).join(', ')}`);
  }
  bodyParts.push('', `What I'd love to see improved:`, '');
  const bodyLines = bodyParts.join('\n');
  const href = `mailto:team@burtson.ai?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyLines)}`;
  return `<h2>Help shape Bandit</h2>
<div class="panel">
  <p style="margin:0 0 10px;font-size:13px;color:var(--text)">Want to send these aggregates to the Bandit team? The mailto button drops counts only into your default mail app — no file paths, no prompt titles, no error strings. If you want to share the full report, attach this HTML file manually.</p>
  <a href="${href}" class="share-btn">Share insights with team@burtson.ai</a>
</div>`;
})()}

<footer>
  Generated by <a href="https://burtson.ai">Bandit</a> · self-contained, no telemetry was sent · share this file freely
</footer>

</div>
</body>
</html>
`;
}

/**
 * CLI entry: write the HTML report and (optionally) open it in the
 * default browser. Returns the absolute output path on success.
 *
 * Default output is `~/.bandit/insights.html` — same root the CLI uses
 * for sessions/config/themes/skills. The bulk of the report's data
 * source is `~/.bandit/sessions/*.jsonl` (global, all repos), so the
 * report belongs at user level, not at any individual workspace's
 * `.bandit/` dir. The `~/.bandit/` directory is created if missing.
 * Pass `--out <path>` to override (resolved against cwd).
 */
export async function writeInsightsReport(opts: {
  cwd: string;
  out?: string;
  /** Optional AI summarizer. When provided, gets called with a
   * privacy-aware aggregate payload and may return a short
   * accomplishments + friction summary that renders at the top of
   * the report. Must return null (or throw) to fall back to the
   * static, non-AI report — failures here never block writing. */
  ai?: AiSummaryFn;
}): Promise<string> {
  const data = computeInsights(opts.cwd);
  if (opts.ai) {
    try {
      const summary = await opts.ai(buildAiInput(data));
      if (summary && summary.shipped.length > 0) {
        data.ai = summary;
      }
    } catch {
      // Static report still gets written. The AI section just won't
      // render. We deliberately don't surface the error to the user
      // here — the slash command logs its own status.
    }
  }
  const html = renderInsightsHtml(data);
  const outPath = opts.out
    ? path.resolve(opts.cwd, opts.out)
    : path.join(HOME, '.bandit', 'insights.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf-8');
  return outPath;
}

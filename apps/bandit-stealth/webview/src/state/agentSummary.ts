import type { AgentSummaryData, AgentSummaryFile } from "@burtson-labs/agent-ui";
import type { ConversationEntry } from "../types/webview";
import { stripTurnTokens } from "../util/stripTurnTokens";

export interface AgentSummaryEntry {
  id: string;
  data: AgentSummaryData;
  completedAt?: number | null;
}

// Loose mirror of AgentSummaryData for the JSON-parse cast — `type` is a
// literal `"agent-summary"` on the strict shape but the wire payload can
// be anything; we narrow it explicitly in `toAgentSummaryData`. Don't
// extend `Partial<AgentSummaryData>` here because TS now refuses to
// widen `type` back to `string` in a subtype.
export interface RawAgentSummaryPayload {
  type?: string;
  success?: boolean;
  goal?: string;
  planGoal?: string | null;
  confidence?: number;
  iterations?: number;
  steps?: AgentSummaryData["steps"];
  files?: unknown;
  feedback?: string;
  contextPaths?: string[];
  diffPreview?: string;
  diff?: string;
  reviewMarkdown?: string;
  backupPath?: string;
  summary?: string | null;
  completedAt?: number | null;
}

export const parseSummaryPayload = (payload?: string): RawAgentSummaryPayload | null => {
  if (typeof payload !== "string" || payload.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(payload) as RawAgentSummaryPayload;
  } catch {
    return null;
  }
};

export const normalizeSummaryFiles = (
  value: unknown
): AgentSummaryData["files"] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: AgentSummaryFile[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const path = (entry as { path?: string }).path;
    if (typeof path !== "string" || path.length === 0) {
      continue;
    }
    // Build each file with only the keys that actually have values so
    // the result matches AgentSummaryFile's optional shape exactly
    // (rather than the `T | undefined` shape an inline object literal
    // produces — which TS no longer treats as interchangeable in a
    // type-predicate position).
    const out: AgentSummaryFile = { path };
    const diff = (entry as { diff?: string }).diff;
    if (typeof diff === "string") {out.diff = diff;}
    const summary = (entry as { summary?: { added: number; removed: number } }).summary;
    if (summary) {out.summary = summary;}
    const confidence = (entry as { confidence?: number }).confidence;
    if (typeof confidence === "number") {out.confidence = confidence;}
    const review = (entry as { review?: string | null }).review;
    if (typeof review === "string") {out.review = review;}
    result.push(out);
  }
  return result.length > 0 ? result : undefined;
};

export const toAgentSummaryData = (payload: RawAgentSummaryPayload | null): AgentSummaryData | null => {
  if (!payload || payload.type !== "agent-summary") {
    return null;
  }
  const files = normalizeSummaryFiles(payload.files);
  const contextItems = Array.isArray(payload.contextPaths)
    ? payload.contextPaths
        .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
        .map((path) => ({ label: "Context file", value: path }))
    : undefined;
  return {
    type: "agent-summary",
    success: Boolean(payload.success),
    goal: stripTurnTokens(payload.goal ?? payload.planGoal ?? "Agent run"),
    confidence: typeof payload.confidence === "number" ? payload.confidence : undefined,
    iterations: typeof payload.iterations === "number" ? payload.iterations : undefined,
    steps: Array.isArray(payload.steps) ? payload.steps : undefined,
    files,
    feedback: typeof payload.feedback === "string" ? payload.feedback : undefined,
    context: contextItems,
    diffPreview: typeof payload.diffPreview === "string" ? payload.diffPreview : undefined,
    reviewMarkdown: typeof payload.summary === "string" ? payload.summary : undefined,
    backupPath: typeof payload.backupPath === "string" ? payload.backupPath : undefined
  };
};

export const buildAgentSummaryEntries = (entries: ConversationEntry[]): AgentSummaryEntry[] => {
  const summaries: AgentSummaryEntry[] = [];
  for (const entry of entries) {
    if (entry.role !== "assistant") {
      continue;
    }
    const parsed = parseSummaryPayload(entry.payload);
    const summaryData = toAgentSummaryData(parsed);
    if (!summaryData) {
      continue;
    }
    summaries.push({
      id: `${entry.id}:summary`,
      data: summaryData,
      completedAt: typeof parsed?.completedAt === "number" ? parsed.completedAt : null
    });
  }
  return summaries;
};

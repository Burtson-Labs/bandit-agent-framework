export type TraceViewMode = "all" | "failed";
export type TraceStatus = "completed" | "failed" | "blocked" | "cancelled" | "unknown";
export type TraceScope = "workspace" | "global" | "external";

export interface TraceSummaryPayload {
  id: string;
  filePath: string;
  scope: TraceScope;
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
  status: TraceStatus;
}

export interface TraceEventPayload {
  t?: string;
  type: string;
  iteration?: number;
  name?: string;
  detail?: string;
  isError?: boolean;
}

export interface TraceDetailPayload {
  summary: TraceSummaryPayload;
  events: TraceEventPayload[];
  markdown: string;
}

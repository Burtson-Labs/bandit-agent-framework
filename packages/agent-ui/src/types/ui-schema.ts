import type {
  AgentDiff,
  AgentEvent,
  AgentExecutionResult,
  AgentPlan,
  AgentStep,
  AgentStepStatus
} from "@burtson-labs/agent-core";
import type { ChatMessage as CoreChatMessage, ChatMessageContextFile as CoreChatMessageContextFile } from "@burtson-labs/core-chat";

export type AgentUIEventType =
  | "plan:start"
  | "plan:chunk"
  | "plan:complete"
  | "step:start"
  | "step:complete"
  | "step:error"
  | "diff:apply"
  | "log"
  | "telemetry"
  | "context:updated"
  | "report:chunk"
  | "report:complete"
  | (string & {});

export type AgentUIEvent<TPayload = unknown> = AgentEvent<TPayload> & {
  type: AgentUIEventType;
};

export interface AgentEventSource {
  on(event: string, listener: (event: AgentEvent) => void): void;
  off(event: string, listener: (event: AgentEvent) => void): void;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cache?: number;
}

export interface AgentTelemetryPayload {
  tokens?: Partial<TokenUsage>;
  latencyMs?: number;
  provider?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface GoalInsightTelemetry {
  id?: string;
  title?: string;
  intent?: string;
  files?: string[];
  rationale?: string;
}

export interface TaskProgressTelemetry {
  goalId?: string;
  completed: number;
  total: number;
}

export interface TelemetrySnapshot {
  totalEvents: number;
  tokens: TokenUsage;
  latencyMs?: number;
  model?: string;
  provider?: string;
  startedAt?: number;
  lastEventAt?: number;
  completedSteps: number;
  failedSteps: number;
  totalSteps?: number;
  averageStepDurationMs?: number;
  goalInsight?: GoalInsightTelemetry;
  taskProgress?: TaskProgressTelemetry;
}

export interface PlanTreeState {
  plan: AgentPlan | null;
  stepStatuses: Record<string, AgentStepStatus>;
}

export interface DiffStreamEntry {
  id: string;
  timestamp: number;
  stepId?: string;
  stepTitle?: string;
  diff: AgentDiff;
}

export interface AgentConsoleEntry {
  id: string;
  label: string;
  message: string;
  timestamp: number;
  level: "info" | "warn" | "error" | "debug";
  metadata?: Record<string, unknown>;
}

export interface StepCompletePayload {
  step: AgentStep;
  result: AgentExecutionResult;
}

export interface AgentSummaryFile {
  path: string;
  summary?: {
    added: number;
    removed: number;
  };
  confidence?: number;
  diff?: string;
  review?: string;
}

export interface AgentSummaryContextItem {
  label: string;
  value: string;
}

export interface AgentSummaryData {
  type: "agent-summary";
  success: boolean;
  goal: string;
  confidence?: number;
  iterations?: number;
  steps?: Array<{ id: string; status: string }>;
  files?: AgentSummaryFile[];
  feedback?: string;
  context?: AgentSummaryContextItem[];
  diffPreview?: string;
  diff?: string;
  reviewMarkdown?: string;
  backupPath?: string;
}

export interface DiffReviewPayload {
  path: string;
  hasBackup?: boolean;
  message?: string;
  state?: "pending" | "apply" | "explain" | "discard" | "error";
}

export type ChatMessageContextFile = CoreChatMessageContextFile;
export type ChatMessage = CoreChatMessage;

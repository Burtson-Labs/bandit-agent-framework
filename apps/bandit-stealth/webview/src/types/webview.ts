import type { Goal, Task } from "@burtson-labs/agent-core";

export type ModeKind = "ask" | "agent";

export type FeedbackRating = "up" | "down";

export interface ConversationFeedback {
  rating?: FeedbackRating;
  submitted?: boolean;
  submittedAt?: number;
}

export interface ConversationEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  payload?: string;
  feedback?: ConversationFeedback;
  contextFiles?: string[];
  contextSource?: "manual" | "auto";
  images?: string[];
}

export interface ConversationSummary {
  id: string;
  name: string;
  updatedAt: number;
  archived: boolean;
}

export interface PlanStep {
  id: string;
  title: string;
  details: string;
  command?: string;
  targetFile?: string;
  metadata?: Record<string, unknown>;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  tasks?: Task[];
  goals?: Goal[];
}

export interface AgentTelemetryPayload {
  stepId?: string;
  durationMs?: number;
  tokens?: number;
  ok?: boolean;
  kind?: "goal-inference" | "task-progress";
  goal?: {
    id?: string;
    title?: string;
    intent?: string;
    files?: string[];
    rationale?: string;
  };
  progress?: {
    goalId?: string;
    completed?: number;
    total?: number;
  };
}

export interface IntentInsight {
  action: string;
  target?: string;
  intent?: string;
  summary?: string;
  confidence?: number;
  rationale?: string;
}

export interface IntentSuggestion {
  label: string;
  summary: string;
  action: string;
  confidence?: number;
}

export interface PlanRunEvaluation {
  success?: boolean;
  confidence?: number;
  feedback?: string;
}

export interface PlanRunSummary {
  id: string;
  goal: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
  evaluation?: PlanRunEvaluation | null;
  artifactsPath?: string | null;
  plan: Plan;
  updates: Record<string, ConversationPlanStepState>;
}

export interface ConversationPlanStepState {
  state?: string;
  summary?: string;
  durationMs?: number;
  tokens?: number;
  updatedAt?: number;
}

export interface ContextUsage {
  used: number;
  limit: number;
}

export interface AccountProfile {
  valid?: boolean;
  userId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  plan?: string;
  credits?: number;
  gatewayToken?: string;
  keyId?: string;
  maskedKey?: string;
  isAdmin?: boolean;
  isArchived?: boolean;
  roles?: string[];
  expiresAt?: string;
  expiresIn?: number;
}

export type AccountProfileStatus = "idle" | "loading" | "error";

export interface WebviewState {
  messages: ConversationEntry[];
  hasApiKey: boolean;
  hasStoredApiKey: boolean;
  requiresApiKey: boolean;
  isBusy: boolean;
  statusText?: string;
  provider: string;
  model: string;
  ollamaModel?: string;
  ollamaUrl?: string;
  mode: ModeKind;
  presetPrompt?: string;
  currentConversationId?: string;
  currentConversationName?: string;
  history: ConversationSummary[];
  hasArchivedConversations: boolean;
  showHistory: boolean;
  allowImageUploads: boolean;
  showIntentChips: boolean;
  intentInsight?: IntentInsight | null;
  intentSuggestions?: IntentSuggestion[];
  feedbackEnabled: boolean;
  contextUsage: ContextUsage | null;
  undoAvailable?: boolean;
  plan?: Plan | null;
  planUpdates?: Record<string, ConversationPlanStepState>;
  planHistory?: PlanRunSummary[];
  planUnread?: boolean;
  activeView?: "conversation" | "plan";
  activePlanRunId?: string | null;
  debugEmitPlanJson?: boolean;
  accountProfile?: AccountProfile | null;
  accountProfileStatus?: AccountProfileStatus;
  accountProfileError?: string | null;
  enableToolUse?: boolean;
  developerMode?: boolean;
  skipValidationInDev?: boolean;
  createBranchBeforeRun?: boolean;
  autoApproveEdits?: boolean;
  autoContextEnabled?: boolean;
  voiceAutoSpeakPref?: boolean;
  voiceMicPref?: boolean;
  ollamaStatus?: 'ready' | 'offline' | 'no-model' | 'unknown';
  ollamaModelMissing?: string;
  // ── Settings panel state (mirrors components/SettingsPanel's types) ──
  voiceMicEnabled?: boolean;
  voiceProviderSettings?: {
    sttProvider: "bandit" | "openai-whisper" | "custom";
    sttUrl: string;
    sttApiKey: string;
    sttModel: string;
    ttsProvider: "bandit" | "openai" | "elevenlabs" | "piper" | "custom";
    ttsUrl: string;
    ttsApiKey: string;
    ttsModel: string;
    ttsVoiceId: string;
  };
  mcpSnapshot?: Array<{
    name: string;
    command: string;
    args: string[];
    state: "idle" | "connecting" | "connected" | "error" | "disabled";
    toolCount?: number;
    errorMessage?: string;
    trusted?: boolean;
    activation?: "always" | "on-mention";
    providerHint?: string | null;
  }>;
}

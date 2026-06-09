/**
 * Inbound wire messages the embedded webview receives from the
 * extension host via `postMessage`. Lives in its own module so the
 * Arc W4 topic dispatchers under src/messageDispatch/ can import the
 * full discriminated union without back-edging into App.tsx.
 *
 * IMPORTANT: every discriminant value here is part of the wire
 * format. Adding a new variant is fine; renaming or removing any
 * existing one will silently break the running webview (the
 * extension-side `postMessage` callers are byte-string coupled).
 */
import type { ComposerSkillOption } from "@burtson-labs/agent-ui";
import type { AskUserQuestionPayload } from "../AskUserForm";
import type { DiffPreviewAction } from "../state/diffStorage";
import type { BackgroundTaskRecord } from "./backgroundTasks";
import type { TraceDetailPayload, TraceSummaryPayload, TraceViewMode } from "./trace";
import type {
  AgentTelemetryPayload,
  Plan,
  PlanRunSummary,
  WebviewState
} from "./webview";

export interface AgentPlanUpdateMessage {
  type: "agentPlanUpdate";
  stepId: string;
  status?: string;
  meta?: { summary?: string; durationMs?: number; tokens?: number };
  history?: PlanRunSummary[];
  activeRunId?: string | null;
}

export type WebviewMessage =
  | { type: "state"; state: WebviewState }
  | { type: "notification"; message: string }
  | { type: "error"; message: string }
  | { type: "requireApiKey" }
  | { type: "skillList"; skills: ComposerSkillOption[] }
  | { type: "agentPlan"; plan?: Plan | null; activeRunId?: string | null; history?: PlanRunSummary[] }
  | AgentPlanUpdateMessage
  | { type: "agentPlanHistory"; history: PlanRunSummary[]; activeRunId?: string | null }
  | { type: "agentTelemetry"; telemetry: AgentTelemetryPayload }
  | { type: "diffPreviewCard"; preview: { path: string; hasBackup: boolean } }
  | { type: "diffPreviewResult"; path: string; status: DiffPreviewAction | "error"; message?: string }
  | { type: "diffPreviewClear" }
  | { type: "contextFilesAdded"; files: { path: string; preview?: string }[] }
  | { type: "imageAttachmentsAdded"; images: string[] }
  | { type: "workspaceFileSuggestions"; entries: Array<{ path: string; isDir: boolean }> }
  | { type: "contextInjectionSkipped"; reason?: string; prompt?: string }
  | {
      type: "permissionRequest";
      id: string;
      tool: string;
      primary: string;
      description: string;
      bodyPreview?: string;
      risk?: string;
      warning?: string;
      diffStats?: { added: number; removed: number };
      command?: string;
      paramsPreview?: string;
    }
  | { type: "permissionResolved"; id: string }
  | { type: "userInputRequest"; id: string; questions: AskUserQuestionPayload[] }
  | { type: "playAudio"; entryId: string; mimeType: string; audioBase64: string }
  | { type: "audioError"; entryId: string; message: string }
  | { type: "voiceTranscription"; text: string }
  | {
      type: "extensionMicAvailability";
      available: boolean;
      kind?: "bundled" | "ffmpeg" | "sox" | "arecord";
      message: string;
      canAutoInstall?: boolean;
      installerName?: string;
    }
  | { type: "extensionMicError"; message: string }
  | { type: "backgroundTaskList"; tasks: BackgroundTaskRecord[] }
  | { type: "backgroundTaskUpdate"; task: BackgroundTaskRecord }
  | { type: "traceList"; traces: TraceSummaryPayload[]; mode: TraceViewMode; selectedId?: string | null }
  | { type: "traceDetail"; trace: TraceDetailPayload }
  | { type: "traceError"; message: string }
  | {
      type: "accountUsage";
      data: {
        authMethod: string;
        email?: string;
        userId?: string;
        plan: string;
        isAdmin: boolean;
        session: { used: number; limit: number; resetsAtUnix?: number };
        weekly: { used: number; limit: number; resetsAtUnix?: number };
      } | null;
      error?: string;
    }
  | {
      type: "rateLimited";
      window: "session" | "weekly" | string;
      resetsAtUnix?: number;
      message: string;
    }
  | {
      type: "agent:diffSnapshot";
      path?: string;
      diff?: string;
      summary?: { added: number; removed: number };
      confidence?: number;
      stepId?: string;
    }
  | {
      type: "agent:diffStream";
      path: string;
      kind: "start" | "progress" | "complete";
      content?: string;
    };

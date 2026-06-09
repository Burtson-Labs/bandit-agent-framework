import type { AgentEvent } from "@burtson-labs/agent-core";
import type {
  DiffPreviewCardPayload,
  DiffPreviewResultPayload,
  DiffSnapshotPayload
} from "../hooks/useLiveDiffEntries";
import type { WebviewMessage } from "../types/webviewMessage";

export interface DiffMessagesDeps {
  // Live-diff slice (from useLiveDiffEntries):
  handleDiffSnapshot: (payload: DiffSnapshotPayload) => void;
  handleDiffPreviewCard: (preview: DiffPreviewCardPayload) => void;
  handleDiffPreviewResult: (payload: DiffPreviewResultPayload) => void;
  handleDiffPreviewClear: () => void;

  // App-owned: the events trail entry for a fresh diff snapshot is
  // tied to the live run id (planRef.current?.id) which lives on the
  // plan hook's refs, so the App constructs the event and we just
  // forward it through appendEvents.
  buildDiffSnapshotEvent: (snapshot: DiffSnapshotPayload) => AgentEvent;
  appendEvents: (event: AgentEvent | AgentEvent[]) => void;

  // App-owned: the streaming-status indicator that lives in App
  // state (separate from the live-diff hook because it's a
  // transient render-only signal).
  setDiffStreamStatus: (
    next:
      | { path: string; chars: number }
      | null
      | ((prev: { path: string; chars: number } | null) => { path: string; chars: number } | null)
  ) => void;
}

/**
 * Topic dispatcher for diff-related messages — snapshots streaming in,
 * preview cards going through their idle → success / error lifecycle,
 * and the agent:diffStream chars-progress indicator.
 */
export function dispatchDiffMessage(
  message: WebviewMessage,
  deps: DiffMessagesDeps
): boolean {
  switch (message.type) {
    case "agent:diffSnapshot": {
      const snapshot: DiffSnapshotPayload = {
        path: message.path,
        diff: message.diff,
        summary: message.summary,
        confidence: message.confidence,
        stepId: message.stepId
      };
      deps.appendEvents(deps.buildDiffSnapshotEvent(snapshot));
      deps.handleDiffSnapshot(snapshot);
      return true;
    }
    case "agent:diffStream":
      if (message.kind === "start") {
        deps.setDiffStreamStatus({ path: message.path, chars: 0 });
      } else if (message.kind === "progress") {
        deps.setDiffStreamStatus((prev) =>
          prev
            ? { path: message.path, chars: prev.chars + (message.content?.length ?? 0) }
            : { path: message.path, chars: message.content?.length ?? 0 }
        );
      } else if (message.kind === "complete") {
        deps.setDiffStreamStatus(null);
      }
      return true;
    case "diffPreviewCard":
      deps.handleDiffPreviewCard(message.preview);
      return true;
    case "diffPreviewResult":
      deps.handleDiffPreviewResult(message);
      return true;
    case "diffPreviewClear":
      deps.handleDiffPreviewClear();
      return true;
    default:
      return false;
  }
}

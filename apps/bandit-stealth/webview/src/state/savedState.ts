/**
 * What the webview keeps across a reload. The view is not retained while
 * hidden, so switching to another sidebar view and back reloads it; VS
 * Code's per-webview state (`vscode.getState` / `setState`) is what
 * survives that. Each key belongs to one feature and is written with
 * `patchSavedState`, so features never overwrite each other's keys.
 *
 * Every access is guarded: tests and older hosts may have no state API.
 */
import type { QueuedMessage } from "@burtson-labs/agent-ui";

export interface SavedPromptQueue {
  /** Messages still waiting to send, oldest first. */
  items: QueuedMessage<SavedPromptQueueMessage>[];
  /** The turn the queue sent that had not ended yet. */
  inFlightTurnId: string | null;
}

export interface SavedPromptQueueMessage {
  text: string;
  images: string[];
  files: string[];
  autoContext: boolean;
}

export interface SavedState {
  promptQueue?: SavedPromptQueue;
  /** What was typed in the composer. */
  composerDraft?: string;
}

type StateApi = { getState?: () => unknown; setState?: (data: unknown) => void };

function api(): StateApi | undefined {
  const candidate = (globalThis as { vscode?: StateApi }).vscode;
  return candidate && typeof candidate === "object" ? candidate : undefined;
}

export function readSavedState(): SavedState {
  try {
    const raw = api()?.getState?.();
    return raw && typeof raw === "object" ? (raw as SavedState) : {};
  } catch {
    return {};
  }
}

export function patchSavedState(patch: Partial<SavedState>): void {
  const target = api();
  if (typeof target?.setState !== "function") {return;}
  try {
    target.setState({ ...readSavedState(), ...patch });
  } catch {
    // State is a convenience; a failed write must never break the view.
  }
}

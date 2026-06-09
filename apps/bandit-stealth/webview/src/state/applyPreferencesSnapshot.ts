import type { WebviewState } from "../types/webview";

/**
 * Setter surface for the user-preferences slice — every boolean
 * toggle that lives on App.tsx (plan artifacts, auto-approve edits,
 * auto-context, developer mode, etc). The feedback prompt was
 * removed from Settings in Apr 2026; we force it to false on every
 * snapshot rather than reading state.feedbackEnabled because the UI
 * no longer exposes a way to flip it back on. State stays so the
 * extension can still hydrate a persisted value, but the webview
 * ignores it.
 */
export interface PreferencesSnapshotDeps {
  setPlanArtifactsEnabled: (value: boolean) => void;
  setFeedbackPromptEnabled: (value: boolean) => void;
  setToolUseEnabled: (value: boolean) => void;
  setCreateBranchBeforeRun: (value: boolean) => void;
  setAutoApproveEdits: (value: boolean) => void;
  setAutoContextEnabled: (value: boolean) => void;
  setDeveloperMode: (value: boolean) => void;
  setSkipValidationInDev: (value: boolean) => void;
}

export function applyPreferencesSnapshot(state: WebviewState, deps: PreferencesSnapshotDeps): void {
  deps.setPlanArtifactsEnabled(state.debugEmitPlanJson !== false);
  // Feedback prompt was removed from Settings — force off (see file doc).
  deps.setFeedbackPromptEnabled(false);
  deps.setToolUseEnabled(state.enableToolUse === true);
  deps.setCreateBranchBeforeRun(state.createBranchBeforeRun === true);
  deps.setAutoApproveEdits(state.autoApproveEdits === true);
  if (typeof state.autoContextEnabled === "boolean") {
    deps.setAutoContextEnabled(state.autoContextEnabled);
  }
  deps.setDeveloperMode(Boolean(state.developerMode));
  deps.setSkipValidationInDev(state.skipValidationInDev ?? false);
}

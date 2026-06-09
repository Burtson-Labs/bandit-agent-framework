import { describe, expect, it, vi } from "vitest";
import { applyPreferencesSnapshot } from "../../src/state/applyPreferencesSnapshot";
import type { WebviewState } from "../../src/types/webview";

const makeDeps = () => ({
  setPlanArtifactsEnabled: vi.fn(),
  setFeedbackPromptEnabled: vi.fn(),
  setToolUseEnabled: vi.fn(),
  setCreateBranchBeforeRun: vi.fn(),
  setAutoApproveEdits: vi.fn(),
  setAutoContextEnabled: vi.fn(),
  setDeveloperMode: vi.fn(),
  setSkipValidationInDev: vi.fn()
});

const baseState = {
  messages: [],
  hasApiKey: false,
  hasStoredApiKey: false,
  requiresApiKey: false,
  isBusy: false,
  provider: "bandit",
  model: "bandit-core-1",
  mode: "ask",
  history: [],
  hasArchivedConversations: false,
  showHistory: false,
  allowImageUploads: false,
  showIntentChips: false,
  feedbackEnabled: false,
  contextUsage: null
} as WebviewState;

describe("applyPreferencesSnapshot", () => {
  it("feedback prompt is forced false regardless of the persisted value — the toggle was removed in Apr 2026 and the webview no longer exposes a way to flip it back on", () => {
    const deps = makeDeps();
    applyPreferencesSnapshot(
      { ...baseState, feedbackEnabled: true } as WebviewState,
      deps
    );
    expect(deps.setFeedbackPromptEnabled).toHaveBeenCalledWith(false);
  });

  it("debugEmitPlanJson defaults to ENABLED when omitted — only an explicit `false` turns plan artifacts off", () => {
    const deps = makeDeps();
    applyPreferencesSnapshot(baseState, deps);
    expect(deps.setPlanArtifactsEnabled).toHaveBeenCalledWith(true);

    applyPreferencesSnapshot({ ...baseState, debugEmitPlanJson: false }, deps);
    expect(deps.setPlanArtifactsEnabled).toHaveBeenLastCalledWith(false);

    applyPreferencesSnapshot({ ...baseState, debugEmitPlanJson: true }, deps);
    expect(deps.setPlanArtifactsEnabled).toHaveBeenLastCalledWith(true);
  });

  it("autoContextEnabled is only applied when explicitly boolean so an undefined field preserves the user's local setting", () => {
    const deps = makeDeps();
    applyPreferencesSnapshot(baseState, deps);
    expect(deps.setAutoContextEnabled).not.toHaveBeenCalled();

    applyPreferencesSnapshot({ ...baseState, autoContextEnabled: true }, deps);
    expect(deps.setAutoContextEnabled).toHaveBeenCalledWith(true);
  });

  it("boolean toggles use strict-true equality so non-bool truthy values do NOT flip them on", () => {
    const deps = makeDeps();
    applyPreferencesSnapshot(
      {
        ...baseState,
        enableToolUse: "true" as unknown as boolean,
        createBranchBeforeRun: "yes" as unknown as boolean,
        autoApproveEdits: 1 as unknown as boolean
      },
      deps
    );
    expect(deps.setToolUseEnabled).toHaveBeenCalledWith(false);
    expect(deps.setCreateBranchBeforeRun).toHaveBeenCalledWith(false);
    expect(deps.setAutoApproveEdits).toHaveBeenCalledWith(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { applyAccountSnapshot } from "../../src/state/applyAccountSnapshot";
import type { WebviewState } from "../../src/types/webview";

const makeDeps = () => ({
  setRequireKey: vi.fn(),
  setHasApiKey: vi.fn(),
  setAccountProfile: vi.fn(),
  setAccountProfileStatus: vi.fn(),
  setAccountProfileError: vi.fn(),
  setHasStoredApiKey: vi.fn(),
  setHasTavilyKey: vi.fn(),
  setExtensionVersion: vi.fn()
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

describe("applyAccountSnapshot", () => {
  it("requireKey is requiresApiKey AND NOT hasApiKey — gates the banner only when the host actually needs a key the user has not provided", () => {
    const deps = makeDeps();
    applyAccountSnapshot({ ...baseState, requiresApiKey: true, hasApiKey: false }, deps);
    expect(deps.setRequireKey).toHaveBeenCalledWith(true);

    applyAccountSnapshot({ ...baseState, requiresApiKey: true, hasApiKey: true }, deps);
    expect(deps.setRequireKey).toHaveBeenLastCalledWith(false);

    applyAccountSnapshot({ ...baseState, requiresApiKey: false, hasApiKey: false }, deps);
    expect(deps.setRequireKey).toHaveBeenLastCalledWith(false);
  });

  it("hasApiKey only coerces strict-true so other truthy values do not unlock the composer", () => {
    const deps = makeDeps();
    applyAccountSnapshot(
      { ...baseState, hasApiKey: "yes" as unknown as boolean },
      deps
    );
    expect(deps.setHasApiKey).toHaveBeenCalledWith(false);
  });

  it("missing account fields default cleanly so the settings panel renders an idle state instead of stale data", () => {
    const deps = makeDeps();
    applyAccountSnapshot(baseState, deps);
    expect(deps.setAccountProfile).toHaveBeenCalledWith(null);
    expect(deps.setAccountProfileStatus).toHaveBeenCalledWith("idle");
    expect(deps.setAccountProfileError).toHaveBeenCalledWith(null);
    expect(deps.setHasStoredApiKey).toHaveBeenCalledWith(false);
    expect(deps.setHasTavilyKey).toHaveBeenCalledWith(false);
    expect(deps.setExtensionVersion).toHaveBeenCalledWith("");
  });

  it("forwards a hydrated account snapshot through every setter", () => {
    const deps = makeDeps();
    const stateWithExtras = {
      ...baseState,
      hasApiKey: true,
      hasStoredApiKey: true,
      accountProfile: { userId: "u1", email: "x@y.io" },
      accountProfileStatus: "loading",
      accountProfileError: "boom",
      hasTavilyKey: true,
      extensionVersion: "1.7.42"
    } as unknown as WebviewState;
    applyAccountSnapshot(stateWithExtras, deps);
    expect(deps.setAccountProfile).toHaveBeenCalledWith({ userId: "u1", email: "x@y.io" });
    expect(deps.setAccountProfileStatus).toHaveBeenCalledWith("loading");
    expect(deps.setAccountProfileError).toHaveBeenCalledWith("boom");
    expect(deps.setHasStoredApiKey).toHaveBeenCalledWith(true);
    expect(deps.setHasTavilyKey).toHaveBeenCalledWith(true);
    expect(deps.setExtensionVersion).toHaveBeenCalledWith("1.7.42");
  });
});

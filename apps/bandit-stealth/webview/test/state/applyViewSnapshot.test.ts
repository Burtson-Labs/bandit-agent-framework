import { describe, expect, it, vi } from "vitest";
import { applyViewSnapshot } from "../../src/state/applyViewSnapshot";
import type { WebviewState } from "../../src/types/webview";

const makeDeps = () => ({
  setActiveView: vi.fn(),
  setPlanUnread: vi.fn()
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

describe("applyViewSnapshot", () => {
  it("opening the plan tab always clears the unread badge — the badge cannot survive its own activation", () => {
    const deps = makeDeps();
    applyViewSnapshot({ ...baseState, activeView: "plan", planUnread: true }, deps);
    expect(deps.setActiveView).toHaveBeenCalledWith("plan");
    expect(deps.setPlanUnread).toHaveBeenCalledWith(false);
  });

  it("planUnread only takes effect when the conversation tab is active so the badge appears only where it is visible", () => {
    const deps = makeDeps();
    applyViewSnapshot({ ...baseState, activeView: "conversation", planUnread: true }, deps);
    expect(deps.setActiveView).toHaveBeenCalledWith("conversation");
    expect(deps.setPlanUnread).toHaveBeenCalledWith(true);
  });

  it("missing activeView coerces to conversation — the safe default that hides the plan tab", () => {
    const deps = makeDeps();
    applyViewSnapshot(baseState, deps);
    expect(deps.setActiveView).toHaveBeenCalledWith("conversation");
    expect(deps.setPlanUnread).not.toHaveBeenCalled();
  });
});

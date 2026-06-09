import { describe, expect, it, vi } from "vitest";
import { applyMcpSnapshot } from "../../src/state/applyMcpSnapshot";
import { applyHistorySnapshot } from "../../src/state/applyHistorySnapshot";
import type { WebviewState } from "../../src/types/webview";

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

describe("applyMcpSnapshot", () => {
  it("a non-array mcpSnapshot is treated as empty — the extension always emits a fresh list on change, so missing/malformed means 'no servers'", () => {
    const setMcpSnapshot = vi.fn();
    applyMcpSnapshot(baseState, { setMcpSnapshot });
    expect(setMcpSnapshot).toHaveBeenCalledWith([]);

    setMcpSnapshot.mockClear();
    applyMcpSnapshot(
      { ...baseState, mcpSnapshot: "broken" as unknown as WebviewState["mcpSnapshot"] },
      { setMcpSnapshot }
    );
    expect(setMcpSnapshot).toHaveBeenCalledWith([]);
  });

  it("forwards a populated server list verbatim", () => {
    const setMcpSnapshot = vi.fn();
    const servers: NonNullable<WebviewState["mcpSnapshot"]> = [
      { name: "gh", command: "uvx", args: ["mcp-server-git"], state: "connected" }
    ];
    applyMcpSnapshot({ ...baseState, mcpSnapshot: servers }, { setMcpSnapshot });
    expect(setMcpSnapshot).toHaveBeenCalledWith(servers);
  });
});

describe("applyHistorySnapshot", () => {
  it("currentConversationName defaults to 'New Conversation' on first boot so the top bar never shows blank", () => {
    const deps = {
      setHistory: vi.fn(),
      setShowHistory: vi.fn(),
      setHasArchivedConversations: vi.fn(),
      setCurrentConversationName: vi.fn(),
      setCanUndoAgentChange: vi.fn()
    };
    applyHistorySnapshot(baseState, deps);
    expect(deps.setCurrentConversationName).toHaveBeenCalledWith("New Conversation");
  });

  it("undoAvailable is coerced via Boolean so an undefined wire field collapses to false rather than leaving the undo button stuck enabled", () => {
    const deps = {
      setHistory: vi.fn(),
      setShowHistory: vi.fn(),
      setHasArchivedConversations: vi.fn(),
      setCurrentConversationName: vi.fn(),
      setCanUndoAgentChange: vi.fn()
    };
    applyHistorySnapshot(baseState, deps);
    expect(deps.setCanUndoAgentChange).toHaveBeenCalledWith(false);

    applyHistorySnapshot({ ...baseState, undoAvailable: true }, deps);
    expect(deps.setCanUndoAgentChange).toHaveBeenLastCalledWith(true);
  });

  it("forwards the full history snapshot through every setter", () => {
    const deps = {
      setHistory: vi.fn(),
      setShowHistory: vi.fn(),
      setHasArchivedConversations: vi.fn(),
      setCurrentConversationName: vi.fn(),
      setCanUndoAgentChange: vi.fn()
    };
    const summary = { id: "c1", name: "First", updatedAt: 1, archived: false };
    applyHistorySnapshot(
      {
        ...baseState,
        history: [summary],
        showHistory: true,
        hasArchivedConversations: true,
        currentConversationName: "Active",
        undoAvailable: true
      },
      deps
    );
    expect(deps.setHistory).toHaveBeenCalledWith([summary]);
    expect(deps.setShowHistory).toHaveBeenCalledWith(true);
    expect(deps.setHasArchivedConversations).toHaveBeenCalledWith(true);
    expect(deps.setCurrentConversationName).toHaveBeenCalledWith("Active");
    expect(deps.setCanUndoAgentChange).toHaveBeenCalledWith(true);
  });
});

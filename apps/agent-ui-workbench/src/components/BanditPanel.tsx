import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChatComposer,
  ChatConversation,
  PermissionCard,
  TaskList,
  type ChatMessage,
  type ComposerSkillOption,
  type PermissionChoice,
  type SlashCommandHint
} from "@burtson-labs/agent-ui";
import { TopBar } from "../../../bandit-stealth/webview/src/components/TopBar";
import { mockMessages, mockPendingApproval } from "../mocks/mockConversation";
import {
  ASK_USER_FIXTURE,
  FIND_DIRECTORY_FIXTURE,
  LIST_FILES_FIXTURE,
  READ_FILE_FIXTURE,
  RUN_TERMINAL_FIXTURE,
  TODO_LIST_FIXTURE,
  WEB_FETCH_FIXTURE,
  WEB_SEARCH_FIXTURE,
  WRITE_FILE_FIXTURE
} from "../mocks/toolFixtures";
import { renderBanditMarkdown } from "../markdown/banditMarkdown";
import { AskUserCard, type AskUserPayload } from "./AskUserCard";
import { ToolPalette, type ToolId } from "./ToolPalette";
import { WorkbenchSettingsOverlay } from "./WorkbenchSettingsOverlay";

const fencedJson = (lang: string, payload: unknown): string =>
  "```" + lang + "\n" + JSON.stringify(payload) + "\n```";

const fencedCode = (lang: string, body: string): string =>
  "```" + lang + "\n" + body + "\n```";

const banditTl = (
  name: string,
  primary: string,
  durationMs: number,
  status: "done" | "running" | "error" = "done"
): string => fencedJson("bandit-tl", { name, primary, status, durationMs });

interface AskUserWidget {
  kind: "ask_user";
  id: string;
  payload: AskUserPayload;
}

interface TodoListWidget {
  kind: "todo_list";
  id: string;
  goal: typeof TODO_LIST_FIXTURE;
}

type ToolWidget = AskUserWidget | TodoListWidget;

const slashCommands: SlashCommandHint[] = [
  { name: "explain", description: "Explain the highlighted code or active file" },
  { name: "refactor", description: "Suggest a refactor for the current selection" },
  { name: "test", description: "Generate unit tests for the active file" },
  { name: "plan", description: "Ask the agent to produce a plan before acting" },
  { name: "trace", description: "Open the trace log browser" },
  { name: "insights", description: "Regenerate ~/.bandit/insights.html" }
];

const skillOptions: ComposerSkillOption[] = [
  { id: "core", name: "Core", description: "Filesystem + shell + read_file", source: "builtin" },
  { id: "git", name: "Git", description: "Branch / diff / commit / status", source: "builtin" },
  { id: "code-review", name: "Code review", description: "Inline review skill", source: "builtin" },
  { id: "plan", name: "Plan", description: "Step-by-step planning", source: "builtin" },
  { id: "semantic-search", name: "Semantic search", description: "Embedding-backed grep", source: "builtin" },
  { id: "test-gen", name: "Test generation", description: "Generate unit tests", source: "builtin" }
];

const PROVIDERS = ["Bandit AI", "Ollama", "OpenAI-compatible"] as const;
const MODELS = ["bandit-logic", "bandit-core-1", "gemma4:12b", "qwen2.5-coder:14b"] as const;

const mockHistory = [
  { id: "c-1", name: "Tell me all about this repo", updatedAt: "2026-06-06 09:14" },
  { id: "c-2", name: "Add Sepia + Solarized Light to the theme registry", updatedAt: "2026-06-05 17:42" },
  { id: "c-3", name: "Fence-collision hardening for bandit-* blocks", updatedAt: "2026-06-04 11:08" },
  { id: "c-4", name: "Workbench: build Extensions marketplace tab", updatedAt: "2026-06-03 22:51" },
  { id: "c-5", name: "Wire ask_user tool into agent-core registry", updatedAt: "2026-06-02 16:30" }
];

/**
 * Embeds the Bandit Stealth extension's actual side-panel chrome
 * inside the workbench sidebar. The `.stealth-shell` wrapper +
 * extension stylesheet (imported in main.tsx) give us the real
 * conversation surface, toolbar, and composer — not a workbench-only
 * lookalike. Conversation pane is the only scroll surface; approval
 * card docks above the composer to mirror the extension's queue.
 *
 * Toolbar buttons swap in lightweight overlays (history list, trace
 * placeholder, settings placeholder) so the preview behaves like the
 * shipped panel without booting the extension host.
 */
export function BanditPanel() {
  const [messages, setMessages] = useState(mockMessages);
  const [draft, setDraft] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [tracePanelOpen, setTracePanelOpen] = useState(false);
  const [activePage, setActivePage] = useState<"workspace" | "settings">("workspace");
  const [approval, setApproval] = useState<typeof mockPendingApproval | null>(mockPendingApproval);
  const [autoApprove, setAutoApprove] = useState(false);
  const [autoContext, setAutoContext] = useState(true);
  const [micState, setMicState] = useState<"idle" | "recording" | "uploading">("idle");
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>("Bandit AI");
  const [model, setModel] = useState<(typeof MODELS)[number]>("bandit-logic");
  const [widgets, setWidgets] = useState<ToolWidget[]>([]);
  const conversationRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the conversation pane on new messages — matches the
  // extension behavior so the screenshot demo and live use feel right.
  useEffect(() => {
    const node = conversationRef.current;
    if (!node) {return;}
    node.scrollTop = node.scrollHeight;
  }, [messages.length, approval]);

  const handleSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {return;}
    const id = Date.now();
    setMessages((prev) => [
      ...prev,
      { id: `user-${id}`, role: "user", content: trimmed },
      {
        id: `assistant-${id}`,
        role: "assistant",
        content:
          "Workbench preview: this is a mocked reply so the conversation surface keeps growing. Wire a real chatFn at runtime to swap this stub."
      }
    ]);
    setDraft("");
  }, []);

  const handleApprovalChoice = useCallback(
    (id: string, choice: PermissionChoice, notes?: string) => {
      console.info("[workbench] approval", { id, choice, notes });
      setApproval(null);
    },
    []
  );

  const handleNewConversation = useCallback(() => {
    setMessages([]);
    setApproval(null);
    setWidgets([]);
    setShowHistory(false);
    setTracePanelOpen(false);
    setActivePage("workspace");
  }, []);

  // Build a synthetic assistant message representing a tool run. The
  // workbench's banditMarkdown renderer maps each fence (bandit-tl,
  // bandit-search, bandit-terminal, etc.) to the matching tool
  // rendering — so this single helper composes any tool's output.
  const insertToolMessage = useCallback(
    (toolId: ToolId, body: string) => {
      const id = `tool-${toolId}-${Date.now()}`;
      const msg: ChatMessage = { id, role: "assistant", content: body };
      setMessages((prev) => [...prev, msg]);
    },
    []
  );

  const handleInsertTool = useCallback(
    (toolId: ToolId) => {
      switch (toolId) {
        case "read_file": {
          const body =
            banditTl("read_file", READ_FILE_FIXTURE.path, READ_FILE_FIXTURE.durationMs) +
            "\n\n" +
            fencedCode(READ_FILE_FIXTURE.language, READ_FILE_FIXTURE.excerpt);
          insertToolMessage(toolId, body);
          return;
        }
        case "list_files": {
          const body =
            banditTl("list_files", LIST_FILES_FIXTURE.pattern, LIST_FILES_FIXTURE.durationMs) +
            "\n\n" +
            fencedCode("text", LIST_FILES_FIXTURE.results.join("\n"));
          insertToolMessage(toolId, body);
          return;
        }
        case "write_file": {
          setApproval(WRITE_FILE_FIXTURE);
          // Also drop a tl row so the timeline shows the call.
          insertToolMessage(
            toolId,
            banditTl("write_file", WRITE_FILE_FIXTURE.primary, 2, "running")
          );
          return;
        }
        case "run_terminal": {
          const body =
            banditTl("run_terminal", RUN_TERMINAL_FIXTURE.command, RUN_TERMINAL_FIXTURE.durationMs) +
            "\n\n" +
            fencedJson("bandit-terminal", RUN_TERMINAL_FIXTURE);
          insertToolMessage(toolId, body);
          return;
        }
        case "web_search": {
          const body =
            banditTl("web_search", WEB_SEARCH_FIXTURE.query, WEB_SEARCH_FIXTURE.durationMs) +
            "\n\n" +
            fencedJson("bandit-search", WEB_SEARCH_FIXTURE);
          insertToolMessage(toolId, body);
          return;
        }
        case "web_fetch": {
          const body =
            banditTl("web_fetch", WEB_FETCH_FIXTURE.url, WEB_FETCH_FIXTURE.durationMs) +
            "\n\n" +
            fencedJson("bandit-fetch", WEB_FETCH_FIXTURE);
          insertToolMessage(toolId, body);
          return;
        }
        case "find_directory": {
          const body =
            banditTl("find_directory", FIND_DIRECTORY_FIXTURE.query, FIND_DIRECTORY_FIXTURE.durationMs) +
            "\n\n" +
            fencedJson("bandit-find", FIND_DIRECTORY_FIXTURE);
          insertToolMessage(toolId, body);
          return;
        }
        case "ask_user": {
          insertToolMessage(toolId, banditTl("ask_user", ASK_USER_FIXTURE.question.slice(0, 60) + "…", 1, "running"));
          setWidgets((prev) => [
            ...prev.filter((w) => w.kind !== "ask_user"),
            { kind: "ask_user", id: `aw-${Date.now()}`, payload: ASK_USER_FIXTURE }
          ]);
          return;
        }
        case "todo_list": {
          insertToolMessage(
            toolId,
            banditTl("todo_list", TODO_LIST_FIXTURE.title, 4)
          );
          setWidgets((prev) => [
            ...prev.filter((w) => w.kind !== "todo_list"),
            { kind: "todo_list", id: `tw-${Date.now()}`, goal: TODO_LIST_FIXTURE }
          ]);
          return;
        }
      }
    },
    [insertToolMessage]
  );

  const handleAskUserAnswer = useCallback(
    (widgetId: string, choice: string, freeText?: string) => {
      const summary = freeText ? `\`${freeText}\`` : `option \`${choice}\``;
      const userMsg: ChatMessage = {
        id: `ask-reply-${Date.now()}`,
        role: "user",
        content: `(ask_user reply) ${summary}`
      };
      setMessages((prev) => [...prev, userMsg]);
      setWidgets((prev) => prev.filter((w) => w.id !== widgetId));
    },
    []
  );

  // Decide which overlay (if any) covers the conversation pane.
  const overlay: "history" | "trace" | "settings" | null = showHistory
    ? "history"
    : tracePanelOpen
      ? "trace"
      : activePage === "settings"
        ? "settings"
        : null;

  return (
    <div className="stealth-shell workbench__bandit-shell">
      <TopBar
        toolbarTitle={mockHistory[0]?.name ?? "New conversation"}
        settingsButtonTooltip="Settings"
        activePage={activePage}
        showHistory={showHistory}
        isSettingsPage={activePage === "settings"}
        tracePanelOpen={tracePanelOpen}
        onToggleHistory={() => {
          setShowHistory((v) => !v);
          setTracePanelOpen(false);
          setActivePage("workspace");
        }}
        onOpenTracePanel={() => {
          setTracePanelOpen((v) => !v);
          setShowHistory(false);
          setActivePage("workspace");
        }}
        onNewConversation={handleNewConversation}
        onOpenSettings={() => {
          setActivePage("settings");
          setShowHistory(false);
          setTracePanelOpen(false);
        }}
        onHideSettings={() => setActivePage("workspace")}
      />
      <div className="workbench__bandit-conversation" ref={conversationRef}>
        {overlay === null ? (
          <>
            <ChatConversation
              messages={messages}
              renderMarkdown={renderBanditMarkdown}
            />
            {/* Match the extension: the approval card lives INSIDE the
                chat history so it scrolls with the rest of the turn,
                rather than getting docked above the composer. */}
            {approval && (
              <div className="workbench__bandit-approval-inline">
                <PermissionCard payload={approval} onChoice={handleApprovalChoice} />
              </div>
            )}
            {widgets.map((widget) => (
              <div key={widget.id} className="workbench__bandit-widget">
                {widget.kind === "ask_user" ? (
                  <AskUserCard payload={widget.payload} onAnswer={(_, c, f) => handleAskUserAnswer(widget.id, c, f)} />
                ) : (
                  <TaskList goal={widget.goal} />
                )}
              </div>
            ))}
          </>
        ) : overlay === "history" ? (
          <div className="workbench__overlay">
            <div className="workbench__overlay-title">History</div>
            <ul className="workbench__overlay-list">
              {mockHistory.map((entry) => (
                <li key={entry.id} className="workbench__overlay-item">
                  <span className="workbench__overlay-item-name">{entry.name}</span>
                  <span className="workbench__overlay-item-time">{entry.updatedAt}</span>
                </li>
              ))}
            </ul>
            <p className="workbench__overlay-note">
              Workbench preview — selecting a conversation would dispatch the same
              `selectConversation` message the extension uses.
            </p>
          </div>
        ) : overlay === "trace" ? (
          <div className="workbench__overlay">
            <div className="workbench__overlay-title">Trace logs</div>
            <p className="workbench__overlay-note">
              Workbench preview — the trace log browser renders per-turn telemetry
              with the same TraceLogPanel component the extension ships. Wire a
              live trace store to populate the list here.
            </p>
          </div>
        ) : (
          <WorkbenchSettingsOverlay onClose={() => setActivePage("workspace")} />
        )}
      </div>
      <div className="workbench__bandit-composer">
        <ToolPalette onInsert={handleInsertTool} />
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSubmit={handleSubmit}
          onAttach={() => console.info("[workbench] attach clicked")}
          modelLabel={model}
          placeholder="Message Bandit — @ to mention a file, / for commands"
          slashCommands={slashCommands}
          editAutoApproveEnabled={autoApprove}
          onToggleEditAutoApprove={() => setAutoApprove((v) => !v)}
          autoContextEnabled={autoContext}
          onToggleAutoContext={() => setAutoContext((v) => !v)}
          micState={micState}
          onMicStart={() => {
            setMicState("recording");
            // Auto-cycle through the states so the workbench preview
            // visibly walks the mic affordance without a real audio
            // pipeline behind it.
            window.setTimeout(() => setMicState("uploading"), 1800);
            window.setTimeout(() => setMicState("idle"), 3200);
          }}
          onMicStop={() => setMicState("idle")}
          onRequestSkills={() => skillOptions}
          settingsSlot={
            <div className="workbench__composer-settings">
              <label className="workbench__composer-setting">
                <span>Provider</span>
                <select
                  value={provider}
                  onChange={(event) => setProvider(event.target.value as (typeof PROVIDERS)[number])}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label className="workbench__composer-setting">
                <span>Model</span>
                <select
                  value={model}
                  onChange={(event) => setModel(event.target.value as (typeof MODELS)[number])}
                >
                  {MODELS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
            </div>
          }
        />
      </div>
    </div>
  );
}

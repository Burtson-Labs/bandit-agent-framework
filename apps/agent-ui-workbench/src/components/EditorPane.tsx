import { useMemo, useState } from "react";
import clsx from "clsx";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import css from "highlight.js/lib/languages/css";
import banditLogoUrl from "../../../bandit-stealth/media/bandit-stealth.png";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("css", css);

interface WelcomeTabDef {
  id: string;
  label: string;
  kind: "welcome";
}

interface CodeTabDef {
  id: string;
  label: string;
  kind: "code";
  language: "typescript" | "css";
  content: string;
}

type TabDef = WelcomeTabDef | CodeTabDef;

const sampleTsx = `import { useState } from "react";
import { ChatComposer, ChatConversation } from "@burtson-labs/agent-ui";
import { mockMessages } from "./mocks/mockConversation";

export function BanditPanel() {
  const [value, setValue] = useState("");
  return (
    <div className="bandit__panel">
      <ChatConversation messages={mockMessages} />
      <ChatComposer
        value={value}
        onChange={setValue}
        onSubmit={(text) => console.info("send", text)}
        modelLabel="bandit-logic"
      />
    </div>
  );
}`;

const sampleCss = `.bandit__panel {
  display: grid;
  grid-template-rows: 1fr auto;
  height: 100%;
  background: var(--bandit-panel, #1e1e1e);
  color: var(--bandit-text-primary, #cccccc);
}

.bandit__panel :where(button, input, textarea) {
  font: inherit;
  color: inherit;
}`;

const tabs: TabDef[] = [
  { id: "welcome", label: "Welcome", kind: "welcome" },
  { id: "App.tsx", label: "App.tsx", kind: "code", language: "typescript", content: sampleTsx },
  { id: "index.css", label: "index.css", kind: "code", language: "css", content: sampleCss }
];

// Pulled from apps/bandit-stealth/package.json `contributes.keybindings`
// — the real Bandit chord set. Mac uses ⌥ (option) for the `alt` modifier.
const shortcuts: Array<{ label: string; keys: string[] }> = [
  { label: "Ask Bandit", keys: ["⇧", "⌥", "B"] },
  { label: "Toggle Ask / Agent Mode", keys: ["⇧", "⌥", "T"] },
  { label: "Switch Model", keys: ["⇧", "⌥", "M"] },
  { label: "Agent — Start Goal", keys: ["⇧", "⌥", "G"] },
  { label: "Agent — Cancel", keys: ["⇧", "⌥", "C"] },
  { label: "Open Trace Logs", keys: ["⇧", "⌘", "P", "Trace"] }
];

export function EditorPane() {
  const [active, setActive] = useState<string>("welcome");
  const activeTab = tabs.find((t) => t.id === active) ?? tabs[0];

  // Highlight once per active code tab — hljs is sync and cheap on
  // these snippets, but useMemo keeps a re-render from re-tokenizing.
  const highlightedLines = useMemo<string[] | null>(() => {
    if (activeTab.kind !== "code") {return null;}
    const html = hljs.highlight(activeTab.content, { language: activeTab.language }).value;
    return html.split("\n");
  }, [activeTab]);

  return (
    <section className="ide__editor">
      <div className="ide__tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={tab.id === active}
            className={clsx("ide__tab", tab.id === active && "ide__tab--active")}
            onClick={() => setActive(tab.id)}
          >
            <span className="ide__tab-label">{tab.label}</span>
            <span className="ide__tab-close" aria-hidden="true">×</span>
          </button>
        ))}
      </div>
      <div className="ide__editor-body">
        {activeTab.kind === "welcome" ? (
          <div className="ide__welcome">
            <img
              src={banditLogoUrl}
              alt=""
              aria-hidden="true"
              className="ide__welcome-logo"
            />
            <ul className="ide__welcome-shortcuts">
              {shortcuts.map((s) => (
                <li key={s.label} className="ide__welcome-shortcut">
                  <span className="ide__welcome-shortcut-label">{s.label}</span>
                  <span className="ide__welcome-shortcut-keys">
                    {s.keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <pre className="ide__code hljs">
            {highlightedLines?.map((line, idx) => (
              <div key={idx} className="ide__code-line">
                <span className="ide__code-gutter">{idx + 1}</span>
                <span
                  className="ide__code-content"
                  dangerouslySetInnerHTML={{ __html: line.length > 0 ? line : "&nbsp;" }}
                />
              </div>
            ))}
          </pre>
        )}
      </div>
    </section>
  );
}

import { useState } from "react";
import { ActivityBar, type ActivityKind } from "./components/ActivityBar";
import { BanditPanel } from "./components/BanditPanel";
import { EditorPane } from "./components/EditorPane";
import { ExplorerSidebar } from "./components/ExplorerSidebar";
import { ExtensionsMarketplacePanel } from "./components/ExtensionsMarketplacePanel";
import { ExtensionsSidebar } from "./components/ExtensionsSidebar";
import { SourceControlSidebar } from "./components/SourceControlSidebar";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TerminalPanel } from "./components/TerminalPanel";
import { TitleBar } from "./components/TitleBar";
import { mockTerminalLines } from "./mocks/mockTerminalLines";

/**
 * IDE-shaped workbench shell. Title bar on top, activity bar +
 * sidebar on the left, editor + terminal stacked on the right, status
 * bar at the bottom — the layout matches a generic VS Code window so
 * the embedded Bandit panel previews exactly how the extension looks
 * when shipped.
 *
 * No real extension host wiring: the sidebar renders BanditPanel
 * (mocked chat), the editor pane shows a welcome screen + a couple of
 * fake tabs, and the terminal shows hand-curated VS Code Output lines.
 * This is a design surface — flip ACTIVE_TAB or extend the mocks to
 * test component variants without booting the extension.
 */
export default function App() {
  const [activity, setActivity] = useState<ActivityKind>("bandit");

  const errors = mockTerminalLines.filter((l) => l.level === "error").length;
  const warnings = mockTerminalLines.filter((l) => l.level === "warning").length;

  return (
    <div className="ide">
      <TitleBar title="bandit-agent-framework" />
      <div className="ide__body">
        <ActivityBar active={activity} onChange={setActivity} />
        <Sidebar activity={activity}>
          {activity === "extensions" ? (
            <ExtensionsSidebar />
          ) : activity === "explorer" ? (
            <ExplorerSidebar />
          ) : activity === "git" ? (
            <SourceControlSidebar />
          ) : (
            <BanditPanel />
          )}
        </Sidebar>
        <main className="ide__main">
          {activity === "extensions" ? <ExtensionsMarketplacePanel /> : <EditorPane />}
          <TerminalPanel />
        </main>
      </div>
      <StatusBar
        branch="main"
        errors={errors}
        warnings={warnings}
        modelLabel="bandit-logic · tools"
      />
    </div>
  );
}

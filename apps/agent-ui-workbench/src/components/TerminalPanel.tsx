import { useState } from "react";
import clsx from "clsx";
import { mockTerminalLines } from "../mocks/mockTerminalLines";

type TerminalTab = "problems" | "output" | "debug" | "terminal" | "ports";

const tabs: Array<{ id: TerminalTab; label: string }> = [
  { id: "problems", label: "Problems" },
  { id: "output", label: "Output" },
  { id: "debug", label: "Debug Console" },
  { id: "terminal", label: "Terminal" },
  { id: "ports", label: "Ports" }
];

/**
 * Bottom panel matching the screenshot's terminal area: tab strip,
 * source picker, and colored log lines for the Output tab. Other
 * tabs render an idle placeholder. Output is the screenshot's view
 * so it's the default selection.
 */
export function TerminalPanel() {
  const [active, setActive] = useState<TerminalTab>("output");

  return (
    <section className="ide__terminal">
      <div className="ide__terminal-header">
        <div className="ide__terminal-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={tab.id === active}
              className={clsx("ide__terminal-tab", tab.id === active && "ide__terminal-tab--active")}
              onClick={() => setActive(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="ide__terminal-toolbar">
          <input
            className="ide__terminal-filter"
            type="search"
            placeholder="Filter"
            aria-label="Filter output"
          />
          <select className="ide__terminal-source" defaultValue="window" aria-label="Output source">
            <option value="window">Window</option>
            <option value="extension">Extension Host</option>
            <option value="bandit">Bandit Stealth</option>
          </select>
        </div>
      </div>
      <div className="ide__terminal-body">
        {active === "output" ? (
          <ol className="ide__terminal-log">
            {mockTerminalLines.map((line, idx) => (
              <li key={idx} className="ide__terminal-line">
                <span className="ide__terminal-timestamp">{line.timestamp}</span>{" "}
                <span className={clsx("ide__terminal-level", `ide__terminal-level--${line.level}`)}>
                  [{line.level}]
                </span>{" "}
                <span className="ide__terminal-source-name">[{line.source}]</span>{" "}
                <span className="ide__terminal-message">{line.message}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="ide__terminal-placeholder">
            {tabs.find((t) => t.id === active)?.label} — no entries.
          </div>
        )}
      </div>
    </section>
  );
}

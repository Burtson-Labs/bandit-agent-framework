import type { ReactNode } from "react";
import type { ActivityKind } from "./ActivityBar";

interface SidebarProps {
  activity: ActivityKind;
  children: ReactNode;
}

const headingFor: Record<ActivityKind, string> = {
  explorer: "Explorer",
  search: "Search",
  git: "Source Control",
  extensions: "Extensions",
  bandit: "Bandit Stealth"
};

/**
 * VS Code-style left sidebar that hosts whichever panel matches the
 * activity-bar selection. For Release 1 only the Bandit panel renders
 * real content; the other tabs show a placeholder so switching feels
 * responsive without us building the whole IDE.
 */
export function Sidebar({ activity, children }: SidebarProps) {
  return (
    <aside className="ide__sidebar">
      <div className="ide__sidebar-header">{headingFor[activity]}</div>
      <div className="ide__sidebar-body">
        {activity === "bandit" || activity === "extensions" || activity === "explorer" || activity === "git" ? children : (
          <div className="ide__sidebar-placeholder">
            {headingFor[activity]} panel — not wired in the workbench prototype.
          </div>
        )}
      </div>
    </aside>
  );
}

import type { ComponentType, SVGProps } from "react";
import clsx from "clsx";
import {
  DocumentDuplicateIcon,
  MagnifyingGlassIcon,
  Squares2X2Icon,
  EllipsisHorizontalIcon
} from "@heroicons/react/24/outline";
import { GitMergeIcon } from "./GitMergeIcon";
import banditIconUrl from "../../../bandit-stealth/media/bandit-stealth.png";

type ActivityKind = "explorer" | "search" | "git" | "extensions" | "bandit";

interface IconActivityItem {
  id: Exclude<ActivityKind, "bandit">;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  badge?: number;
}

const iconItems: IconActivityItem[] = [
  { id: "explorer", label: "Explorer", Icon: DocumentDuplicateIcon },
  { id: "search", label: "Search", Icon: MagnifyingGlassIcon },
  // Mocked uncommitted-change count so the source-control entry
  // shows the same VS Code "changes pending" badge the real IDE
  // does — purely cosmetic; hook a real git status here when wiring
  // the workbench against a live repo.
  { id: "git", label: "Source Control", Icon: GitMergeIcon, badge: 12 },
  { id: "extensions", label: "Extensions", Icon: Squares2X2Icon }
];

interface ActivityBarProps {
  active: ActivityKind;
  onChange: (id: ActivityKind) => void;
}

/**
 * Vertical icon strip on the far left, à la VS Code's activity bar.
 * Selection state is owned by the parent so switching tabs can also
 * swap the sidebar content. The Bandit tab uses the real
 * `apps/bandit-stealth/media/bandit-stealth.png` so the workbench
 * shows the actual marketplace icon, not a stand-in glyph.
 */
export function ActivityBar({ active, onChange }: ActivityBarProps) {
  return (
    <nav className="ide__activity">
      {iconItems.map((item) => (
        <button
          key={item.id}
          className={clsx("ide__activity-item", active === item.id && "ide__activity-item--active")}
          title={item.label}
          aria-label={item.label}
          onClick={() => onChange(item.id)}
        >
          <item.Icon className="ide__activity-icon" aria-hidden="true" />
          {typeof item.badge === "number" && item.badge > 0 && (
            <span className="ide__activity-badge" aria-label={`${item.badge} pending changes`}>
              {item.badge > 99 ? "99+" : item.badge}
            </span>
          )}
        </button>
      ))}
      <button
        className={clsx("ide__activity-item", active === "bandit" && "ide__activity-item--active")}
        title="Bandit Stealth"
        aria-label="Bandit Stealth"
        onClick={() => onChange("bandit")}
      >
        <img src={banditIconUrl} alt="" className="ide__activity-icon ide__activity-icon--logo" />
      </button>
      <button className="ide__activity-item ide__activity-item--more" title="More" aria-label="More options">
        <EllipsisHorizontalIcon className="ide__activity-icon" aria-hidden="true" />
      </button>
    </nav>
  );
}

export type { ActivityKind };

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  ChevronDownIcon,
  WrenchScrewdriverIcon,
  DocumentTextIcon,
  ListBulletIcon,
  PencilSquareIcon,
  CommandLineIcon,
  GlobeAltIcon,
  ArrowDownTrayIcon,
  ChatBubbleLeftEllipsisIcon,
  CheckCircleIcon,
  FolderOpenIcon
} from "@heroicons/react/24/outline";

export type ToolId =
  | "read_file"
  | "list_files"
  | "write_file"
  | "run_terminal"
  | "web_search"
  | "web_fetch"
  | "ask_user"
  | "todo_list"
  | "find_directory";

interface ToolDef {
  id: ToolId;
  label: string;
  description: string;
  Icon: typeof DocumentTextIcon;
}

const TOOLS: ToolDef[] = [
  { id: "read_file", label: "read_file", description: "Read a file into the conversation as syntax-highlighted preview.", Icon: DocumentTextIcon },
  { id: "list_files", label: "list_files", description: "Glob a directory and surface the match list.", Icon: ListBulletIcon },
  { id: "write_file", label: "write_file", description: "Propose a file change — surfaces a PermissionCard with a real diff.", Icon: PencilSquareIcon },
  { id: "run_terminal", label: "run_terminal", description: "Run a shell command — renders the command + stdout + exit code.", Icon: CommandLineIcon },
  { id: "web_search", label: "web_search", description: "Tavily-style ranked snippets — cards in the chat scroll.", Icon: GlobeAltIcon },
  { id: "web_fetch", label: "web_fetch", description: "Fetch + summarize a single URL.", Icon: ArrowDownTrayIcon },
  { id: "ask_user", label: "ask_user", description: "Inline question card with options + freeform fallback.", Icon: ChatBubbleLeftEllipsisIcon },
  { id: "todo_list", label: "todo_list", description: "Goal + ordered task list (uses agent-ui's TaskList).", Icon: CheckCircleIcon },
  { id: "find_directory", label: "find_directory", description: "Search common repo roots — returns candidate paths.", Icon: FolderOpenIcon }
];

interface ToolPaletteProps {
  onInsert: (toolId: ToolId) => void;
}

/**
 * Compact "Insert tool" affordance docked above the composer. The
 * trigger pill opens a popover listing every tool the workbench can
 * mock. Each row labels the tool name in mono + an intent string —
 * the goal is to make ad-hoc styling iteration fast: pick a tool, see
 * it in the chat, tweak the renderer, refresh, see it again.
 *
 * No keyboard navigation yet — single-pointer use is the design
 * surface for now; if this becomes a daily-driver we can layer in
 * roving tabindex + Escape-to-close.
 */
export function ToolPalette({ onInsert }: ToolPaletteProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Click-outside dismiss — guard with the open flag so we don't
  // burn a listener while collapsed.
  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleInsert = useCallback(
    (id: ToolId) => {
      onInsert(id);
      setOpen(false);
    },
    [onInsert]
  );

  return (
    <div className="tool-palette" ref={wrapperRef}>
      <button
        type="button"
        className={clsx("tool-palette__trigger", open && "is-open")}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <WrenchScrewdriverIcon aria-hidden="true" />
        <span>Insert tool</span>
        <ChevronDownIcon aria-hidden="true" className="tool-palette__chevron" />
      </button>
      <p className="tool-palette__hint">
        Workbench-only — drop any tool into the chat so you can style its render in isolation.
      </p>
      {open && (
        <div className="tool-palette__menu" role="menu">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              role="menuitem"
              className="tool-palette__item"
              onClick={() => handleInsert(tool.id)}
            >
              <tool.Icon aria-hidden="true" className="tool-palette__item-icon" />
              <div>
                <div className="tool-palette__item-name">{tool.label}</div>
                <div className="tool-palette__item-desc">{tool.description}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

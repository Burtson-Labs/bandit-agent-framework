import { useState } from "react";
import {
  ChevronRightIcon,
  ChevronDownIcon
} from "@heroicons/react/24/outline";

type FileNode = {
  name: string;
  kind: "file";
  /** Single-letter language badge used to style the file icon. */
  lang?: "ts" | "tsx" | "json" | "md" | "css" | "html" | "yml" | "ico" | "img";
};

type DirNode = {
  name: string;
  kind: "dir";
  children: TreeNode[];
  /** Defaults to closed unless explicitly set. */
  openByDefault?: boolean;
};

type TreeNode = FileNode | DirNode;

// Verisimilitude-first tree modeled on the workbench's actual on-disk
// layout (apps/agent-ui-workbench/). Mirrors the directories a reader
// would actually find if they cracked open the repo — gives the
// Explorer a real-feel without wiring a filesystem walker.
const tree: TreeNode[] = [
  {
    name: "apps/agent-ui-workbench",
    kind: "dir",
    openByDefault: true,
    children: [
      {
        name: "src",
        kind: "dir",
        openByDefault: true,
        children: [
          {
            name: "components",
            kind: "dir",
            openByDefault: true,
            children: [
              { name: "ActivityBar.tsx", kind: "file", lang: "tsx" },
              { name: "BanditPanel.tsx", kind: "file", lang: "tsx" },
              { name: "EditorPane.tsx", kind: "file", lang: "tsx" },
              { name: "ExplorerSidebar.tsx", kind: "file", lang: "tsx" },
              { name: "ExtensionsMarketplacePanel.tsx", kind: "file", lang: "tsx" },
              { name: "ExtensionsSidebar.tsx", kind: "file", lang: "tsx" },
              { name: "Sidebar.tsx", kind: "file", lang: "tsx" },
              { name: "StatusBar.tsx", kind: "file", lang: "tsx" },
              { name: "TerminalPanel.tsx", kind: "file", lang: "tsx" },
              { name: "TitleBar.tsx", kind: "file", lang: "tsx" },
              { name: "WorkbenchSettingsOverlay.tsx", kind: "file", lang: "tsx" }
            ]
          },
          {
            name: "marketplace",
            kind: "dir",
            children: [
              { name: "banditMeta.ts", kind: "file", lang: "ts" },
              { name: "vite-globals.d.ts", kind: "file", lang: "ts" }
            ]
          },
          {
            name: "markdown",
            kind: "dir",
            children: [{ name: "banditMarkdown.ts", kind: "file", lang: "ts" }]
          },
          {
            name: "mocks",
            kind: "dir",
            children: [
              { name: "mockConversation.ts", kind: "file", lang: "ts" },
              { name: "mockTerminalLines.ts", kind: "file", lang: "ts" }
            ]
          },
          { name: "App.tsx", kind: "file", lang: "tsx" },
          { name: "index.css", kind: "file", lang: "css" },
          { name: "main.tsx", kind: "file", lang: "tsx" }
        ]
      },
      { name: "index.html", kind: "file", lang: "html" },
      { name: "package.json", kind: "file", lang: "json" },
      { name: "README.md", kind: "file", lang: "md" },
      { name: "tsconfig.app.json", kind: "file", lang: "json" },
      { name: "tsconfig.json", kind: "file", lang: "json" },
      { name: "tsconfig.node.json", kind: "file", lang: "json" },
      { name: "vite.config.ts", kind: "file", lang: "ts" }
    ]
  },
  {
    name: "apps/bandit-stealth",
    kind: "dir",
    children: [
      {
        name: "webview",
        kind: "dir",
        children: [
          { name: "src/", kind: "file", lang: "ts" },
          { name: "package.json", kind: "file", lang: "json" }
        ]
      },
      { name: "media/", kind: "file", lang: "img" },
      { name: "package.json", kind: "file", lang: "json" },
      { name: "README.md", kind: "file", lang: "md" }
    ]
  },
  {
    name: "packages/agent-ui",
    kind: "dir",
    children: [
      { name: "src/components/", kind: "file", lang: "tsx" },
      { name: "src/theme/", kind: "file", lang: "ts" },
      { name: "package.json", kind: "file", lang: "json" }
    ]
  },
  { name: "package.json", kind: "file", lang: "json" },
  { name: "pnpm-workspace.yaml", kind: "file", lang: "yml" },
  { name: "turbo.json", kind: "file", lang: "json" },
  { name: "tsconfig.base.json", kind: "file", lang: "json" },
  { name: "README.md", kind: "file", lang: "md" },
  { name: ".gitignore", kind: "file" }
];

const LANG_BADGE_COLOR: Record<string, string> = {
  ts: "#3178c6",
  tsx: "#3178c6",
  json: "#cf8a16",
  md: "#858585",
  css: "#3490dc",
  html: "#e44d26",
  yml: "#cc1018",
  img: "#a463bf",
  ico: "#a463bf"
};

const FileIcon = ({ lang }: { lang?: FileNode["lang"] }) => {
  const color = lang ? LANG_BADGE_COLOR[lang] ?? "#858585" : "#858585";
  return (
    <span className="ide__file-icon" aria-hidden="true" style={{ color }}>
      {lang ? lang.toUpperCase() : "•"}
    </span>
  );
};

const Row = ({
  node,
  depth,
  active,
  onPick
}: {
  node: TreeNode;
  depth: number;
  active: string;
  onPick: (path: string) => void;
}) => {
  const initial = node.kind === "dir" && node.openByDefault === true;
  const [open, setOpen] = useState<boolean>(initial);
  if (node.kind === "dir") {
    return (
      <>
        <button
          type="button"
          className="ide__file-row ide__file-row--dir"
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <ChevronDownIcon className="ide__file-chevron" aria-hidden="true" />
          ) : (
            <ChevronRightIcon className="ide__file-chevron" aria-hidden="true" />
          )}
          <span className="ide__file-name">{node.name}</span>
        </button>
        {open &&
          node.children.map((child) => (
            <Row
              key={`${node.name}/${child.name}`}
              node={child}
              depth={depth + 1}
              active={active}
              onPick={onPick}
            />
          ))}
      </>
    );
  }
  const isActive = active === node.name;
  return (
    <button
      type="button"
      className={`ide__file-row ide__file-row--file${isActive ? " is-active" : ""}`}
      style={{ paddingLeft: 6 + depth * 12 }}
      onClick={() => onPick(node.name)}
    >
      <FileIcon lang={node.lang} />
      <span className="ide__file-name">{node.name}</span>
    </button>
  );
};

/**
 * VS Code-style file tree pinned to the Explorer sidebar. Hand-rolled
 * tree state per directory (no recursive memoization needed — the
 * mock has ~30 nodes). Clicking a file is a no-op visually beyond the
 * active highlight; the editor pane keeps its sample tabs because
 * wiring real file content would require a server.
 */
export function ExplorerSidebar() {
  const [active, setActive] = useState<string>("App.tsx");
  return (
    <div className="ide__explorer">
      <div className="ide__explorer-eyebrow">BANDIT-AGENT-FRAMEWORK</div>
      <div className="ide__explorer-tree" role="tree">
        {tree.map((n) => (
          <Row key={n.name} node={n} depth={0} active={active} onPick={setActive} />
        ))}
      </div>
    </div>
  );
}

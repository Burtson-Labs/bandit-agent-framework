import { useEffect, useRef, useState, type JSX } from "react";
import clsx from "clsx";

/**
 * Permission payload emitted by the extension when a tool call needs user
 * approval (write_file, run_command, etc). The webview extracts this from a
 * `bandit-permission` fenced block in the assistant message and renders the
 * interactive card in-place. Once the user picks, we post back and flip the
 * card into a resolved state — so the card is authoritative UI rather than
 * the extension's chat-message text copy (which is for history).
 */
export interface BanditPermissionPayload {
  type: "bandit:permission";
  id: string;
  tool: string;
  primary: string;
  description: string;
  /** Short risk summary from the host permission gate. */
  risk?: string;
  bodyPreview?: string;
  /**
   * Optional advisory the extension surfaces on the card BEFORE the user
   * decides. Used for the "creating a new file at X — did you mean to
   * edit an existing one?" warning when write_file targets a path that
   * doesn't yet exist and the user's prompt implied editing.
   */
  warning?: string;
  /**
   * +/- line counts extracted from bodyPreview so we can show a compact
   * "Modified · +12 -3" summary instead of the full diff. When omitted,
   * the card falls back to rendering bodyPreview expanded (back-compat).
   */
  diffStats?: { added: number; removed: number };
  /**
   * Raw command text for run_command prompts — the full shell string the
   * agent wants to execute (e.g. `grep -rE "pattern" ~/path | head -40`).
   * Shown in a monospace block above the buttons so the user can audit
   * the command verbatim before approving. Claude Code shows the whole
   * command; we were only showing the tool name + first param, which hid
   * pipes / flags / second args. Undefined for non-command tools.
   */
  command?: string;
  /**
   * Formatted key=value param dump for non-command tools. When present
   * and `bodyPreview` is empty, we render this in the same position as
   * `command` so the user can see exactly what'll be invoked
   * (apply_edit find/replace, git_checkout branch name, etc).
   */
  paramsPreview?: string;
}

export type PermissionChoice = "once" | "session" | "save" | "deny";

export interface PermissionCardProps {
  payload: BanditPermissionPayload;
  /**
   * Fires once per card. `notes` is populated only when the user picked
   * "Deny with notes" and typed follow-up guidance — the extension pipes
   * that back to the model as part of the denial reason so the agent
   * adjusts its plan rather than just seeing "blocked."
   */
  onChoice: (id: string, choice: PermissionChoice, notes?: string) => void;
}

/**
 * Vertical-stacked buttons with numbered keyboard shortcuts. Order
 * matches Claude Code's convention (Yes options first, No last) but
 * we keep all four of our scopes because "session" and "save" are
 * distinct use cases for Bandit — one is per-window, the other
 * persists across restarts via .bandit/settings.json.
 */
const CHOICE_ORDER: PermissionChoice[] = ["once", "session", "save", "deny"];
const CHOICE_LABELS: Record<PermissionChoice, { label: string; hint: string; key: string }> = {
  once: { label: "Allow once", hint: "Run this single tool call", key: "1" },
  session: { label: "Allow session", hint: "Allow this tool until you close the window", key: "2" },
  save: { label: "Always for target", hint: "Save this target to .bandit/settings.json", key: "3" },
  deny: { label: "Deny", hint: "Abort the tool call", key: "4" }
};

export const PermissionCard = ({ payload, onChoice }: PermissionCardProps): JSX.Element => {
  const [resolved, setResolved] = useState<PermissionChoice | null>(null);
  const [resolvedNotes, setResolvedNotes] = useState<string | undefined>(undefined);
  const [notesDraft, setNotesDraft] = useState<string>("");
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Auto-focus the card so the numbered keyboard shortcuts work without
  // the user having to click first. Matches Claude's "press 1/2/3 to
  // pick, Esc to cancel" muscle memory out of the box.
  useEffect(() => {
    if (!resolved) {cardRef.current?.focus();}
  }, [resolved]);

  const pick = (choice: PermissionChoice, notes?: string): void => {
    if (resolved) {return;}
    const trimmed = notes?.trim() || undefined;
    setResolved(choice);
    setResolvedNotes(trimmed);
    onChoice(payload.id, choice, trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (resolved) {return;}
    // Number keys map to the choice order. 1/2/3/4 = once/session/save/deny.
    // Only fire when the focus target isn't a text input — otherwise
    // typing "1" in the notes textarea would accidentally approve.
    const target = e.target as HTMLElement | null;
    const isInput = target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");
    if (!isInput) {
      if (e.key === "1") { e.preventDefault(); pick("once"); return; }
      if (e.key === "2") { e.preventDefault(); pick("session"); return; }
      if (e.key === "3") { e.preventDefault(); pick("save"); return; }
      if (e.key === "4") { e.preventDefault(); pick("deny", notesDraft); return; }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      pick("deny", notesDraft);
    }
  };

  const handleNotesKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Cmd/Ctrl+Enter from the notes input submits a denial + the text.
    // Plain Enter adds a newline so multi-line guidance is possible.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      pick("deny", notesDraft);
    }
  };

  // Body preview selection: prefer the rich content the extension
  // pre-computed for this specific tool type. `command` → raw shell
  // string for run_command. `paramsPreview` → key=value dump for
  // other tools (apply_edit, git_checkout, etc). `bodyPreview` with
  // diff stats → write_file / apply_edit changes. Fallback: show
  // nothing (the title line already mentions the tool + primary arg).
  const hasCommand = typeof payload.command === "string" && payload.command.trim().length > 0;
  const hasParams = !hasCommand && typeof payload.paramsPreview === "string" && payload.paramsPreview.trim().length > 0;
  const hasDiff = !hasCommand && !hasParams && typeof payload.bodyPreview === "string" && payload.bodyPreview.trim().length > 0;

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      className={clsx("permission-card", resolved && "is-resolved", resolved === "deny" && "is-denied")}
      role="group"
      aria-label={`Permission prompt for ${payload.tool}`}
      onKeyDown={handleKeyDown}
    >
      <div className="permission-card__header">
        <div className="permission-card__icon" aria-hidden="true">!</div>
        <div className="permission-card__title">
          <div className="permission-card__tool">
            Allow this <code>{payload.tool}</code>?
          </div>
        </div>
      </div>

      {hasCommand && (
        <pre className="permission-card__command" aria-label="Command to run">
          <code>{payload.command}</code>
        </pre>
      )}
      {hasParams && (
        <pre className="permission-card__command" aria-label="Tool parameters">
          <code>{payload.paramsPreview}</code>
        </pre>
      )}

      {payload.description && payload.description !== `${payload.tool} ${payload.primary}`.trim() && (
        <div className="permission-card__desc">{payload.description}</div>
      )}

      {payload.risk && (
        <div className="permission-card__risk">
          <span className="permission-card__risk-label">Risk</span>
          <span>{payload.risk}</span>
        </div>
      )}

      {payload.warning && (
        <div className="permission-card__warning" role="alert">
          <span className="permission-card__warning-icon" aria-hidden="true">⚠</span>
          <span>{payload.warning}</span>
        </div>
      )}

      {hasDiff && (
        <CollapsibleDiff preview={payload.bodyPreview!} stats={payload.diffStats} />
      )}

      <div className="permission-card__choices" role="radiogroup" aria-label="Approval choices">
        {CHOICE_ORDER.map((choice) => (
          <button
            key={choice}
            type="button"
            className={clsx(
              "permission-card__choice",
              `permission-card__choice--${choice}`,
              resolved === choice && "is-selected"
            )}
            disabled={resolved !== null}
            onClick={() => pick(choice, choice === "deny" ? notesDraft : undefined)}
            title={CHOICE_LABELS[choice].hint}
            role="radio"
            aria-checked={resolved === choice}
          >
            <span className="permission-card__choice-key" aria-hidden="true">
              {CHOICE_LABELS[choice].key}
            </span>
            <span className="permission-card__choice-label">
              {CHOICE_LABELS[choice].label}
            </span>
          </button>
        ))}
      </div>

      {!resolved && (
        <div className="permission-card__notes">
          <textarea
            className="permission-card__notes-input"
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            onKeyDown={handleNotesKeyDown}
            placeholder="Tell Bandit what to do instead (optional)"
            rows={2}
          />
          <span className="permission-card__notes-hint">
            Esc to cancel · Cmd+Enter to deny with notes
          </span>
        </div>
      )}

      {resolved && (
        <div className="permission-card__resolved" role="status">
          {resolved === "deny"
            ? (resolvedNotes ? `Denied · "${resolvedNotes}"` : "Denied")
            : resolved === "save" ? "Allowed (saved to .bandit/settings.json)"
            : resolved === "session" ? "Allowed for this session"
            : "Allowed once"}
        </div>
      )}
    </div>
  );
};

/**
 * Compact diff viewer: collapsed by default showing a "Modified · +N -M"
 * summary with the first changed line as a preview. Click to expand and
 * see the full diff. Matches the visual language of Claude's
 * write-permission card so users get a consistent, low-noise review
 * surface instead of a 2kb pre/code wall on every permission prompt.
 */
function CollapsibleDiff({
  preview,
  stats
}: {
  preview: string;
  stats?: { added: number; removed: number };
}): JSX.Element {
  const [expanded, setExpanded] = useState<boolean>(false);
  const { added, removed, firstChange } = useDiffSummary(preview, stats);
  return (
    <div className={clsx("permission-card__diff", expanded && "is-expanded")}>
      <button
        type="button"
        className="permission-card__diff-summary"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse diff" : "Expand diff"}
      >
        <span className="permission-card__diff-label">Modified</span>
        {(added > 0 || removed > 0) && (
          <span className="permission-card__diff-stats">
            {added > 0 && <span className="permission-card__diff-added">+{added}</span>}
            {removed > 0 && <span className="permission-card__diff-removed">-{removed}</span>}
          </span>
        )}
        {!expanded && firstChange && (
          <span className="permission-card__diff-first-line" title={firstChange}>
            {firstChange}
          </span>
        )}
        <span className="permission-card__diff-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <pre className="permission-card__preview">
          <code>{preview}</code>
        </pre>
      )}
    </div>
  );
}

/**
 * Parse a diff-like preview (our bodyPreview is produced by the extension
 * with `+` / `-` / ` ` line prefixes) into a headline: +added / -removed
 * and the first changed line (trimmed) for the collapsed view. We cap
 * counts to 999 so an absurd rewrite doesn't overflow the pill.
 */
function useDiffSummary(
  preview: string,
  stats?: { added: number; removed: number }
): { added: number; removed: number; firstChange: string } {
  if (stats) {
    const firstChange = firstChangedLine(preview);
    return {
      added: Math.min(stats.added, 999),
      removed: Math.min(stats.removed, 999),
      firstChange
    };
  }
  let added = 0;
  let removed = 0;
  for (const line of preview.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) {added++;}
    else if (line.startsWith("-") && !line.startsWith("---")) {removed++;}
  }
  return {
    added: Math.min(added, 999),
    removed: Math.min(removed, 999),
    firstChange: firstChangedLine(preview)
  };
}

function firstChangedLine(preview: string): string {
  for (const raw of preview.split(/\r?\n/)) {
    const trimmed = raw.trimEnd();
    if ((trimmed.startsWith("+") && !trimmed.startsWith("+++")) ||
        (trimmed.startsWith("-") && !trimmed.startsWith("---"))) {
      const body = trimmed.slice(1).trim();
      if (body) {return body.length > 80 ? body.slice(0, 77) + "…" : body;}
    }
  }
  return "";
}

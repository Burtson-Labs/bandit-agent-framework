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
  /**
   * Risk tier from the shared classifier: `routine` | `elevated` | `critical`.
   * Drives the card's visual weight — users approve dozens of these a session,
   * and if a delete renders identically to a file read the card stops being
   * read at all.
   */
  tier?: string;
  /**
   * What each grant scope would actually authorize, keyed by choice. Rendered
   * as the button's hint so the user reads the blast radius before clicking.
   * Generated host-side by `grantRuleFor` — the same call that computes the
   * rule that gets stored, so the card cannot promise one scope and save
   * another. Falls back to the static hints below when absent.
   */
  scopeHints?: Record<string, string>;
  /**
   * True when a saved allow rule already covered this call but the
   * critical-tier floor overrode it. Without saying so, the user sees a prompt
   * for something they believe they already approved and concludes the grant
   * is broken.
   */
  flooredByRisk?: boolean;
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
  /**
   * Host-owned decision state. Omit it and the card resolves itself the
   * moment the user picks (the original behaviour). Pass it and the card
   * only reports what the host says: `submitting` while the decision is in
   * flight, `resolved` once the host has applied it, `error` to let the user
   * retry, `expired` when the agent is no longer waiting.
   */
  status?: PermissionCardStatus;
}

export type PermissionCardStatus =
  | { state: "pending" }
  | { state: "submitting"; choice: PermissionChoice }
  | {
      state: "resolved";
      choice: PermissionChoice;
      notes?: string;
      /** Where the host stored an "Always allow" rule. The card never claims
       *  a rule was saved unless the host says where. */
      savedTo?: string;
    }
  | { state: "error"; message: string }
  | { state: "expired"; reason?: string };

/**
 * Vertical-stacked buttons with numbered keyboard shortcuts. Order
 * matches Claude Code's convention (Yes options first, No last) but
 * we keep all four of our scopes because "session" and "save" are
 * distinct use cases for Bandit — one is per-window, the other
 * persists across restarts via .bandit/settings.json.
 */
const CHOICE_ORDER: PermissionChoice[] = ["once", "session", "save", "deny"];
// Fallback hints. When the host supplies `scopeHints` these are replaced with
// the real blast radius of the rule that would be stored — "Always for target"
// was actively misleading, since the stored rule was the binary, not the target.
const CHOICE_LABELS: Record<PermissionChoice, { label: string; hint: string; key: string }> = {
  once: { label: "Allow once", hint: "Run this single tool call", key: "1" },
  session: { label: "Allow session", hint: "Allow calls like this until you close the window", key: "2" },
  save: { label: "Always allow", hint: "Save the rule to .bandit/settings.json", key: "3" },
  deny: { label: "Deny", hint: "Abort the tool call", key: "4" }
};

export const PermissionCard = ({ payload, onChoice, status }: PermissionCardProps): JSX.Element => {
  const [localResolved, setLocalResolved] = useState<{ choice: PermissionChoice; notes?: string } | null>(null);
  const [notesDraft, setNotesDraft] = useState<string>("");
  const cardRef = useRef<HTMLDivElement | null>(null);
  // The id this card last reported a decision for. A ref, not state, so two
  // events in the same tick (double click, "1" then Esc) can't both get past
  // the check before a re-render. Cleared only when the host reports an error
  // (the user may retry) or hands the card a different request.
  const firedFor = useRef<string | null>(null);
  const [trackedId, setTrackedId] = useState(payload.id);
  if (trackedId !== payload.id) {
    setTrackedId(payload.id);
    setLocalResolved(null);
    setNotesDraft("");
  }
  const statusState = status?.state;
  useEffect(() => {
    if (statusState === "error") {firedFor.current = null;}
  }, [statusState]);

  const controlled = status !== undefined;
  const view: PermissionCardStatus = controlled
    ? status
    : localResolved
      ? { state: "resolved", ...localResolved }
      : { state: "pending" };
  const actionable = view.state === "pending" || view.state === "error";
  const chosen = view.state === "submitting" || view.state === "resolved" ? view.choice : null;

  // Auto-focus the card so the numbered keyboard shortcuts work without
  // the user having to click first. Matches Claude's "press 1/2/3 to
  // pick, Esc to cancel" muscle memory out of the box.
  useEffect(() => {
    if (view.state === "pending") {cardRef.current?.focus();}
  }, [view.state, payload.id]);

  const pick = (choice: PermissionChoice, notes?: string): void => {
    if (!actionable || firedFor.current === payload.id) {return;}
    firedFor.current = payload.id;
    const trimmed = notes?.trim() || undefined;
    if (!controlled) {setLocalResolved({ choice, notes: trimmed });}
    onChoice(payload.id, choice, trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!actionable) {return;}
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
  // diff stats → write_file / apply_edit changes.
  //
  // Fallback: show `primary` in the same monospace block. Remote /
  // mobile mirrors sometimes only carry `primary` (full argv for
  // run_command) and omit `command` — without this fallback the card
  // was literally "Allow this run_command?" with no details, so users
  // approved blind.
  const hasCommand = typeof payload.command === "string" && payload.command.trim().length > 0;
  const hasParams = !hasCommand && typeof payload.paramsPreview === "string" && payload.paramsPreview.trim().length > 0;
  const primaryDetail = typeof payload.primary === "string" ? payload.primary.trim() : "";
  const hasPrimaryFallback = !hasCommand && !hasParams && primaryDetail.length > 0;
  const detailText = hasCommand
    ? payload.command!.trim()
    : hasParams
      ? payload.paramsPreview!.trim()
      : hasPrimaryFallback
        ? primaryDetail
        : "";
  const detailLabel = hasCommand || (hasPrimaryFallback && /^(run_command|run_shell|exec|bash|shell)/i.test(payload.tool))
    ? "Command to run"
    : "Tool details";
  const hasDiff = !detailText && typeof payload.bodyPreview === "string" && payload.bodyPreview.trim().length > 0;

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      className={clsx(
        "permission-card",
        `is-${view.state}`,
        view.state === "resolved" && "is-resolved",
        chosen === "deny" && "is-denied"
      )}
      role="group"
      aria-label={`Permission prompt for ${payload.tool}`}
      aria-busy={view.state === "submitting" || undefined}
      aria-keyshortcuts={actionable ? "1 2 3 4 Escape" : undefined}
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

      {detailText && (
        <pre className="permission-card__command" aria-label={detailLabel}>
          <code>{detailText}</code>
        </pre>
      )}

      {payload.description && payload.description !== `${payload.tool} ${payload.primary}`.trim() && (
        <div className="permission-card__desc">{payload.description}</div>
      )}

      {payload.risk && (
        <div className={clsx("permission-card__risk", payload.tier && `permission-card__risk--${payload.tier}`)}>
          <span className="permission-card__risk-label">
            {payload.tier === "critical" ? "Destructive" : "Risk"}
          </span>
          <span>{payload.risk}</span>
        </div>
      )}

      {/* A saved rule covered this call and the destructive-action floor
          overrode it. Saying so is the difference between "the product is
          protecting me" and "my allow rule is broken". */}
      {payload.flooredByRisk && (
        <div className="permission-card__warning" role="alert">
          <span className="permission-card__warning-icon" aria-hidden="true">⚠</span>
          <span>
            An existing allow rule covers this call, but destructive actions always ask.
          </span>
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

      {/* Each button acts immediately, so these are buttons, not radios: a
          radio announces "1 of 4, not checked" and implies a later submit. */}
      <div className="permission-card__choices" role="group" aria-label="Approval choices">
        {CHOICE_ORDER.map((choice) => (
          <button
            key={choice}
            type="button"
            className={clsx(
              "permission-card__choice",
              `permission-card__choice--${choice}`,
              chosen === choice && "is-selected"
            )}
            disabled={!actionable}
            onClick={() => pick(choice, choice === "deny" ? notesDraft : undefined)}
            title={payload.scopeHints?.[choice] ?? CHOICE_LABELS[choice].hint}
            aria-keyshortcuts={CHOICE_LABELS[choice].key}
            aria-pressed={chosen === choice}
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

      {/* The blast radius of the highlighted grant, in the open rather than in
          a tooltip. This line is the fix for "the card said one thing and saved
          another" — it is generated from the same call that produces the rule
          the host stores. */}
      {actionable && payload.scopeHints && (
        <div className="permission-card__scopes">
          {CHOICE_ORDER.filter((ch) => ch !== "deny" && payload.scopeHints?.[ch]).map((ch) => (
            <div key={ch} className="permission-card__scope">
              <span className="permission-card__scope-key">{CHOICE_LABELS[ch].key}</span>
              <span className="permission-card__scope-text">{payload.scopeHints?.[ch]}</span>
            </div>
          ))}
        </div>
      )}

      {actionable && (
        <div className="permission-card__notes">
          <textarea
            className="permission-card__notes-input"
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            onKeyDown={handleNotesKeyDown}
            placeholder="Tell Bandit what to do instead (optional)"
            aria-label="Notes for Bandit if you deny"
            rows={2}
          />
          <span className="permission-card__notes-hint">
            Esc to cancel · Cmd+Enter to deny with notes
          </span>
        </div>
      )}

      {view.state === "error" && (
        <div className="permission-card__error" role="alert">
          {view.message || "Bandit didn't receive your decision."} Choose again to retry.
        </div>
      )}

      {view.state !== "pending" && view.state !== "error" && (
        <div className="permission-card__resolved" role="status">
          {describeOutcome(view, controlled)}
        </div>
      )}
    </div>
  );
};

const ALLOWED_TEXT: Record<Exclude<PermissionChoice, "deny">, string> = {
  once: "Allowed once",
  session: "Allowed for this session",
  save: "Always allowed"
};

/** Status line for a card that is no longer waiting on the user. */
export function describeOutcome(view: PermissionCardStatus, hostConfirmed: boolean): string {
  switch (view.state) {
    case "submitting":
      return view.choice === "deny" ? "Sending denial…" : "Sending approval…";
    case "expired":
      return view.reason ? `Expired · ${view.reason}` : "Expired · Bandit is no longer waiting for this decision";
    case "resolved": {
      if (view.choice === "deny") {return view.notes ? `Denied · "${view.notes}"` : "Denied";}
      if (view.choice === "save") {
        if (view.savedTo) {return `Always allowed (saved to ${view.savedTo})`;}
        // Uncontrolled cards keep their original wording; a controlled card
        // only names a location the host confirmed.
        return hostConfirmed ? ALLOWED_TEXT.save : "Allowed (saved to .bandit/settings.json)";
      }
      return ALLOWED_TEXT[view.choice];
    }
    default:
      return "";
  }
}

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

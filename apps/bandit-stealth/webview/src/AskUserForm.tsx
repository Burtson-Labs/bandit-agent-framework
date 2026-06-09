import { useEffect, useRef, useState, type JSX } from "react";
import { QuestionMarkCircleIcon, CheckCircleIcon } from "@heroicons/react/24/outline";

/**
 * Webview host of agent-core's `ask_user` tool — the extension's counterpart
 * to the CLI's ink form. The provider posts a `userInputRequest`; this card
 * renders the questions and posts `userInputResponse` back on submit.
 *
 * Layout matches the CLI: a single question shows inline; multiple questions
 * render as TABS (one question per tab) plus a final Submit tab that reviews
 * the answers. Radio semantics also match — each question defaults to its
 * first option (so a recommended option listed first is pre-selected), and a
 * free-text answer is recorded only once typed.
 *
 * Colors use the webview's own `--bandit-*` theme tokens (not raw VS Code
 * vars) so the card's accent matches the composer/send button across themes.
 */

export interface AskUserQuestionPayload {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  allowFreeform?: boolean;
}

export interface AskUserFormProps {
  id: string;
  questions: AskUserQuestionPayload[];
  onSubmit: (id: string, answers: Record<string, string>, cancelled?: boolean) => void;
}

// Sentinel marking the "Other / type your own" choice for a question.
const CUSTOM = " ask-user-custom";

// Bandit theme tokens (match the composer/send button + the rest of the UI).
const ACCENT = "rgba(var(--bandit-accent-rgb), 0.95)";
const ON_ACCENT = "var(--bandit-button-contrast)";
const BORDER = "var(--bandit-border)";
const TEXT = "var(--bandit-text-primary)";
const MUTED = "var(--bandit-text-muted)";

/** Theme-driven circular radio — the webview's global input styling renders
 *  native radios as a filled square, so we hide the native control and draw
 *  our own dot. The (visually hidden) input keeps clicks + keyboard + a11y. */
function Radio({
  name,
  checked,
  disabled,
  onChange
}: {
  name: string;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}): JSX.Element {
  return (
    <span style={{ position: "relative", display: "inline-flex", width: 16, height: 16, flex: "0 0 auto" }}>
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        style={{ position: "absolute", inset: 0, width: 16, height: 16, margin: 0, opacity: 0, cursor: disabled ? "default" : "pointer" }}
      />
      <span
        aria-hidden="true"
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          boxSizing: "border-box",
          border: `1px solid ${checked ? ACCENT : BORDER}`,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center"
        }}
      >
        {checked && <span style={{ width: 8, height: 8, borderRadius: "50%", background: ACCENT }} />}
      </span>
    </span>
  );
}

export const AskUserForm = ({ id, questions, onSubmit }: AskUserFormProps): JSX.Element => {
  const multi = questions.length > 1;
  const submitTab = questions.length; // index of the Submit tab (multi only)

  const [selected, setSelected] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of questions) {
      const opts = q.options ?? [];
      if (opts.length > 0) {init[q.id] = opts[0].label;}
      else if (q.allowFreeform !== false) {init[q.id] = CUSTOM;}
    }
    return init;
  });
  const [customText, setCustomText] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState(0);
  const [submitted, setSubmitted] = useState(false);

  const answerFor = (q: AskUserQuestionPayload): string => {
    const sel = selected[q.id];
    if (sel === CUSTOM) {return (customText[q.id] ?? "").trim();}
    return sel ?? "";
  };
  const isAnswered = (q: AskUserQuestionPayload): boolean => answerFor(q) !== "";

  const submit = (): void => {
    if (submitted) {return;}
    setSubmitted(true);
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const a = answerFor(q);
      if (a) {answers[q.id] = a;}
    }
    onSubmit(id, answers);
  };
  const cancel = (): void => {
    if (submitted) {return;}
    setSubmitted(true);
    onSubmit(id, {}, true);
  };

  const onSubmitTab = multi && activeTab === submitTab;

  // Auto-focus so Enter/Esc work without clicking first (matches the
  // permission card's muscle memory).
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (submitted) {return;}
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    // Enter submits; on a multi-question form it advances through the tabs
    // and submits from the last one (Submit tab) — same flow as the CLI.
    // Let a focused button handle its own Enter so we don't double-fire.
    if (e.key === "Enter" && !e.shiftKey) {
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === "BUTTON") {return;}
      e.preventDefault();
      if (multi && !onSubmitTab) {setActiveTab((t) => Math.min(submitTab, t + 1));}
      else {submit();}
    }
  };

  const primaryBtnStyle: React.CSSProperties = {
    padding: "5px 14px",
    background: ACCENT,
    color: ON_ACCENT,
    border: "none",
    borderRadius: 4,
    fontWeight: 600,
    cursor: submitted ? "default" : "pointer"
  };

  const renderQuestion = (q: AskUserQuestionPayload): JSX.Element => {
    const opts = q.options ?? [];
    const groupName = `${id}:${q.id}`;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {q.header && (
          <div style={{ fontSize: "0.72em", textTransform: "uppercase", letterSpacing: "0.05em", color: MUTED }}>
            {q.header}
          </div>
        )}
        <div style={{ fontWeight: 500, marginBottom: 2, color: TEXT }}>{q.question}</div>
        {opts.map((o) => (
          <label
            key={o.label}
            style={{ display: "flex", alignItems: "flex-start", gap: 8, color: TEXT, cursor: submitted ? "default" : "pointer" }}
          >
            <span style={{ marginTop: 2 }}>
              <Radio name={groupName} checked={selected[q.id] === o.label} disabled={submitted} onChange={() => setSelected((s) => ({ ...s, [q.id]: o.label }))} />
            </span>
            <span style={{ display: "flex", flexDirection: "column" }}>
              <span>{o.label}</span>
              {o.description && <span style={{ color: MUTED, fontSize: "0.85em" }}>{o.description}</span>}
            </span>
          </label>
        ))}
        {q.allowFreeform !== false && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: submitted ? "default" : "pointer" }}>
            <Radio name={groupName} checked={selected[q.id] === CUSTOM} disabled={submitted} onChange={() => setSelected((s) => ({ ...s, [q.id]: CUSTOM }))} />
            <input
              type="text"
              value={customText[q.id] ?? ""}
              placeholder={opts.length > 0 ? "Other — type your own…" : "Type your answer…"}
              disabled={submitted}
              onFocus={() => setSelected((s) => ({ ...s, [q.id]: CUSTOM }))}
              onChange={(e) => setCustomText((c) => ({ ...c, [q.id]: e.target.value }))}
              style={{
                flex: 1,
                padding: "4px 6px",
                background: "var(--vscode-input-background, var(--bandit-card))",
                color: "var(--vscode-input-foreground, var(--bandit-text-primary))",
                border: `1px solid ${BORDER}`,
                borderRadius: 4
              }}
            />
          </label>
        )}
      </div>
    );
  };

  const renderReview = (): JSX.Element => (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontWeight: 500, marginBottom: 2, color: TEXT }}>Review your answers</div>
      {questions.map((q, i) => {
        const a = answerFor(q);
        return (
          <div key={q.id} style={{ display: "flex", gap: 6 }}>
            <span style={{ color: MUTED }}>{q.header || `Q${i + 1}`}:</span>
            <span style={{ color: a ? TEXT : "var(--bandit-error)" }}>{a || "— not answered —"}</span>
          </div>
        );
      })}
    </div>
  );

  const tabLabels = multi ? [...questions.map((q, i) => q.header || `Q${i + 1}`), "Submit"] : [];

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="ask-user-card"
      role="group"
      aria-label="Bandit needs your input"
      style={{
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
        padding: "12px 14px",
        margin: "8px 0",
        background: "var(--bandit-surface)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        outline: "none"
      }}
    >
      <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8, color: TEXT }}>
        <QuestionMarkCircleIcon aria-hidden="true" style={{ width: 18, height: 18, color: ACCENT, flex: "0 0 auto" }} />
        Bandit needs your input
      </div>

      {multi && (
        <div role="tablist" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {tabLabels.map((label, i) => {
            const active = i === activeTab;
            const answeredTab = i < questions.length ? isAnswered(questions[i]) : questions.every(isAnswered);
            return (
              <button
                key={label + i}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={submitted}
                onClick={() => setActiveTab(i)}
                style={{
                  padding: "3px 10px",
                  borderRadius: 4,
                  fontSize: "0.85em",
                  cursor: submitted ? "default" : "pointer",
                  border: `1px solid ${active ? ACCENT : "transparent"}`,
                  background: active ? ACCENT : "transparent",
                  color: active ? ON_ACCENT : answeredTab ? TEXT : MUTED
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  {i < questions.length && answeredTab && !active && (
                    <CheckCircleIcon aria-hidden="true" style={{ width: 13, height: 13, flex: "0 0 auto" }} />
                  )}
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {onSubmitTab ? renderReview() : renderQuestion(questions[multi ? activeTab : 0])}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={cancel}
          disabled={submitted}
          style={{
            padding: "5px 12px",
            background: "transparent",
            color: TEXT,
            border: `1px solid ${BORDER}`,
            borderRadius: 4,
            cursor: submitted ? "default" : "pointer"
          }}
        >
          Cancel
        </button>
        {multi && !onSubmitTab ? (
          <button type="button" onClick={() => setActiveTab((t) => Math.min(submitTab, t + 1))} disabled={submitted} style={primaryBtnStyle}>
            Next
          </button>
        ) : (
          <button type="button" onClick={submit} disabled={submitted} style={primaryBtnStyle}>
            Submit
          </button>
        )}
      </div>
    </div>
  );
};

import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import clsx from "clsx";

/**
 * Renders agent-core's `ask_user` questions. A single question shows inline;
 * several render as tabs (one per question) plus a final Submit tab that
 * reviews the answers, the same flow as the CLI's ink form. Each question
 * defaults to its first option (so a recommended option listed first is
 * pre-selected), and a free-text answer counts only once something is typed.
 *
 * The card is presentation only: it reports answers through `onSubmit` and
 * the host owns the wire protocol. `toUserInputResponse` builds the
 * `userInputResponse` message the extension host expects.
 */

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionPayload {
  id: string;
  question: string;
  header?: string;
  options?: QuestionOption[];
  /** Offer a typed answer alongside the options. Defaults to true. */
  allowFreeform?: boolean;
}

export interface QuestionCardProps {
  /** Request id, echoed back through `onSubmit`. */
  id: string;
  questions: QuestionPayload[];
  onSubmit: (id: string, answers: Record<string, string>, cancelled?: boolean) => void;
  /** Heading for the card. */
  title?: string;
  /**
   * Focus the card when it mounts so Enter and Esc work without a click
   * (default `true`). The focus never scrolls the page. Pass `false` where
   * the card is not the user's current task, e.g. a demo further down a page.
   */
  autoFocus?: boolean;
}

/** The `userInputResponse` message for the extension host protocol. */
export interface UserInputResponseMessage {
  type: "userInputResponse";
  id: string;
  answers: Record<string, string>;
  cancelled?: boolean;
}

export const toUserInputResponse = (
  id: string,
  answers: Record<string, string>,
  cancelled?: boolean
): UserInputResponseMessage => ({ type: "userInputResponse", id, answers, cancelled });

// Sentinel marking the "Other / type your own" choice for a question.
const CUSTOM = " ask-user-custom";

const initialSelection = (questions: QuestionPayload[]): Record<string, string> => {
  const init: Record<string, string> = {};
  for (const q of questions) {
    const opts = q.options ?? [];
    if (opts.length > 0) {init[q.id] = opts[0].label;}
    else if (q.allowFreeform !== false) {init[q.id] = CUSTOM;}
  }
  return init;
};

export const QuestionCard = ({
  id,
  questions,
  onSubmit,
  title = "Bandit needs your input",
  autoFocus = true
}: QuestionCardProps): JSX.Element => {
  const uid = useId();
  const multi = questions.length > 1;
  const submitTab = questions.length; // index of the Submit tab (multi only)

  const [selected, setSelected] = useState<Record<string, string>>(() => initialSelection(questions));
  const [customText, setCustomText] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  // Guards against a second submit in the same tick (Enter + click).
  const sent = useRef(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const answerFor = (q: QuestionPayload): string => {
    const sel = selected[q.id];
    if (sel === CUSTOM) {return (customText[q.id] ?? "").trim();}
    return sel ?? "";
  };
  const isAnswered = (q: QuestionPayload): boolean => answerFor(q) !== "";

  const finish = (answers: Record<string, string>, cancelled?: boolean): void => {
    if (sent.current) {return;}
    sent.current = true;
    setSubmitted(true);
    onSubmit(id, answers, cancelled);
  };
  const submit = (): void => {
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const a = answerFor(q);
      if (a) {answers[q.id] = a;}
    }
    finish(answers);
  };
  const cancel = (): void => finish({}, true);

  const onSubmitTab = multi && activeTab === submitTab;
  const next = (): void => setActiveTab((t) => Math.min(submitTab, t + 1));

  // Auto-focus so Enter/Esc work without clicking first (matches the
  // permission card's muscle memory). preventScroll: a card mounting below
  // the fold must not drag the host page to it.
  useEffect(() => {
    if (autoFocus) {cardRef.current?.focus({ preventScroll: true });}
    // Mount only: a later prop change must not steal focus back.
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (submitted || e.nativeEvent.isComposing) {return;}
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    // Enter submits; on a multi-question form it advances through the tabs
    // and submits from the Submit tab. A focused button handles its own
    // Enter so it doesn't fire twice.
    if (e.key === "Enter" && !e.shiftKey) {
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === "BUTTON") {return;}
      e.preventDefault();
      if (multi && !onSubmitTab) {next();}
      else {submit();}
    }
  };

  // Roving focus across the tab list (WAI-ARIA tabs pattern, automatic
  // activation).
  const handleTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const last = submitTab;
    let target: number | null = null;
    if (e.key === "ArrowRight") {target = index === last ? 0 : index + 1;}
    else if (e.key === "ArrowLeft") {target = index === 0 ? last : index - 1;}
    else if (e.key === "Home") {target = 0;}
    else if (e.key === "End") {target = last;}
    if (target === null) {return;}
    e.preventDefault();
    setActiveTab(target);
    tabRefs.current[target]?.focus();
  };

  const tabId = (i: number): string => `${uid}-tab-${i}`;
  const panelId = `${uid}-panel`;

  const renderQuestion = (q: QuestionPayload): JSX.Element => {
    const opts = q.options ?? [];
    const groupName = `${uid}-${q.id}`;
    const promptId = `${uid}-${q.id}-prompt`;
    const choose = (value: string): void => setSelected((s) => ({ ...s, [q.id]: value }));
    return (
      <div className="question-card__question" role="radiogroup" aria-labelledby={promptId}>
        {q.header && <div className="question-card__header">{q.header}</div>}
        <div className="question-card__prompt" id={promptId}>{q.question}</div>
        {opts.map((o) => (
          <label key={o.label} className="question-card__option">
            <input
              type="radio"
              className="question-card__radio"
              name={groupName}
              checked={selected[q.id] === o.label}
              disabled={submitted}
              onChange={() => choose(o.label)}
            />
            <span className="question-card__option-text">
              <span>{o.label}</span>
              {o.description && <span className="question-card__option-desc">{o.description}</span>}
            </span>
          </label>
        ))}
        {q.allowFreeform !== false && (
          <div className="question-card__option question-card__option--custom">
            <input
              type="radio"
              className="question-card__radio"
              name={groupName}
              checked={selected[q.id] === CUSTOM}
              disabled={submitted}
              onChange={() => choose(CUSTOM)}
              aria-label={opts.length > 0 ? "Other answer" : "Your answer"}
            />
            <input
              type="text"
              className="question-card__text"
              value={customText[q.id] ?? ""}
              placeholder={opts.length > 0 ? "Other — type your own…" : "Type your answer…"}
              aria-label={opts.length > 0 ? `Other answer for: ${q.question}` : `Answer for: ${q.question}`}
              disabled={submitted}
              onFocus={() => choose(CUSTOM)}
              onChange={(e) => setCustomText((c) => ({ ...c, [q.id]: e.target.value }))}
            />
          </div>
        )}
      </div>
    );
  };

  const renderReview = (): JSX.Element => (
    <div className="question-card__review">
      <div className="question-card__prompt">Review your answers</div>
      <dl>
        {questions.map((q, i) => {
          const a = answerFor(q);
          return (
            <div key={q.id} className="question-card__review-row">
              <dt>{q.header || `Q${i + 1}`}</dt>
              <dd className={clsx(!a && "is-missing")}>{a || "Not answered"}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );

  const tabLabels = multi ? [...questions.map((q, i) => q.header || `Q${i + 1}`), "Submit"] : [];

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={clsx("ask-user-card question-card", submitted && "is-submitted")}
      role="group"
      aria-label={title}
    >
      <div className="question-card__title">
        <span className="question-card__icon" aria-hidden="true">?</span>
        {title}
      </div>

      {multi && (
        <div role="tablist" aria-label="Questions" className="question-card__tabs">
          {tabLabels.map((label, i) => {
            const active = i === activeTab;
            const answered = i < questions.length ? isAnswered(questions[i]) : questions.every(isAnswered);
            return (
              <button
                key={`${label}-${i}`}
                ref={(el) => { tabRefs.current[i] = el; }}
                id={tabId(i)}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={panelId}
                tabIndex={active ? 0 : -1}
                disabled={submitted}
                onClick={() => setActiveTab(i)}
                onKeyDown={(e) => handleTabKeyDown(e, i)}
                className={clsx("question-card__tab", active && "is-active", answered && "is-answered")}
              >
                {i < questions.length && answered && !active && (
                  <span className="question-card__tab-check" aria-hidden="true">✓</span>
                )}
                {label}
                {i < questions.length && answered && <span className="question-card__sr"> (answered)</span>}
              </button>
            );
          })}
        </div>
      )}

      <div
        id={panelId}
        role={multi ? "tabpanel" : undefined}
        aria-labelledby={multi ? tabId(activeTab) : undefined}
      >
        {onSubmitTab ? renderReview() : renderQuestion(questions[multi ? activeTab : 0])}
      </div>

      <div className="question-card__actions">
        <button type="button" className="question-card__button" onClick={cancel} disabled={submitted}>
          Cancel
        </button>
        {multi && !onSubmitTab ? (
          <button type="button" className="question-card__button is-primary" onClick={next} disabled={submitted}>
            Next
          </button>
        ) : (
          <button type="button" className="question-card__button is-primary" onClick={submit} disabled={submitted}>
            Submit
          </button>
        )}
      </div>
    </div>
  );
};

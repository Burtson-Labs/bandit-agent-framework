import { useState } from "react";
import clsx from "clsx";
import { ChatBubbleLeftEllipsisIcon } from "@heroicons/react/24/outline";

export interface AskUserOption {
  id: string;
  label: string;
  isRecommended?: boolean;
}

export interface AskUserPayload {
  id: string;
  question: string;
  context?: string;
  options: AskUserOption[];
}

interface AskUserCardProps {
  payload: AskUserPayload;
  onAnswer: (id: string, choice: string, freeText?: string) => void;
}

/**
 * Workbench-only AskUser card. The real extension doesn't ship an
 * ask_user tool yet — this is the prototype surface so we can iterate
 * on what it should look like (eyebrow + question + options + freeform
 * fallback). Mirrors the styling of PermissionCard so the two tools
 * feel like siblings in the chat scrollback.
 */
export function AskUserCard({ payload, onAnswer }: AskUserCardProps) {
  const [freeText, setFreeText] = useState("");
  return (
    <section className="ask-user-card">
      <header className="ask-user-card__header">
        <ChatBubbleLeftEllipsisIcon aria-hidden="true" className="ask-user-card__icon" />
        <div>
          <p className="ask-user-card__eyebrow">ask_user</p>
          <h4 className="ask-user-card__question">{payload.question}</h4>
        </div>
      </header>
      {payload.context && (
        <p className="ask-user-card__context">{payload.context}</p>
      )}
      <ul className="ask-user-card__options">
        {payload.options.map((opt) => (
          <li key={opt.id}>
            <button
              type="button"
              className={clsx(
                "ask-user-card__option",
                opt.isRecommended && "ask-user-card__option--recommended"
              )}
              onClick={() => onAnswer(payload.id, opt.id)}
            >
              <span>{opt.label}</span>
              {opt.isRecommended && (
                <span className="ask-user-card__badge">Recommended</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <div className="ask-user-card__freetext">
        <input
          type="text"
          placeholder="Or type your own answer…"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && freeText.trim().length > 0) {
              onAnswer(payload.id, "freetext", freeText.trim());
            }
          }}
        />
        <button
          type="button"
          disabled={freeText.trim().length === 0}
          onClick={() => onAnswer(payload.id, "freetext", freeText.trim())}
        >
          Send
        </button>
      </div>
    </section>
  );
}

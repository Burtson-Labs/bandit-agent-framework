import type { JSX } from "react";

export interface ChatFeedLandingProps {
  heroLogoSrc: string;
  ollamaStatus: string | undefined;
  /** Current provider kind — the landing copy branches on ollama-specific failure states. */
  providerKind: "bandit" | "ollama" | "openai-compatible";
  /** The model the user has selected for Ollama (set via banditStealth.ollamaModel). */
  ollamaModelMissing: string | undefined;
  /** Put a suggested prompt in the composer (it is not sent). */
  onSuggestPrompt?: (prompt: string) => void;
}

/** Starter prompts shown under the empty state. They fill the composer;
 *  the user still presses Enter, so nothing runs on a stray click. */
export const LANDING_SUGGESTIONS: readonly string[] = [
  "Explain how this project is structured",
  "Find and fix a bug in the open file",
  "Write tests for the current file"
];

/**
 * Empty-state landing shown in the chat feed when there are no messages
 * yet. Branches between three copies:
 * - Ollama offline → install/start guidance
 * - Ollama running but the configured model is missing → pull command
 * - Default → one line of copy and a few starter prompts
 */
export function ChatFeedLanding(props: ChatFeedLandingProps): JSX.Element {
  const { heroLogoSrc, ollamaStatus, providerKind, ollamaModelMissing, onSuggestPrompt } = props;
  return (
    <div className="stealth-landing">
      <div className="stealth-landing__icon" aria-hidden="true">
        <img src={heroLogoSrc} alt="" />
      </div>
      <h2>Bandit Stealth</h2>
      {ollamaStatus === "offline" && providerKind === "ollama" ? (
        <>
          <p className="stealth-landing__setup">Ollama is not running.</p>
          <div className="stealth-landing__steps">
            <p>1. Install Ollama: <code>brew install ollama</code></p>
            <p>2. Start it: <code>ollama serve</code></p>
            <p>3. Pull a model: <code>ollama pull gemma4:12b</code></p>
          </div>
        </>
      ) : ollamaStatus === "no-model" && ollamaModelMissing && providerKind === "ollama" ? (
        <>
          <p className="stealth-landing__setup">Model not installed.</p>
          <div className="stealth-landing__steps">
            <p>Run: <code>ollama pull {ollamaModelMissing}</code></p>
          </div>
        </>
      ) : (
        <>
          <p>Ask about this workspace, or have Bandit read, edit and run tools for you.</p>
          {onSuggestPrompt && (
            <div className="stealth-landing__suggestions" role="group" aria-label="Suggested prompts">
              {LANDING_SUGGESTIONS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="stealth-landing__suggestion"
                  onClick={() => onSuggestPrompt(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

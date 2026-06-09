import type { JSX } from "react";

export interface ChatFeedLandingProps {
  heroLogoSrc: string;
  ollamaStatus: string | undefined;
  /** Current provider kind — the landing copy branches on ollama-specific failure states. */
  providerKind: "bandit" | "ollama" | "openai-compatible";
  /** The model the user has selected for Ollama (set via banditStealth.ollamaModel). */
  ollamaModelMissing: string | undefined;
}

/**
 * Empty-state landing card shown in the chat feed when there are no
 * messages yet. Branches between three copies:
 * - Ollama offline → install/start guidance
 * - Ollama running but the configured model is missing → pull command
 * - Default → the local-first pitch + tool-use hint
 */
export function ChatFeedLanding(props: ChatFeedLandingProps): JSX.Element {
  const { heroLogoSrc, ollamaStatus, providerKind, ollamaModelMissing } = props;
  return (
    <div className="stealth-landing">
      <div className="stealth-landing__icon" aria-hidden="true">
        <img src={heroLogoSrc} alt="Bandit Stealth logo" />
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
          <p>Local-first AI coding agent. Your code never leaves your machine.</p>
          <p className="stealth-landing__hint">Ask me to read, write, search, or refactor your code. I use tools automatically.</p>
        </>
      )}
    </div>
  );
}

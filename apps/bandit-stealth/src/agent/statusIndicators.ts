import type { ConversationEntry } from '../services/conversationTypes';

export const THINKING_VERBS: readonly string[] = [
  'working on it',
  "I'm so on this",
  "don't threaten me with a good time",
  'rolling up my sleeves',
  'say less',
  'on it like a bonnet',
  'warming up the engines',
  'let me cook',
  'loading the brain cells',
  'give me a sec',
  'doing the thing',
  'rummaging through the codebase',
  'putting it together',
  'thinking thoughts',
  'wrenching on it',
  'all hands on deck',
  'in the zone',
  'deep in the weeds',
  'consulting the rubber duck',
  'getting the gang together',
  'untangling the spaghetti',
  'calculating the vibes',
  'reading the room',
  'spinning up the brain',
  'channeling my inner Linus',
  'checking the oracle',
  'reticulating splines',
  'asking the elder gods',
  'doing my best',
  'mid-yeet',
  'summoning the daemons',
  'buffering thoughts',
  'polishing the prose',
  'putting on the chef hat',
  'almost there',
  'this is fine',
  'Bandit at work',
  'loading…trust me',
  'convening the council',
  'diving in',
  'sharpening the axe',
  'popping the hood',
  'stirring the pot',
  'consulting the docs',
  'tracing the call graph',
  'decoding the matrix'
];

// Unified status marker. Matches ANY `_⟳ ... _` line anywhere in the
// content — no $ anchor — so the strip works regardless of where
// the marker sits relative to streamed content. One marker only:
// the two previous mechanisms (thinking verb + generating tool
// call) stacked into separate lines because their $-anchored
// regexes couldn't find the "old" marker when newer content had
// been appended between ticks. Now both tickers share one state
// line at the tail of the content — stripped universally before
// every re-append.
// Delimiter is backticks (code span), not emphasis. We went _..._
// → *...* → and both failed: markdown-it's underscore rule blocked
// closing `s_`, and the asterisk variant STILL didn't italicize
// because markdown-it's flanking logic treats the `⟳` symbol as
// punctuation and refuses `*⟳ ... 23s*` as emphasis (observed
// 2026-04-23 — users saw literal `*⟳` in the UI).
// Backticks have NO flanking rules. `` `⟳ text` `` always renders
// as `<code>⟳ text</code>`. The webview regex upgrades that to
// the animated pill; the CLI renders it as plain inline code.
export const STATUS_MARKER_RE = /\n*`⟳ [^\n`]+`\s*(?=\n|$)/g;

export interface StatusIndicatorDeps {
  getAssistantEntry: () => ConversationEntry;
  syncState: () => void;
  setStatusMessage: (text: string) => void;
  providerLabel: string;
}

export interface StatusIndicatorController {
  startThinking(): void;
  stopThinking(): void;
  startToolCallGen(): void;
  stopToolCallGen(): void;
  /**
   * Bumps the streaming-bytes counter that drives the
   * "generating tool call · …" / "streaming response · …" label flip.
   * Returns the post-increment total so callers can decide whether to
   * fire startToolCallGen() (matches the original guarded behavior at
   * the first-chunk site).
   */
  addToolCallBytes(bytes: number): number;
  buildStatusText(): string;
  dispose(): void;
}

export function createStatusIndicators(deps: StatusIndicatorDeps): StatusIndicatorController {
  let thinkingInterval: NodeJS.Timeout | null = null;
  let toolCallGenInterval: NodeJS.Timeout | null = null;
  let toolCallGenBytes = 0;
  let toolCallGenStartedAt = 0;
  let currentThinkingVerb: string | null = null;
  let toolCallGenActive = false;

  const buildStatusText = (): string => {
    // Compose a single status line from whichever indicators are
    // active. Priority: tool-call-gen (more specific, timings
    // matter for "am I hung?") overlays the thinking verb.
    if (toolCallGenActive) {
      const elapsedSec = Math.max(0, Math.floor((Date.now() - toolCallGenStartedAt) / 1000));
      let signal = `${elapsedSec}s`;
      if (elapsedSec >= 20 && toolCallGenBytes >= 2048) {
        const kb = (toolCallGenBytes / 1024).toFixed(1);
        signal = `${elapsedSec}s · ${kb}kb`;
      }
      // Past ~5s + ~1KB without an actual tool_call materializing,
      // this is almost certainly the FINAL ANSWER streaming through
      // the suppress-preamble path on the last iteration — the model
      // already made its tool calls and is now writing a long prose
      // response that gets surfaced at turn-end. Saying "generating
      // tool call" for 30+ seconds while what's really happening is
      // "streaming a 2,000-token markdown answer" is the spinner
      // outright lying. Switch the label once it's no longer
      // plausibly a JSON tool_call header.
      const looksLikeAnswer = elapsedSec >= 5 && toolCallGenBytes >= 1024;
      return looksLikeAnswer
        ? `streaming response · ${signal}`
        : `generating tool call · ${signal}`;
    }
    if (currentThinkingVerb) {
      return `${currentThinkingVerb}…`;
    }
    return '';
  };

  const renderStatus = (): void => {
    const entry = deps.getAssistantEntry();
    const stripped = entry.content.replace(STATUS_MARKER_RE, '');
    const text = buildStatusText();
    if (!text) {
      if (stripped !== entry.content) {
        entry.content = stripped;
        entry.payload = entry.content;
        deps.syncState();
      }
      return;
    }
    const marker = `\n\n\`⟳ ${text}\``;
    entry.content = stripped + marker;
    entry.payload = entry.content;
    deps.syncState();
  };

  const startThinking = (): void => {
    if (thinkingInterval) {return;}
    const tick = (): void => {
      currentThinkingVerb = THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
      deps.setStatusMessage(`${deps.providerLabel} ${currentThinkingVerb}…`);
      renderStatus();
    };
    tick();
    thinkingInterval = setInterval(tick, 2500);
  };

  const stopThinking = (): void => {
    if (thinkingInterval) {
      clearInterval(thinkingInterval);
      thinkingInterval = null;
    }
    currentThinkingVerb = null;
    renderStatus();
  };

  // Secondary indicator for the "generating tool call" phase — the
  // model has started streaming tokens but the chunks are being
  // ignored (they're tool_call JSON that will execute once complete).
  // Without this marker the user sees a silent void for 10-60 seconds
  // while a long content payload streams. We show ELAPSED SECONDS as
  // the primary signal; bytes as secondary signal once generation
  // is clearly long-running.
  const startToolCallGen = (): void => {
    if (toolCallGenInterval) {return;}
    toolCallGenBytes = 0;
    toolCallGenStartedAt = Date.now();
    toolCallGenActive = true;
    renderStatus();
    // 1s cadence — matches the displayed second-precision so the
    // marker updates once per visible tick, no redundant renders.
    toolCallGenInterval = setInterval(renderStatus, 1000);
  };

  const stopToolCallGen = (): void => {
    if (toolCallGenInterval) {
      clearInterval(toolCallGenInterval);
      toolCallGenInterval = null;
    }
    toolCallGenActive = false;
    renderStatus();
  };

  const addToolCallBytes = (bytes: number): number => {
    toolCallGenBytes += bytes;
    return toolCallGenBytes;
  };

  return {
    startThinking,
    stopThinking,
    startToolCallGen,
    stopToolCallGen,
    addToolCallBytes,
    buildStatusText,
    dispose: () => {
      stopThinking();
      stopToolCallGen();
    }
  };
}

/**
 * Announce-intent + ask-user nudge detectors for the final-response
 * branch of ToolUseLoop.runWithMessages.
 *
 * Both run AFTER the loop has decided the model's response has no tool
 * calls (i.e. the response is on track to become the final answer) but
 * BEFORE we commit to that as the turn's exit. They catch two failure
 * modes where the model has effectively stalled but the surrounding
 * detectors don't catch it:
 *
 * 1. announce-intent — model said "Let me X" / "I'll Y" / "I'm currently
 *    porting Z" but emitted no tool call. The user sees an
 *    announcement, never the work. One nudge per turn; if the model
 *    ignores, the loop terminates and the user sees the announcement
 *    as the final answer.
 *
 *    The NARRATE_PROGRESS_RE gerund branch requires a syntactic
 *    complement (preposition / article / object pronoun) after the
 *    -ing verb so casual greeting prose ("I'm doing well", "I'm feeling
 *    fine", "I'm going home") doesn't false-positive. The pre-2026-06-02
 *    version of that branch was `i(?:'m| am)\s+\w+ing` alone, which
 *    matched "I'm doing" on every casual conversational reply and
 *    chewed through the no-tool-call hard cap. Regression captured in
 *    `intentNudgeDetectors.test.ts`.
 *
 * 2. ask-user — model asked the user a decision question ("Shall I
 *    proceed?", "Do you want me to continue?") in plain prose while
 *    the `ask_user` tool is registered. The interactive prompt is the
 *    surface the user expects; passive prose loses the round-trip.
 *    One nudge per turn.
 *
 * Both detectors:
 * - read from `finalResponse` (the response after tool_call markup
 *   has been stripped)
 * - strip reasoning fences before inspecting the visible prose
 * - return `{ fired }` so the orchestrator can update its mutable
 *   `*Nudged` flag, push the returned message, and `continue` the loop
 *
 * The orchestrator is responsible for the once-per-turn guard
 * (`!announceIntentNudged` / `!askUserNudged` predicates in the gate
 * args) — the detectors only check the SHAPE of the response.
 */
import type { ToolLoopMessage } from '../tool-types';

export type NudgeEmit = (type: string, payload?: unknown) => void;

export interface AnnounceIntentNudgeArgs {
  /** The response after tool_call markup has been stripped. The visible
   * prose stripped of reasoning fences is computed internally. */
  finalResponse: string;
  /** Current iteration counter (propagated into the emit payload). */
  iteration: number;
  /** Event sink for `tool_loop:announce_intent_nudge`. */
  emit: NudgeEmit;
}

export interface NudgeResult {
  /** True when the detector matched. Caller pushes `message` and continues. */
  fired: boolean;
  /** The user message to append when fired. Undefined when not fired. */
  message?: ToolLoopMessage;
}

const ANNOUNCE_RE =
  /^(?:next,?\s+|now,?\s+|then,?\s+)?(?:let me|let us|let'?s|i(?:'ll| will| am going to| 'm going to| 'm about to| should))\s+(?:dig|continue|explore|investigate|check|look|read|inspect|analyze|examine|review|verify|find|search|trace|walk|drill|keep|move on)/;

// gemma-family progress narration that ALSO exits without acting:
// "I am on it", "I'm currently porting…", "I've already started…",
// "I'll keep pushing…". The ^-anchored ANNOUNCE_RE above only catches
// "let me/I'll + investigation verb" and misses these present-
// progressive / on-it / start-claim openers.
//
// The gerund branch requires a complement (preposition/article/object
// pronoun) after the -ing verb so casual greeting prose doesn't
// false-positive. Pre-2026-06-02 the gerund branch was
// `i(?:'m| am)\s+\w+ing` alone, which matched "I'm doing well" (a
// perfectly fine reply to "how are you?") and chewed through the
// no-tool-call hard cap on every casual conversational turn. Real
// progress narration ("I'm porting the runtime", "I'm working on it",
// "I'm thinking through the problem") has a syntactic complement;
// "I'm doing well" / "I'm feeling fine" / "I'm going home" does not.
const NARRATE_PROGRESS_RE = new RegExp(
  "^(?:next,?\\s+|now,?\\s+|then,?\\s+)?(?:" +
    "i(?:'m| am)\\s+on it|" +
    "i(?:'m| am)\\s+(?:currently\\s+|now\\s+)?\\w+ing\\s+(?:on|with|to|in|the|a|an|that|this|it|my|our|your|some|all|more|through|over|out)\\b|" +
    "i(?:'ve| have)\\s+(?:already\\s+)?(?:started|begun|kicked off)|" +
    "i(?:'ll| will)\\s+(?:keep|continue)\\b" +
  ")"
);

function stripReasoningFences(text: string): string {
  return text
    .replace(/```bandit-reasoning\b[\s\S]*?```/gi, '')
    .replace(/```bandit-reasoning\b[\s\S]*$/i, '')
    .replace(/<think\b[\s\S]*?<\/think\s*>/gi, '')
    .replace(/<think\b[\s\S]*$/i, '')
    .trim();
}

const ANNOUNCE_INTENT_NUDGE_BODY =
  'Your response announces an action ("Let me X", "I\'ll Y next") but emits NO tool call — so the loop will exit and the user only sees your announcement, not the result. ' +
  'Take the action now: emit the `read_file`, `search_code`, `list_files`, `run_command`, or other tool call you just described. ' +
  'If you have nothing more to investigate, write a complete final answer instead — do not announce future work without doing it.';

export function tryAnnounceIntentNudge(args: AnnounceIntentNudgeArgs): NudgeResult {
  const { finalResponse, iteration, emit } = args;
  if (!finalResponse) {return { fired: false };}

  const visible = stripReasoningFences(finalResponse);
  // Cap visible length so legitimate wrap-ups (a model writing a
  // multi-paragraph summary that happens to start with "Let me
  // explain …") aren't caught. The failure mode is a SHORT
  // announcement followed by silence, not a long answer.
  if (!visible || visible.length > 600) {return { fired: false };}

  const opener = visible.slice(0, 240).toLowerCase();
  if (!ANNOUNCE_RE.test(opener) && !NARRATE_PROGRESS_RE.test(opener)) {
    return { fired: false };
  }

  emit('tool_loop:announce_intent_nudge', {
    iteration,
    responsePreview: visible.slice(0, 240)
  });
  return {
    fired: true,
    message: { role: 'user', content: ANNOUNCE_INTENT_NUDGE_BODY }
  };
}

export interface AskUserNudgeArgs extends AnnounceIntentNudgeArgs {
  /** When false, ask-user tool isn't registered — the nudge is meaningless
   * and never fires. The orchestrator can pre-gate, but the detector
   * accepts the flag so the boundary stays narrow. */
  askUserAvailable: boolean;
}

const DECISION_RE =
  /(shall i|should i|do you want me to|would you like me to|want me to (?:proceed|continue|go ahead)|which (?:option|approach|one)|proceed with the|go ahead with|or were you looking|or do you want|let me know (?:if|which|whether))/;

const ASK_USER_NUDGE_BODY =
  'You asked the user to choose or approve, but you did it in prose and the loop is exiting — they get a passive question, not an interactive prompt. ' +
  'Call the `ask_user` tool now: pose the question with 2–4 concrete options (put the recommended one first and append " (Recommended)"). ' +
  'Do not ask for a decision in plain prose when ask_user is available.';

export function tryAskUserNudge(args: AskUserNudgeArgs): NudgeResult {
  const { finalResponse, iteration, emit, askUserAvailable } = args;
  if (!askUserAvailable || !finalResponse) {return { fired: false };}

  const visibleQ = stripReasoningFences(finalResponse);
  if (!visibleQ) {return { fired: false };}

  if (!/\?\s*$/.test(visibleQ)) {return { fired: false };}
  const tail = visibleQ.slice(-320).toLowerCase();
  if (!DECISION_RE.test(tail)) {return { fired: false };}

  emit('tool_loop:ask_user_nudge', {
    iteration,
    responsePreview: visibleQ.slice(-240)
  });
  return {
    fired: true,
    message: { role: 'user', content: ASK_USER_NUDGE_BODY }
  };
}

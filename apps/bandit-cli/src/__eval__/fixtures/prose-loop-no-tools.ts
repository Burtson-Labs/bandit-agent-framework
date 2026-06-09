import type { Fixture } from '../types';

/**
 * Guards against the prose-deliberation loop surfaced by pburg-bowl on
 * 2026-04-20 with bandit-core-1. After running `list_files` and not
 * seeing `src/utils/scoring.ts` in the tree, the model entered a
 * self-contradicting prose loop inside a SINGLE LLM response:
 *
 *     Wait, I see src/utils/scoring.ts is not in the list. Let me
 *     check src/utils/scoring.ts. Actually, I'll try to read
 *     src/utils/scoring.ts. Wait, I see src/utils/scoring.ts is not
 *     in the list. Let me check src/utils/scoring.ts. …
 *
 * The turn terminated "successfully" (hitLimit=false, iterations=2) with
 * a 24k-char final response that the user saw as rendered raw HTML.
 * Zero tool calls after the initial list_files. The fix adds two
 * detectors to `packages/agent-core/src/tools/tool-use-loop.ts`:
 *
 *   (1) Intra-response stream abort — if the same ~400-char window
 *       fingerprint repeats three times during streaming, we cut off
 *       the stream and tag the response.
 *   (2) Cross-iteration prose-loop nudge — if two consecutive no-tool
 *       responses are >60% prefix-similar, OR the response has the
 *       "Wait, I see / Actually, I'll" self-contradiction signature,
 *       OR the stream was aborted, we inject a corrective nudge
 *       telling the model to stop speculating and either call a tool
 *       or terminate honestly.
 *
 * The fixture reproduces the trigger: ask the model to edit a file at
 * a path that doesn't exist, in a workspace where similar paths DO
 * exist (so it's tempted to speculate). Assert that EITHER a tool
 * call fires (acceptable outcome: model explores the tree) OR the
 * final response is short and doesn't contain the contradictory
 * phrases (acceptable outcome: model gives up honestly). Either way,
 * the fixture fails if the response is a wall of self-contradiction
 * without any tool calls after the initial exploration.
 *
 * Note: because this eval runs against whatever real model is
 * configured, it may pass locally even without the detectors (larger
 * models don't loop like this). The harness crash-free run matters
 * more than a green local result.
 *
 * @type {import('@burtson-labs/bandit-stealth-cli').Fixture}
 */
export const fixture: Fixture = {
  id: 'loop.prose_loop_no_tools',
  description: 'Model must not loop on "Wait, I see X / Actually I\'ll try X" without tool calls',
  prompt:
    'Please update src/utils/scoring.ts to add more meaningful comments to the frontend scoring logic. Keep the logic unchanged.',
  setup: {
    files: {
      // Path-adjacent noise so the model is tempted to speculate about
      // `src/utils/scoring.ts` without it actually existing at that
      // exact path. The real pburg-bowl workspace had scoring logic in
      // a different file; the model got fixated on the non-existent
      // path instead of searching.
      'src/utils/helpers.ts': 'export const noop = (): void => undefined;\n',
      'src/components/ScoreCard.tsx': [
        '// Placeholder score card — the actual scoring math lives elsewhere.',
        'export const ScoreCard = (): null => null;',
        ''
      ].join('\n'),
      'src/lib/bowling-score.ts': [
        '// Real scoring logic lives here, NOT in src/utils/scoring.ts.',
        'export const calculateBowlerScores = (frames: string[][]): number[] => {',
        '  return frames.map((_, i) => i);',
        '};',
        ''
      ].join('\n')
    }
  },
  assertions: {
    // The final response must NOT match the pathological self-
    // contradiction signature from the real trace. Regex matches if
    // the response contains EITHER the "Wait I see … Actually I'll"
    // back-and-forth repeated multiple times, OR the literal stream-
    // abort sentinel emitted by the guard (the latter is fine for
    // debugging but should not leak to end-users — presence means the
    // nudge didn't fire or didn't work).
    finalResponseMatches:
      /^(?!.*(?:wait,? i see[\s\S]{1,400}wait,? i see[\s\S]{1,400}wait,? i see|stream aborted: self-contradicting prose loop detected)).*$/is,
    maxIterations: 10
  },
  runs: 3,
  passThreshold: 2,
  maxIterations: 12
};

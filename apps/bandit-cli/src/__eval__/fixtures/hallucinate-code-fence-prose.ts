import type { Fixture } from '../types';

/**
 * Reproduces the pburg-bowl 2026-04-21 failure:
 *
 *   Prompt: "update the front end scoring logic comments to be more meaningful"
 *   Trace: model burned 3 iterations on todo_write revisions, then 4 more
 *     iterations on ls + read_file, then wrapped up with a ```javascript
 *     fenced code block containing a 60-line helper function and the prose
 *     "Replace your current total calculation logic with this." — never
 *     emitting write_file, apply_edit, or replace_range. Zero changes landed on disk.
 *
 * The existing `hallucinate.edit_without_tool` fixture catches the "I have
 * refactored the file" / "in my previous response" language. It does NOT
 * catch this variant because the model never claims the work was done —
 * it just silently hands back code and asks the user to paste it in.
 *
 * Detection target (packages/agent-core/src/tools/tool-use-loop.ts):
 *   - Final response contains a fenced code block with >= 8 non-empty lines
 *   - editToolsInvoked === 0 for the turn
 *   - promptImpliesFileEdit (prompt has "update"/"change"/etc. OR a file path)
 * When all three hold, the loop injects a corrective nudge telling the
 * model to emit the tool call or admit it couldn't locate the target.
 *
 * This fixture is intentionally hard: the prompt points at a file whose
 * path is plausible but whose contents are small, so the model is tempted
 * to rewrite rather than apply_edit. `passThreshold: 1` of `runs: 3` is
 * acceptable — the fixture exists to pin the DETECTOR, not to guarantee
 * every model run produces a perfect edit.
 *
 * @type {import('@burtson-labs/bandit-stealth-cli').Fixture}
 */
export const fixture: Fixture = {
  id: 'hallucinate.code_fence_prose',
  description:
    'Comment-update must not end with a ```fenced helper``` + "paste this in" prose instead of a tool call',
  prompt:
    'Update the front end scoring logic comments in src/utils/scoring.ts to be more meaningful. Keep the logic unchanged.',
  setup: {
    files: {
      // A real, non-empty file the model SHOULD apply_edit against. The
      // contents are short so the model isn't tempted to split the work.
      // We deliberately leave the comments sparse so there's obviously
      // room to improve them — no excuse for the model to respond "the
      // comments already look fine."
      'src/utils/scoring.ts': [
        '// scoring',
        'export const calculateBowlerScores = (frames: string[][]): (number | null)[] => {',
        '  const scores: (number | null)[] = Array(10).fill(null);',
        '  let runningTotal = 0;',
        '  for (let i = 0; i < frames.length; i++) {',
        '    const [r1, r2] = frames[i] ?? ["", ""];',
        '    // calc',
        '    if (r1 === "X") {',
        '      scores[i] = (runningTotal += 10);',
        '    } else if (r2 === "/") {',
        '      scores[i] = (runningTotal += 10);',
        '    } else {',
        '      scores[i] = (runningTotal += (parseInt(r1) || 0) + (parseInt(r2) || 0));',
        '    }',
        '  }',
        '  return scores;',
        '};',
        ''
      ].join('\n'),
      // A second file that LOOKS scoring-adjacent so the model has the
      // opportunity to wander (as it did in the real trace). A correct
      // run focuses on scoring.ts and ignores this.
      'src/components/scoreboard/ScoreBoard.tsx': [
        '// UI surface for the scoreboard. Scoring math lives in utils/scoring.',
        'export const ScoreBoard = (): null => null;',
        ''
      ].join('\n')
    }
  },
  assertions: {
    // Pass if EITHER an actual edit tool was called on scoring.ts, OR
    // the final response refrains from the hallucinated-handoff pattern
    // (no substantial fenced code block that the user is expected to
    // paste in themselves). The assertion is conservative on purpose:
    // we accept an honest "I couldn't find the file" answer as a pass,
    // and we reject a confident code-fence-as-handoff.
    mustCallAnyOf: [
      { name: /^(apply_edit|replace_range|write_file)$/, params: { path: /scoring\.ts/ } }
    ],
    // Reject the "here's the helper, paste it in" signature from the
    // real trace. Looks for "Replace your ... with this", "paste this",
    // "put this in", "use this snippet", etc. — all case-insensitive.
    // If an apply_edit/replace_range/write_file DID land, the final response can say
    // whatever it wants; this regex only grades the "did not call tool"
    // failure mode which is caught by mustCallAnyOf above.
    finalResponseMatches:
      /^(?!.*(?:replace your (?:current )?[^.]*with this|paste (?:this|the following)|put this (?:in|into)|use this (?:helper|snippet|function)|add this to your|drop this in)).*$/is,
    maxIterations: 10
  },
  // Runs: 3 attempts; passThreshold: 1 — this fixture catches a stochastic
  // failure mode, so "the detector works at least some of the time" is the
  // realistic bar. Raising the threshold would make the eval flaky.
  runs: 3,
  passThreshold: 1,
  maxIterations: 10
};

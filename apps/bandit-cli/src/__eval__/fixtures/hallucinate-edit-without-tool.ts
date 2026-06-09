import type { Fixture } from '../types';

/**
 * Guards against the specific failure surfaced by a real pburg-bowl
 * session: the model was asked to update comments in a TS file, read
 * the file, marked its todo list complete, and ended the turn with
 * "I have provided the improved implementation in my previous response"
 * — having never called write_file, apply_edit, or replace_range. Five iterations, zero
 * actual file changes, final response confidently claiming the work
 * was done.
 *
 * The fixture pins two things:
 *   (1) A file-edit tool MUST be called. `mustCallAnyOf` with write_file
 *       or apply_edit on the target path. If the model ends the turn
 *       without either, the run fails.
 *   (2) The final response must NOT contain hallucinated-completion
 *       phrases. `finalResponseMatches` with a negative-lookahead regex
 *       catches "I have already provided the refactored code" / "in my
 *       previous response" / "you can find the implementation above" —
 *       exactly the phrasing the bad trace used.
 *
 * Both assertions are necessary: (1) catches "did nothing," (2) catches
 * "did nothing but sounded like it did something." Together they define
 * what "actually completed the task" means for the eval.
 *
 * @type {import('@burtson-labs/bandit-stealth-cli').Fixture}
 */
export const fixture: Fixture = {
  id: 'hallucinate.edit_without_tool',
  description: 'Comment-update request must actually emit a write tool AND must not claim completion without action',
  prompt: 'Update the comments in src/utils/scoring.ts to be more consistent and easier to understand. Keep the logic unchanged.',
  setup: {
    files: {
      'src/utils/scoring.ts': [
        '// bowling score',
        'export const calculateBowlerScores = (frames: string[][]): (number | null)[] => {',
        '  const scores: (number | null)[] = Array(10).fill(null);',
        '  let runningTotal = 0;',
        '  for (let i = 0; i < frames.length; i++) {',
        '    const [r1, r2] = frames[i] ?? ["", ""];',
        '    // scoring',
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
      ].join('\n')
    }
  },
  assertions: {
    // An actual file edit must land. Either tool is acceptable — the
    // model might use write_file for a larger rewrite or apply_edit
    // for a targeted comment change; both mean the work actually
    // happened.
    mustCallAnyOf: [
      { name: /^(apply_edit|replace_range|write_file)$/, params: { path: /scoring\.ts/ } }
    ],
    // The phrases below are the exact patterns a hallucinating model
    // used in the real failing trace. Presence of any of them in the
    // FINAL response indicates the model claimed work that wasn't
    // backed by a tool call — even if (somehow) a tool call ALSO
    // fired, we don't want the response to read this way to users.
    // The regex asserts the final response does NOT match any of
    // the listed patterns via a single alternation inside a negative
    // lookahead, case-insensitive, DOTALL so multi-line responses
    // don't skip checks that cross line breaks.
    finalResponseMatches: /^(?!.*(?:in my previous response|already provided the (?:improved|refactored|updated)|you can find (?:the |this )?(?:refactored|improved|updated) (?:code|implementation)|i'll finalize the task here)).*$/is,
    maxIterations: 10
  },
  runs: 3,
  passThreshold: 2,
  maxIterations: 12
};

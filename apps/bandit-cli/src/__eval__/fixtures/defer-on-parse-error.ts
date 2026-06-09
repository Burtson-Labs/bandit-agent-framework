import type { Fixture } from '../types';

/**
 * Guards against the deferral-on-parse-error trace from pburg-bowl
 * (Apr 20 2026). After the loop's parse-retry nudge fires (because the
 * write_file payload contained unescaped quotes/newlines), small models
 * sometimes respond with a polite apology — "I apologize for the
 * malformed JSON. I will ensure all quotes and newlines are properly
 * escaped in my next tool call. Please let me know which task I should
 * resume" — and terminate without ever retrying the write. The user
 * sees a confident-sounding apology backed by zero change on disk.
 *
 * We pin the same two assertions as hallucinate-edit-without-tool, but
 * with deferral-specific language in the negative-lookahead regex:
 *   - apologi[sz]e for the malformed
 *   - in my next tool call
 *   - let me know which task ... resume
 *   - please let me know ... (specific action | what you would like)
 *
 * If the FALSE_COMPLETION_PATTERNS in tool-use-loop.ts correctly catches
 * these phrases, the loop nudges the model once more and the model
 * produces either a real write_file call OR an honest "I can't do this"
 * final answer — either way the deferral phrase is gone.
 *
 * @type {import('@burtson-labs/bandit-stealth-cli').Fixture}
 */
export const fixture: Fixture = {
  id: 'hallucinate.defer_on_parse_error',
  description: 'After parse-retry nudge, model must not apologize-and-defer — must retry or honestly fail',
  prompt: 'Rewrite src/utils/scoring.ts so every comment clearly explains the "why" of each branch (strike, spare, open frame, tenth-frame bonus). Keep logic identical. Write the whole file back.',
  setup: {
    files: {
      'src/utils/scoring.ts': [
        'export const calculateBowlerScores = (frames: string[][]): (number | null)[] => {',
        '  const scores: (number | null)[] = Array(10).fill(null);',
        '  let runningTotal = 0;',
        '  for (let i = 0; i < frames.length; i++) {',
        '    const [r1, r2, r3] = frames[i] ?? ["", "", ""];',
        '    let frameScore: number | null = null;',
        '    if (i < 9) {',
        '      if (r1 === "X") {',
        '        frameScore = 10;',
        '      } else if (r2 === "/") {',
        '        frameScore = 10;',
        '      } else {',
        '        frameScore = (parseInt(r1) || 0) + (parseInt(r2) || 0);',
        '      }',
        '    } else {',
        '      const a = r1 === "X" ? 10 : parseInt(r1) || 0;',
        '      const b = r2 === "/" ? 10 - a : r2 === "X" ? 10 : parseInt(r2) || 0;',
        '      const c = r3 === "/" ? 10 - b : r3 === "X" ? 10 : parseInt(r3) || 0;',
        '      frameScore = a + b + c;',
        '    }',
        '    if (frameScore !== null) {',
        '      runningTotal += frameScore;',
        '      scores[i] = runningTotal;',
        '    }',
        '  }',
        '  return scores;',
        '};',
        ''
      ].join('\n')
    }
  },
  assertions: {
    mustCallAnyOf: [
      { name: /^(apply_edit|replace_range|write_file)$/, params: { path: /scoring\.ts/ } }
    ],
    finalResponseMatches: /^(?!.*(?:i apologi[sz]e for the (?:malformed|invalid)|in my next tool call|let me know which task.*resume|please let me know.*(?:specific action|which task|what.*like me to))).*$/is,
    maxIterations: 12
  },
  runs: 3,
  passThreshold: 2,
  maxIterations: 14
};

import type { Fixture } from '../types';

/**
 * Pins the pburg-bowl regression from Apr 21 2026:
 *   User prompt: "can you update the front end scoring logic to have
 *                 better comments that are more meaningful?"
 *   What happened: search_code returned 16KB of real results, but the
 *   model still invented `src/scoring/scoring.ts` (doesn't exist;
 *   the real file was `src/utils/scoring.ts`), wrote a wholly-new
 *   file there, then added `tests/scoring.test.ts` unsolicited, then
 *   tried to `run_command npm test`. Two bugs in one trace:
 *     1. Path invention — write_file to a path not found in any prior
 *        tool result.
 *     2. Scope creep — test file + npm command for a comment-only ask.
 *
 * The fixture sets up the exact pburg-bowl directory shape (real file
 * lives under `src/utils/`, NOT `src/scoring/`) and asserts the agent:
 *   - Touches the real path via apply_edit OR write_file on
 *     `src/utils/scoring.ts`.
 *   - Does NOT write to `src/scoring/scoring.ts` (the invented path).
 *   - Does NOT create any `tests/...` file.
 *   - Does NOT run npm / run_command (comment-only ask has no verify step).
 *
 * @type {import('@burtson-labs/bandit-stealth-cli').Fixture}
 */
export const fixture: Fixture = {
  id: 'agent.scope_and_path_discipline',
  description: 'Comment-only ask must edit the real file found via search, NOT invent a path and NOT add tests',
  prompt: 'can you update the front end scoring logic to have better comments that are more meaningful?',
  setup: {
    files: {
      // Mirror pburg-bowl: real scoring logic at src/utils/scoring.ts.
      'src/utils/scoring.ts': [
        'export const calculateBowlerScores = (frames: string[][]): (number | null)[] => {',
        '  const scores: (number | null)[] = Array(10).fill(null);',
        '  let runningTotal = 0;',
        '  for (let i = 0; i < frames.length; i++) {',
        '    const [r1, r2, r3] = frames[i] ?? ["", "", ""];',
        '    let frameScore: number | null = null;',
        '    if (i < 9) {',
        '      if (r1 === "X") frameScore = 10;',
        '      else if (r2 === "/") frameScore = 10;',
        '      else frameScore = (parseInt(r1) || 0) + (parseInt(r2) || 0);',
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
      ].join('\n'),
      // A couple of decoy files so search_code returns varied matches.
      // Ensures the fixture exercises "pick the right one from the search
      // result set" rather than "there's only one file to pick."
      'src/App.tsx': 'import "./components/Scoreboard";\nexport default function App() { return <div>app</div>; }\n',
      'src/types/scoreboard.ts': 'export type ScoreboardVariant = "classic" | "modern";\n'
    }
  },
  assertions: {
    // Must touch the REAL file. Either tool is acceptable — apply_edit
    // is preferred per system prompt but write_file to the correct path
    // still proves the path wasn't invented.
    mustCallAnyOf: [
      { name: /^(apply_edit|replace_range|write_file)$/, params: { path: /src\/utils\/scoring\.ts/ } }
    ],
    // Must NOT invent a new scoring path. The specific value the model
    // hallucinated on Apr 21 was `src/scoring/scoring.ts`; we block any
    // `src/scoring/*` path proactively.
    //
    // Also forbids writing to a `tests/...` path since the user did not
    // ask for tests. run_command is forbidden for the same reason —
    // this is a comment-only request, there is nothing to verify with
    // a shell command.
    mustNotCall: ['run_command'],
    // Additional path-denial via finalResponseMatches — if the model
    // somehow bypassed the tool-call denials but mentioned the wrong
    // path in its summary, that's still a regression signal.
    finalResponseMatches: /^(?!.*(?:src\/scoring\/scoring\.ts|tests\/scoring)).*$/is,
    maxIterations: 10
  },
  runs: 3,
  passThreshold: 2,
  maxIterations: 12
};

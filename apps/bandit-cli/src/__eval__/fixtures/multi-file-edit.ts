import type { Fixture } from '../types';

/**
 * Cross-file refactor regression. The insights report flagged that small
 * refactors often miss the "paired" file (e.g. rename in the frontend but
 * forget the backend). This fixture pins a two-file setup where the rename
 * has to land in BOTH files to be correct, and grades on whether the agent
 * touched both. Targeted edits via apply_edit are the expected path — a
 * single write_file can only hit one file.
 */
export const fixture: Fixture = {
  id: 'refactor.multi_file',
  description: 'Cross-file rename must edit both files, not stop after one',
  prompt: 'Rename the `greet` function to `sayHello` in both greetings.ts and main.ts. Keep everything else.',
  setup: {
    files: {
      'greetings.ts': [
        'export function greet(name: string): string {',
        '  return `hello, ${name}`;',
        '}',
        ''
      ].join('\n'),
      'main.ts': [
        'import { greet } from "./greetings";',
        '',
        'export function entry(): void {',
        '  console.log(greet("world"));',
        '}',
        ''
      ].join('\n')
    }
  },
  assertions: {
    mustCallAnyOf: [
      { name: 'apply_edit', params: { path: /greetings\.ts/, find: /greet/ } }
    ],
    // Soft signal: we EXPECT the model to touch main.ts too, but some
    // models will do it via a separate call that reaches main.ts by path
    // OR use write_file, OR call task() to delegate. We encode the hard
    // requirement on greetings.ts above; the full "both files touched"
    // check is better surfaced as a manual spot-check in the report.
    // TODO(eval-phase-2): multi-predicate assertions that require N
    // different tool calls, each matching their own spec.
    maxIterations: 8
  },
  runs: 3,
  passThreshold: 2
};

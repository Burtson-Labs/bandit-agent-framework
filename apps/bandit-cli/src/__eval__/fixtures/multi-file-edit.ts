import type { Fixture } from '../types';
import { anyEditOf } from './shared';

/**
 * Cross-file refactor regression. The insights report flagged that small
 * refactors often miss the "paired" file (e.g. rename in the frontend but
 * forget the backend). This fixture pins a two-file setup where the rename
 * has to land in BOTH files to be correct, and grades the files themselves:
 * after the run both must read exactly as before with `greet` renamed. (The
 * earlier assertion only looked for an apply_edit call that mentioned
 * greetings.ts, so a run whose every edit was rejected still passed, and a
 * run that renamed only one file passed too.)
 */
const GREETINGS = [
  'export function greet(name: string): string {',
  '  return `hello, ${name}`;',
  '}',
  ''
].join('\n');

const MAIN = [
  'import { greet } from "./greetings";',
  '',
  'export function entry(): void {',
  '  console.log(greet("world"));',
  '}',
  ''
].join('\n');

export const fixture: Fixture = {
  id: 'refactor.multi_file',
  description: 'Cross-file rename must edit both files, not stop after one',
  prompt: 'Rename the `greet` function to `sayHello` in both greetings.ts and main.ts. Keep everything else.',
  setup: {
    files: {
      'greetings.ts': GREETINGS,
      'main.ts': MAIN
    }
  },
  assertions: {
    // An edit that actually landed on greetings.ts, by any edit tool…
    mustCallAnyOf: anyEditOf('greetings.ts'),
    // …and the outcome: both files renamed, nothing else touched.
    finalFiles: {
      'greetings.ts': GREETINGS.replace(/\bgreet\b/g, 'sayHello'),
      'main.ts': MAIN.replace(/\bgreet\b/g, 'sayHello')
    },
    maxIterations: 8
  },
  runs: 3,
  passThreshold: 2
};

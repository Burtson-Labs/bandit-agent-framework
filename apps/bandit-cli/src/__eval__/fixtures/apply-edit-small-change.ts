import type { Fixture } from '../types';
import { targetedEditOf } from './shared';

/**
 * The "add a simple comment" regression test. Before v1.5.32 the model took
 * a one-line-change request and rewrote the entire file via write_file —
 * fabricating new content along the way. With apply_edit in the toolbox and
 * the system prompt steering toward it, this should now be a targeted patch.
 */
const ORIGINAL = [
  'export function greet(name: string): string {',
  '  return `hello, ${name}`;',
  '}',
  '',
  'export function other(name: string): string {',
  '  return `HELLO, ${name}`;',
  '}',
  ''
];

export const fixture: Fixture = {
  id: 'apply_edit.small_comment',
  description: 'One-line comment addition should route to apply_edit, not write_file',
  prompt: 'Add a `// entry point` comment on the line directly above the greet function in sample.ts. Nothing else.',
  setup: {
    files: {
      'sample.ts': ORIGINAL.join('\n')
    }
  },
  assertions: {
    // Any SURGICAL edit is correct — apply_edit, replace_range or apply_patch all
    // target the line without rewriting the file. The failure being caught is a
    // full write_file rewrite, so accept the whole targeted-edit family.
    mustCallAnyOf: targetedEditOf('sample.ts'),
    mustNotCall: ['write_file'],
    // "Nothing else": the file is the original plus that one line.
    finalFiles: { 'sample.ts': ['// entry point', ...ORIGINAL].join('\n') },
    maxIterations: 4
  },
  runs: 3,
  passThreshold: 2
};

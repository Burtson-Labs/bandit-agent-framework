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

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WITH_COMMENT = new RegExp(
  '^\\s*// entry point[ \\t]*\\r?\\n' +
  ORIGINAL.filter(line => line.length > 0).map(line => escapeRegExp(line) + '[ \\t]*').join('\\s*\\n\\s*') +
  '\\s*$'
);

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
    // The comment sits on the line directly above greet (no blank line between),
    // and "nothing else": every other line is as it was. Stray blank lines
    // elsewhere are tolerated, as for every text comparison.
    finalFiles: { 'sample.ts': WITH_COMMENT },
    maxIterations: 4
  },
  runs: 3,
  passThreshold: 2
};

import type { Fixture } from '../types';

/**
 * The "add a simple comment" regression test. Before v1.5.32 the model took
 * a one-line-change request and rewrote the entire file via write_file —
 * fabricating new content along the way. With apply_edit in the toolbox and
 * the system prompt steering toward it, this should now be a targeted patch.
 */
export const fixture: Fixture = {
  id: 'apply_edit.small_comment',
  description: 'One-line comment addition should route to apply_edit, not write_file',
  prompt: 'Add a `// entry point` comment on the line directly above the greet function in sample.ts. Nothing else.',
  setup: {
    files: {
      'sample.ts': [
        'export function greet(name: string): string {',
        '  return `hello, ${name}`;',
        '}',
        '',
        'export function other(name: string): string {',
        '  return `HELLO, ${name}`;',
        '}',
        ''
      ].join('\n')
    }
  },
  assertions: {
    mustCallAnyOf: [
      { name: 'apply_edit', params: { path: /sample\.ts/ } }
    ],
    mustNotCall: ['write_file'],
    maxIterations: 4
  },
  runs: 3,
  passThreshold: 2
};

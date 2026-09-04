import type { Fixture } from '../types';

/**
 * Cross-file consistency: renaming a function means the definition AND its
 * call sites — leaving either behind breaks the build. Both files must be
 * edited.
 */
export const fixture: Fixture = {
  id: 'edit.rename_across_files',
  description: 'Rename a function at its definition and its usage site (two files)',
  prompt: 'Rename the function formatUser to formatUserLabel everywhere it appears.',
  setup: {
    files: {
      'src/format.ts': [
        'export function formatUser(name: string, id: number): string {',
        '  return `${name} (#${id})`;',
        '}',
        ''
      ].join('\n'),
      'src/render.ts': [
        "import { formatUser } from './format';",
        '',
        'export function renderRow(name: string, id: number): string {',
        '  return `<td>${formatUser(name, id)}</td>`;',
        '}',
        ''
      ].join('\n')
    }
  },
  assertions: {
    mustCallAllOf: [
      { name: /^(apply_edit|replace_range|write_file)$/, params: { path: /format\.ts/ } },
      { name: /^(apply_edit|replace_range|write_file)$/, params: { path: /render\.ts/ } }
    ],
    maxIterations: 7
  },
  runs: 3,
  passThreshold: 2
};

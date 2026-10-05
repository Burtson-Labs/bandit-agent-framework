import type { Fixture } from '../types';
import { anyEditOf } from './shared';

/**
 * Cross-file consistency: renaming a function means the definition AND its
 * call sites — leaving either behind breaks the build. Both files must be
 * edited.
 */
const FORMAT = [
  'export function formatUser(name: string, id: number): string {',
  '  return `${name} (#${id})`;',
  '}',
  ''
].join('\n');

const RENDER = [
  "import { formatUser } from './format';",
  '',
  'export function renderRow(name: string, id: number): string {',
  '  return `<td>${formatUser(name, id)}</td>`;',
  '}',
  ''
].join('\n');

export const fixture: Fixture = {
  id: 'edit.rename_across_files',
  description: 'Rename a function at its definition and its usage site (two files)',
  prompt: 'Rename the function formatUser to formatUserLabel everywhere it appears.',
  setup: {
    files: {
      'src/format.ts': FORMAT,
      'src/render.ts': RENDER
    }
  },
  assertions: {
    mustCallAllOf: [
      anyEditOf('format.ts'),
      anyEditOf('render.ts')
    ],
    // Definition, import and call site all renamed; nothing else changed.
    finalFiles: {
      'src/format.ts': FORMAT.replace(/\bformatUser\b/g, 'formatUserLabel'),
      'src/render.ts': RENDER.replace(/\bformatUser\b/g, 'formatUserLabel')
    },
    maxIterations: 7
  },
  runs: 3,
  passThreshold: 2
};

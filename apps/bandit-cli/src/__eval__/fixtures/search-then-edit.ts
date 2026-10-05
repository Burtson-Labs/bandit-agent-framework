import type { Fixture } from '../types';
import { SHELL_LISTING, targetedEditOf } from './shared';

/**
 * "Find where X lives, then fix it" — the locate half matters as much as the
 * edit half. The prompt deliberately doesn't name the file; the agent must
 * search (or list+read its way there), then patch the right line.
 */
const CLIENT = [
  'export const DEFAULT_TIMEOUT_MS = 500;',
  '',
  'export function fetchWithTimeout(url: string): Promise<Response> {',
  '  return fetch(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });',
  '}',
  ''
].join('\n');

const RETRY = [
  "import { DEFAULT_TIMEOUT_MS } from './client';",
  '',
  'export const RETRY_BUDGET_MS = DEFAULT_TIMEOUT_MS * 3;',
  ''
].join('\n');

export const fixture: Fixture = {
  id: 'search.then_edit',
  description: 'Locate a constant by searching, then fix its value in the file that defines it',
  prompt: 'The request timeout is too low. Find where DEFAULT_TIMEOUT_MS is defined and change it from 500 to 5000.',
  setup: {
    files: {
      'src/net/client.ts': CLIENT,
      'src/net/retry.ts': RETRY,
      'README.md': '# net utils\n'
    }
  },
  assertions: {
    mustCallAllOf: [
      // Locate it — with the search tools or the shell equivalent.
      [{ name: /^(search_code|list_files|read_file|ls)$/ }, SHELL_LISTING],
      targetedEditOf('client.ts')
    ],
    mustNotCall: ['write_file'],
    // The definition changed, and only the definition.
    finalFiles: {
      'src/net/client.ts': CLIENT.replace('= 500;', '= 5000;'),
      'src/net/retry.ts': RETRY
    },
    maxIterations: 6
  },
  runs: 3,
  passThreshold: 2
};

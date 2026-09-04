import type { Fixture } from '../types';

/**
 * "Find where X lives, then fix it" — the locate half matters as much as the
 * edit half. The prompt deliberately doesn't name the file; the agent must
 * search (or list+read its way there), then patch the right line.
 */
export const fixture: Fixture = {
  id: 'search.then_edit',
  description: 'Locate a constant by searching, then fix its value in the file that defines it',
  prompt: 'The request timeout is too low. Find where DEFAULT_TIMEOUT_MS is defined and change it from 500 to 5000.',
  setup: {
    files: {
      'src/net/client.ts': [
        'export const DEFAULT_TIMEOUT_MS = 500;',
        '',
        'export function fetchWithTimeout(url: string): Promise<Response> {',
        '  return fetch(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });',
        '}',
        ''
      ].join('\n'),
      'src/net/retry.ts': [
        "import { DEFAULT_TIMEOUT_MS } from './client';",
        '',
        'export const RETRY_BUDGET_MS = DEFAULT_TIMEOUT_MS * 3;',
        ''
      ].join('\n'),
      'README.md': '# net utils\n'
    }
  },
  assertions: {
    mustCallAllOf: [
      { name: /^(search_code|list_files|read_file)$/ },
      { name: /^(apply_edit|replace_range)$/, params: { path: /client\.ts/ } }
    ],
    mustNotCall: ['write_file'],
    maxIterations: 6
  },
  runs: 3,
  passThreshold: 2
};

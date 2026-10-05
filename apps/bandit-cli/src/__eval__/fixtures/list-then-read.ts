import type { Fixture } from '../types';
import { SHELL_LISTING, WRITE_TOOLS } from './shared';

/**
 * Discovery: "what's in here?" requires listing first, then reading the file
 * that matters. Tests the explore→focus sequence rather than blind guessing
 * at paths.
 */
export const fixture: Fixture = {
  id: 'discover.list_then_read',
  description: 'List a directory, then read the relevant file to describe it',
  prompt: 'Look in the scripts/ directory and explain what the deploy script actually does, step by step.',
  setup: {
    files: {
      'scripts/deploy.sh': [
        '#!/bin/sh',
        'set -e',
        'npm run build',
        'rsync -az dist/ deploy@prod:/var/www/app/',
        'ssh deploy@prod "systemctl restart app"',
        ''
      ].join('\n'),
      'scripts/clean.sh': '#!/bin/sh\nrm -rf dist\n',
      'README.md': '# app\n'
    }
  },
  assertions: {
    // Discovery (list/search) + a read of the script by ANY read path; the
    // outcome must describe the real steps (both the sync and the restart).
    mustCallAllOf: [
      // Discovery, by the listing tools or the shell (`ls scripts`, `find scripts`).
      [{ name: /^(list_files|ls|search_code)$/ }, SHELL_LISTING],
      { name: /^(read_file|run_command)$/ }
    ],
    mustNotCall: WRITE_TOOLS,
    finalResponseMatches: /(?=[\s\S]*rsync)(?=[\s\S]*(restart|systemctl))/i,
    maxIterations: 5
  },
  runs: 3,
  passThreshold: 2
};

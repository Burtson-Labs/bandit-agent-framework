import type { Fixture } from '../types';

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
    mustCallAllOf: [
      { name: /^(list_files|ls|search_code)$/ },
      { name: 'read_file', params: { path: /deploy\.sh/ } }
    ],
    mustNotCall: ['write_file', 'apply_edit', 'run_command'],
    finalResponseMatches: /rsync|build|restart/i,
    maxIterations: 5
  },
  runs: 3,
  passThreshold: 2
};

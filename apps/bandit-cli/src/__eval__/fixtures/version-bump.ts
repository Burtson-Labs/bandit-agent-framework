import type { Fixture } from '../types';

/**
 * The canonical decisive-small-edit: "bump the version". A patch bump has a
 * strong convention (0.9.40 → 0.9.41); the agent should read, compute, and
 * patch the one line — not ask which version, not rewrite the manifest.
 */
export const fixture: Fixture = {
  id: 'edit.version_bump',
  description: 'Patch-bump the version in package.json via a targeted edit',
  prompt: 'Bump the patch version in package.json.',
  setup: {
    files: {
      'package.json': JSON.stringify(
        {
          name: 'sample-app',
          version: '0.9.40',
          scripts: { build: 'tsc -p .' },
          dependencies: { axios: '^1.6.0' }
        },
        null,
        2
      )
    }
  },
  assertions: {
    mustCallAllOf: [
      { name: 'read_file', params: { path: /package\.json/ } },
      {
        name: /^(apply_edit|replace_range)$/,
        params: { path: /package\.json/ }
      }
    ],
    mustNotCall: ['write_file'],
    finalResponseMatches: /0\.9\.41/,
    maxIterations: 5
  },
  runs: 3,
  passThreshold: 2
};

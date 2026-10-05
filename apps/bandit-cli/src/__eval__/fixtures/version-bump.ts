import type { Fixture } from '../types';
import { targetedEditOf } from './shared';

/**
 * The canonical decisive-small-edit: "bump the version". A patch bump has a
 * strong convention (0.9.40 → 0.9.41); the agent should read, compute, and
 * patch the one line — not ask which version, not rewrite the manifest.
 */
const manifest = (version: string): string => JSON.stringify(
  {
    name: 'sample-app',
    version,
    scripts: { build: 'tsc -p .' },
    dependencies: { axios: '^1.6.0' }
  },
  null,
  2
);

export const fixture: Fixture = {
  id: 'edit.version_bump',
  description: 'Patch-bump the version in package.json via a targeted edit',
  prompt: 'Bump the patch version in package.json.',
  setup: {
    files: {
      'package.json': manifest('0.9.40')
    }
  },
  assertions: {
    mustCallAllOf: [
      { name: 'read_file', params: { path: /package\.json/ } },
      targetedEditOf('package.json')
    ],
    mustNotCall: ['write_file'],
    // The manifest itself is the answer: 0.9.41 and nothing else changed. (This
    // replaces a check that the reply quoted "0.9.41", which failed a correct
    // edit summarized as "bumped the patch version".)
    finalFiles: { 'package.json': manifest('0.9.41') },
    maxIterations: 5
  },
  runs: 3,
  passThreshold: 2
};

import type { Fixture } from '../types';

/**
 * "Stash" is two things now. Bandit's cloud file feature (formerly Artifacts) was
 * renamed Bandit Stash, and the always-on git skill ships `git_stash`, which shelves
 * uncommitted working-tree changes. A user asking to "save report.html to my stash"
 * means the Bandit Stash: the right call is publish_artifact with that path. Running
 * git_stash (or `git stash` through run_command) would quietly shelve the user's
 * uncommitted work instead — the failure this fixture exists to catch.
 *
 * The Stash tools are registered with their real host-kit descriptions and an
 * offline execute (Fixture.stashTools), so the model sees exactly what a signed-in
 * host shows it.
 */
const REPORT_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>Q3 Report</title></head>',
  '<body><h1>Q3 Report</h1><p>Revenue up 12%.</p></body>',
  '</html>',
  ''
].join('\n');

export const fixture: Fixture = {
  id: 'stash.save_not_git_stash',
  description: '"Save report.html to my stash" saves to the Bandit Stash (publish_artifact), never git stash',
  prompt: 'Save report.html to my stash.',
  stashTools: true,
  maxIterations: 4,
  setup: {
    files: {
      'report.html': REPORT_HTML,
      'src/app.ts': 'export const answer = 42;\n'
    }
  },
  assertions: {
    mustCallAnyOf: [{ name: 'publish_artifact', params: { path: /(^|\/)report\.html$/ } }],
    mustNotCall: ['git_stash', { name: 'run_command', params: { commandLine: /\bgit\s+stash\b/ } }]
  }
};

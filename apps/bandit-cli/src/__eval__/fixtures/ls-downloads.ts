import type { Fixture } from '../types';

/**
 * "What is in my downloads" regression test. Small models reliably skipped
 * the glob+cwd combination on list_files for home-dir queries, which is
 * why the `ls` tool exists. The system prompt explicitly tells the model
 * to reach for `ls(path="~/Downloads")` — this fixture keeps that rule
 * from regressing.
 */
export const fixture: Fixture = {
  id: 'ls.home_dir',
  description: 'Home-directory queries should use ls(path=…), not list_files with *',
  prompt: 'What is in my ~/Downloads folder?',
  assertions: {
    mustCallAnyOf: [
      { name: 'ls', params: { path: /Downloads/ } }
    ],
    mustNotCall: [],
    maxIterations: 3
  },
  runs: 3,
  passThreshold: 2
};

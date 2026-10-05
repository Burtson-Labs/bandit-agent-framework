import type { Fixture } from '../types';

/**
 * "What is in my downloads" regression test. Small models reliably skipped
 * the glob+cwd combination on list_files for home-dir queries, which is
 * why the `ls` tool exists. The system prompt explicitly tells the model
 * to reach for `ls(path="~/Downloads")` — this fixture keeps that rule
 * from regressing.
 *
 * `~` is the sandbox's own home directory, provisioned below; the real
 * ~/Downloads is never listed. The answer has to name something that is
 * actually in the folder.
 */
export const fixture: Fixture = {
  id: 'ls.home_dir',
  description: 'Home-directory queries should use ls(path=…), not list_files with *',
  prompt: 'What is in my ~/Downloads folder?',
  setup: {
    homeFiles: {
      'Downloads/quarterly-report.pdf': 'placeholder\n',
      'Downloads/team-offsite-photos.zip': 'placeholder\n',
      'Downloads/installer-notes.txt': 'placeholder\n'
    }
  },
  assertions: {
    mustCallAnyOf: [
      { name: 'ls', params: { path: /Downloads/ } }
    ],
    mustNotCall: [],
    finalResponseMatches: /quarterly-report|team-offsite-photos|installer-notes/i,
    maxIterations: 3
  },
  runs: 3,
  passThreshold: 2
};

import type { Fixture } from '../types';

/**
 * The "check the last commit of a repo that's not my cwd" regression test.
 * Previously: git_* tools were pinned to the workspace root, so asking
 * "check the last commit of ~/Documents/github/X" from a bandit session
 * started in ~ would dead-end with "not a git repository". With repo_path
 * on every git_* tool, this should flow cleanly — as long as the system
 * prompt steers the model to pass repo_path when a different repo is named.
 *
 * The other repository is real: the sandbox provisions it under its own home
 * (`~/projects/some-other-project`, a sibling of the workspace) with two
 * commits, so the call succeeds and the answer can be checked. The fixture
 * used to name `/tmp/some-other-project`, which no run could ever reach.
 */
const LATEST = 'Fix pagination off-by-one in the audit export';

export const fixture: Fixture = {
  id: 'git_log.repo_path',
  description: 'Checking a commit in a non-workspace repo must pass repo_path',
  prompt: 'Check the latest commit of the repo at ~/projects/some-other-project and tell me the message.',
  setup: {
    gitRepos: {
      'projects/some-other-project': {
        commits: [
          { message: 'Initial import', files: { 'README.md': '# some other project\n' } },
          { message: LATEST, files: { 'src/audit-export.js': 'exports.pageCount = (rows, size) => Math.ceil(rows / size);\n' } }
        ]
      }
    }
  },
  assertions: {
    mustCallAnyOf: [
      { name: 'git_log', params: { repo_path: /some-other-project/ } },
      // Acceptable fallback: git through run_command, pointed at that repo with
      // -C or cwd. Models trained on raw shell sometimes reach for that before
      // the first-class tool, and functionally it's the same answer. A bare
      // `git log` in the workspace is the wrong repository and does not count.
      { name: 'run_command', params: { commandLine: /^git\b.*-C\s+\S*some-other-project/ } },
      { name: 'run_command', params: { commandLine: /^git\b/, cwd: /some-other-project/ } }
    ],
    // \W+ rather than a hyphen: gpt-oss writes "off‑by‑one" with non-breaking hyphens.
    finalResponseMatches: /pagination\W+off\W+by\W+one/i,
    maxIterations: 4
  },
  runs: 3,
  passThreshold: 2
};

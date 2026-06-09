import type { Fixture } from '../types';

/**
 * The "check the last commit of a repo that's not my cwd" regression test.
 * Previously: git_* tools were pinned to the workspace root, so asking
 * "check the last commit of ~/Documents/github/X" from a bandit session
 * started in ~ would dead-end with "not a git repository". With repo_path
 * on every git_* tool, this should flow cleanly — as long as the system
 * prompt steers the model to pass repo_path when a different repo is named.
 *
 * The fixture doesn't need a real repo on disk — we're checking the model's
 * CHOICE, not git's output. The runCommand will return an error from the
 * sandbox but the tool-call trace is what we grade.
 */
export const fixture: Fixture = {
  id: 'git_log.repo_path',
  description: 'Checking a commit in a non-workspace repo must pass repo_path',
  prompt: 'Check the latest commit of the repo at /tmp/some-other-project and tell me the message.',
  assertions: {
    mustCallAnyOf: [
      { name: 'git_log', params: { repo_path: /some-other-project/ } },
      // Acceptable fallback: run_command git -C <path> log. Models trained
      // on raw shell sometimes reach for that before the first-class tool,
      // and functionally it's the same answer.
      { name: 'run_command', params: { cmd: 'git', args: /(-C\s+.*some-other-project|log)/ } }
    ],
    maxIterations: 4
  },
  runs: 3,
  passThreshold: 2
};

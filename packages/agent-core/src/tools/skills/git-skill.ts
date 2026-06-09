/**
 * Git skill — always active.
 * Wraps the 9 git tools: status, diff, log, commit (original four),
 * plus branch, checkout, stash, pull, push (added to close
 * real collaborative-workflow gaps the agent could only fudge through
 * raw run_command before).
 */

import type { SkillManifest } from '../skill-types';
import {
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  gitBranchTool,
  gitCheckoutTool,
  gitStashTool,
  gitPullTool,
  gitPushTool
} from '../git-tools';

export const gitSkill: SkillManifest = {
  id: 'core/git',
  name: 'Git',
  version: '1.1.0',
  description: 'Check status, view diffs, read commit history, create commits, manage branches and stashes, pull/push to remotes.',
  activation: 'always',
  tools: [
    gitStatusTool,
    gitDiffTool,
    gitLogTool,
    gitCommitTool,
    gitBranchTool,
    gitCheckoutTool,
    gitStashTool,
    gitPullTool,
    gitPushTool
  ]
};

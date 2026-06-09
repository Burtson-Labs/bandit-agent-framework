/**
 * Barrel for eval fixtures. New fixtures: drop a file in this folder, then
 * add it here. Fixtures are imported explicitly (not auto-discovered) so
 * the esbuild bundle stays static and the runner is deterministic about
 * which fixtures it knows about.
 */

import { fixture as applyEditSmallChange } from './apply-edit-small-change';
import { fixture as gitLogRepoPath } from './git-log-repo-path';
import { fixture as markdownSkillCreation } from './markdown-skill-creation';
import { fixture as lsDownloads } from './ls-downloads';
import { fixture as multiFileEdit } from './multi-file-edit';
import { fixture as longWriteNoLoop } from './long-write-no-loop';
import { fixture as hallucinateEditWithoutTool } from './hallucinate-edit-without-tool';
import { fixture as hallucinateCodeFenceProse } from './hallucinate-code-fence-prose';
import { fixture as deferOnParseError } from './defer-on-parse-error';
import { fixture as proseLoopNoTools } from './prose-loop-no-tools';
import { fixture as todoChurnBreaker } from './todo-churn-breaker';
import { fixture as scopeAndPathDiscipline } from './scope-and-path-discipline';
import { fixture as nativeToolsMultiFileDoc } from './native-tools-multi-file-doc';
import type { Fixture } from '../types';

export const allFixtures: Fixture[] = [
  applyEditSmallChange,
  gitLogRepoPath,
  markdownSkillCreation,
  lsDownloads,
  multiFileEdit,
  longWriteNoLoop,
  hallucinateEditWithoutTool,
  hallucinateCodeFenceProse,
  deferOnParseError,
  proseLoopNoTools,
  todoChurnBreaker,
  scopeAndPathDiscipline,
  nativeToolsMultiFileDoc
];

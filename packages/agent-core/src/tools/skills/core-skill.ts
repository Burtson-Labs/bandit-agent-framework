/**
 * Core filesystem skill — always active.
 * Wraps the core tools: read_file, write_file, apply_edit, replace_range,
 * apply_patch, list_files, ls, find_directory, search_code, run_command,
 * watch_command. `apply_edit` is the preferred path for targeted
 * find/replace changes; `replace_range` covers large-file line ranges;
 * `apply_patch` is the multi-file envelope for batch edits; `find_directory` covers cross-repo discovery so the
 * agent can locate sibling repos without asking the user where they
 * live.
 */

import type { SkillManifest } from '../skill-types';
import { readFileTool, writeFileTool, applyEditTool, replaceRangeTool, applyPatchTool, listFilesTool, lsTool, findDirectoryTool, searchCodeTool, runCommandTool, watchCommandTool } from '../core-tools';

export const coreSkill: SkillManifest = {
  id: 'core/filesystem',
  name: 'Filesystem & Shell',
  version: '1.0.0',
  description: 'Read, write, search files and run shell commands in the workspace.',
  activation: 'always',
  tools: [readFileTool, writeFileTool, applyEditTool, replaceRangeTool, applyPatchTool, listFilesTool, lsTool, findDirectoryTool, searchCodeTool, runCommandTool, watchCommandTool]
};

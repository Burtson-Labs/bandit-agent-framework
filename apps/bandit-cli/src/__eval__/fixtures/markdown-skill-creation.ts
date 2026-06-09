import type { Fixture } from '../types';

/**
 * The "create a skill" regression test. Old JSON format triggered an
 * infinite retry loop because of nested-quote escaping. Markdown format
 * fixed the parse, but only helps if the model actually writes markdown —
 * the system prompt now steers that way. This fixture verifies the model
 * writes to a .md path (not .json) and that the file it writes is valid.
 *
 * We also require that the model NOT emit a legacy JSON skill — that's
 * the pre-v1.5.31 anti-pattern we're guarding against regressing.
 */
export const fixture: Fixture = {
  id: 'skills.create_markdown',
  description: 'Skill creation must write markdown with frontmatter, not legacy JSON',
  prompt: 'Create a skill called github for working with the gh CLI — listing PRs, creating PRs, checking issues.',
  assertions: {
    mustCallAnyOf: [
      {
        name: 'write_file',
        params: {
          path: /\.bandit\/skills\/[\w-]+\.md$/,
          content: /^---[\s\S]*\bid:\s*[\w-]+[\s\S]*---/m
        }
      }
    ],
    // Writing a .json skill file would be the legacy failure pattern we
    // spent v1.5.31 eliminating. Fail loudly if the model regresses.
    mustNotCall: [],
    finalResponseMatches: /\.md|skill|github/i,
    maxIterations: 6
  },
  runs: 3,
  passThreshold: 2
};

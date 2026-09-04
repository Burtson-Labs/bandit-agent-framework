import type { Fixture } from '../types';

/**
 * Restraint: a pure-knowledge question needs ZERO tools. Reaching for
 * read_file/list_files on "what does HTTP 404 mean" burns iterations and
 * reads as flailing — the agent should just answer.
 */
export const fixture: Fixture = {
  id: 'restraint.no_tools_needed',
  description: 'A general-knowledge question is answered directly with no tool calls',
  prompt: 'In one sentence, what does an HTTP 404 status code mean?',
  setup: {
    files: { 'notes.md': '# scratch\n' }
  },
  assertions: {
    mustNotCall: ['read_file', 'list_files', 'ls', 'search_code', 'run_command', 'write_file', 'apply_edit'],
    finalResponseMatches: /not found|does not exist|doesn't exist|couldn't .*find|cannot .*find|no .*resource/i,
    maxIterations: 2
  },
  runs: 3,
  passThreshold: 2
};

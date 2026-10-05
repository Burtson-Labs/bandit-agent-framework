import type { Fixture } from '../types';
import { EXPLAINS_NOT_FOUND } from './shared';

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
    // ZERO tools means zero: any call at all is the failure.
    mustNotCall: [{ name: /./ }],
    // Any correct phrasing of "the server has nothing at that address" —
    // "could not be found" and a typographic "doesn’t exist" included.
    finalResponseMatches: EXPLAINS_NOT_FOUND,
    maxIterations: 2
  },
  runs: 3,
  passThreshold: 2
};

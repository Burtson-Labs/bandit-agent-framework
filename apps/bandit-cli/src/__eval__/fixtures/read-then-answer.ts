import type { Fixture } from '../types';

/**
 * The single most common real task: "look at X and tell me Y". Must read the
 * file and extract the right value — no edits, no wandering.
 */
export const fixture: Fixture = {
  id: 'read.then_answer',
  description: 'Read a config file and answer a question from its contents without editing anything',
  prompt: 'What port does the server listen on according to config/settings.json?',
  setup: {
    files: {
      'config/settings.json': JSON.stringify(
        { server: { host: '0.0.0.0', port: 4187, tls: false }, logLevel: 'info' },
        null,
        2
      )
    }
  },
  assertions: {
    // Any read path counts (read_file, cat via run_command, search) — the
    // OUTCOME is the assertion: the right port, no edits.
    mustCallAnyOf: [{ name: /^(read_file|run_command|search_code|list_files|ls)$/ }],
    mustNotCall: ['write_file', 'apply_edit', 'replace_range', 'apply_patch'],
    finalResponseMatches: /4187/,
    maxIterations: 4
  },
  runs: 3,
  passThreshold: 2
};

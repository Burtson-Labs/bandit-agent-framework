import type { Fixture } from '../types';

/**
 * Synthesis over multiple sources: comparing two files means reading BOTH —
 * answering from one (or neither) is the failure. The answer must name the
 * actual difference.
 */
export const fixture: Fixture = {
  id: 'read.multi_synthesis',
  description: 'Read two config files and accurately state how they differ',
  prompt: 'Compare config/dev.json and config/prod.json — what settings differ between them?',
  setup: {
    files: {
      'config/dev.json': JSON.stringify({ apiUrl: 'http://localhost:4000', cache: false, logLevel: 'debug' }, null, 2),
      'config/prod.json': JSON.stringify({ apiUrl: 'https://api.example.com', cache: true, logLevel: 'warn' }, null, 2)
    }
  },
  assertions: {
    // Any read path is fine; the OUTCOME must name all three differing
    // settings — answering from one file (or guessing) can't produce that.
    mustCallAnyOf: [{ name: /^(read_file|run_command|search_code)$/ }],
    mustNotCall: ['write_file', 'apply_edit'],
    finalResponseMatches: /(?=[\s\S]*cache)(?=[\s\S]*logLevel)(?=[\s\S]*api[Uu]rl)/,
    maxIterations: 5
  },
  runs: 3,
  passThreshold: 2
};

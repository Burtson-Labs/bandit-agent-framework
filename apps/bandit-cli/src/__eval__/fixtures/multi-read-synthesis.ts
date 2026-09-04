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
    mustCallAllOf: [
      { name: 'read_file', params: { path: /dev\.json/ } },
      { name: 'read_file', params: { path: /prod\.json/ } }
    ],
    mustNotCall: ['write_file', 'apply_edit'],
    finalResponseMatches: /cache|logLevel|apiUrl/i,
    maxIterations: 5
  },
  runs: 3,
  passThreshold: 2
};

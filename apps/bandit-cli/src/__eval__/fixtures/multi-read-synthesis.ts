import type { Fixture, ToolCallSpec } from '../types';
import { WRITE_TOOLS } from './shared';

/** A read of config/<name>.json by any route: read_file, a shell command that names it
 *  (or globs the directory), or a content search. */
const readOf = (name: string): ToolCallSpec[] => [
  { name: 'read_file', params: { path: new RegExp(`${name}\\.json`) } },
  { name: 'run_command', params: { commandLine: new RegExp(`${name}\\.json|config/\\*|\\{[^}]*${name}[^}]*\\}`) } },
  { name: 'search_code' }
];

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
    // Any read path is fine, but BOTH files have to be read: one file on its
    // own already contains all three key names, so the reply alone cannot
    // prove the comparison happened.
    mustCallAllOf: [readOf('dev'), readOf('prod')],
    mustNotCall: WRITE_TOOLS,
    // The reply names all three differing settings, however it spells them
    // ("apiUrl", "API URL", "log level", "caching").
    finalResponseMatches: /(?=[\s\S]*cach)(?=[\s\S]*log[\s_-]?level)(?=[\s\S]*api[\s_-]?url)/i,
    maxIterations: 5
  },
  runs: 3,
  passThreshold: 2
};

import type { Fixture } from '../types';

/**
 * Creation is the one case where write_file IS the right tool. Also checks
 * the agent lands the file where asked instead of inventing a path.
 */
export const fixture: Fixture = {
  id: 'write.create_new_file',
  description: 'Create a brand-new file at the requested path with write_file',
  prompt: 'Create a file at src/utils/clamp.ts exporting a clamp(value, min, max) function that keeps value within [min, max]. TypeScript, no dependencies.',
  setup: {
    files: {
      'src/index.ts': 'export {};\n'
    }
  },
  assertions: {
    mustCallAnyOf: [{ name: 'write_file', params: { path: /src\/utils\/clamp\.ts$/ } }],
    maxIterations: 4
  },
  runs: 3,
  passThreshold: 2
};

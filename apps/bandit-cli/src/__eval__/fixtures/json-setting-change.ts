import type { Fixture } from '../types';

/**
 * Structured-file discipline: flip one JSON setting with a targeted edit.
 * The classic failure is rewriting the whole file (dropping keys along the
 * way) or corrupting quoting — a surgical apply_edit avoids both.
 */
export const fixture: Fixture = {
  id: 'edit.json_setting_change',
  description: 'Flip one boolean in a JSON config via targeted edit, not a rewrite',
  prompt: 'In config/features.json, enable darkMode (set it to true). Change nothing else.',
  setup: {
    files: {
      'config/features.json': JSON.stringify(
        { darkMode: false, betaSearch: true, telemetry: false, maxUploadMb: 25 },
        null,
        2
      )
    }
  },
  assertions: {
    mustCallAnyOf: [
      {
        name: /^(apply_edit|replace_range)$/,
        params: { path: /features\.json/ }
      }
    ],
    mustNotCall: ['write_file'],
    maxIterations: 4
  },
  runs: 3,
  passThreshold: 2
};

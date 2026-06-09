import type { Fixture } from '../types';

/**
 * The "writing long content with embedded quotes" regression test. This is
 * the exact pathway that used to trigger the infinite retry loop: the
 * model emits a write_file whose `content` string contains unescaped `"`
 * chars, the JSON parses into a truncated string, the write lands corrupt,
 * and the model keeps retrying. v1.5.30 added the circuit breaker; this
 * fixture exercises a file shape that tends to provoke the problem
 * (a TS object literal with embedded string values carrying quotes) and
 * asserts the agent terminates cleanly — either by getting the write
 * right, or by hitting the breaker after 3 attempts and producing a
 * helpful final answer rather than grinding to max iterations.
 */
export const fixture: Fixture = {
  id: 'write.long_content_terminates',
  description: 'Writing long content with embedded quotes must terminate, not loop',
  prompt:
    'Create a new file config.ts that exports a const named `LABELS` containing ' +
    '5 key/value pairs where each value is a short sentence including the character `"`. ' +
    'Example: `intro: "Welcome to \\"Bandit\\""`.',
  assertions: {
    // Success condition: the loop finishes. We don't care whether the
    // content was perfect — we care that the agent did NOT hit the loop
    // iteration cap (maxIterations=8). Finishing under that bound means
    // the circuit breaker fired OR the write actually succeeded. Either
    // outcome is a pass; grinding to limit is a regression.
    maxIterations: 7,
    finalResponseMatches: /./
  },
  runs: 3,
  passThreshold: 2,
  maxIterations: 8
};

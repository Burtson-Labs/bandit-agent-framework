#!/usr/bin/env node
/**
 * Executable entry for deterministic publish + email.
 *
 * Split from `publishEmail.ts` so importing the logic (tests) cannot publish or
 * send mail as a side effect — the esbuild output is ESM with no
 * `require.main === module` guard.
 */

import { main } from './publishEmail';

main().catch((err) => {
  process.stderr.write(`publish-email crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

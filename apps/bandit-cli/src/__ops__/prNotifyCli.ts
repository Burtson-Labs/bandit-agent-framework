#!/usr/bin/env node
/**
 * Executable entry for the self-improve PR notification.
 *
 * Split from `prNotify.ts` for the same reason the nightly brief is split:
 * the esbuild output is ESM with no `require.main === module` guard, so
 * importing the logic module would otherwise publish and send email as a
 * side effect of being imported by a test.
 */

import { main } from './prNotify';

main().catch((err) => {
  process.stderr.write(`pr-notify crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Executable entry for the nightly-brief fallback.
 *
 * Kept to a shebang and a call so every testable line lives in `briefRun.ts`
 * — importing this file would otherwise fire the whole brief as a side effect.
 * The esbuild output is ESM, where the usual `require.main === module` guard
 * does not exist, so separation (not a guard) is what makes the logic
 * importable.
 *
 * Flags:
 *   --eval-json <path>   `eval --json-out` output (fixture pass/fail + reasons)
 *   --bench-json <path>  THIS run's `benchmark --baseline` output
 *   --baseline <path>    the frozen baseline to diff against
 *   --to <email>         recipient; repeatable. Defaults to the team pair.
 *   --out <path>         where the HTML is written before publishing
 *   --dry-run            render + report what WOULD be sent; no network calls
 */

import { main } from './briefRun';

main().catch((err) => {
  process.stderr.write(`nightly brief crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

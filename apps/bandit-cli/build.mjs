/**
 * Bundle the CLI with esbuild so the published package ships as a single
 * self-contained dist/cli.js with no runtime @burtson-labs/* dependencies.
 *
 * Why: workspace deps (agent-core, host-kit, stealth-core-runtime) get
 * translated by pnpm publish to concrete version pins in the published
 * package.json. If those pinned versions aren't on the registry (the
 * bandit-engine ownership issue we hit), npm/pnpm fail to install the CLI.
 *
 * By bundling, the three workspace packages' code becomes inlined into
 * dist/cli.js at build time. The published package.json has no @burtson-labs
 * deps — only `pdf-parse` (public npm) remains external because it loads
 * its worker via dynamic require and doesn't bundle cleanly.
 *
 * Modes:
 *   node build.mjs              # dev: cli + smoke + integration + eval
 *   node build.mjs --publish    # publish: cli.js only (ships to npm)
 *
 * The `--publish` variant is what `prepublishOnly` runs, so the tarball
 * never carries test/eval harnesses.
 */

import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

const publishOnly = process.argv.includes('--publish');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  // ESM output. Switched from CJS in v1.7.307 because ink v7 and
  // yoga-layout v3 both use top-level await, which esbuild's CJS
  // output cannot express. The source has a handful of legacy
  // `require()` calls (dynamic package.json reads, conditional
  // module loads); the banner below polyfills `require` from
  // `module.createRequire` so they keep working at runtime.
  format: 'esm',
  // pdf-parse uses dynamic require() for its pdfjs worker and embedded
  // assets — bundling it confuses esbuild's require-resolution. Keep it
  // external and let npm install it as a peer at install time.
  external: ['pdf-parse'],
  // react-devtools-core is an optional peer of ink; we never enable
  // the devtools, but ink statically imports the module at the top of
  // its devtools.js. Aliasing it to an empty stub keeps the import
  // resolvable while shipping zero devtools code in the bundle.
  alias: {
    'react-devtools-core': new URL('./scripts/empty-stub.mjs', import.meta.url).pathname
  },
  // ESM doesn't have `require`, `__dirname`, or `__filename`. The CLI
  // source uses `require('../package.json')` etc. The banner exposes
  // a CJS-style `require` so those call sites keep working without
  // a file-by-file rewrite.
  banner: {
    // Polyfill the CJS-only globals our bundled deps (TypeScript,
    // others) still reach for. Without this, anything that calls
    // `require()`, reads `__filename`, or resolves a sibling file
    // via `__dirname` crashes at module init in ESM.
    js: [
      "import { createRequire as __bandit_createRequire } from 'module';",
      "import { fileURLToPath as __bandit_fileURLToPath } from 'url';",
      "import { dirname as __bandit_dirname } from 'path';",
      "const require = __bandit_createRequire(import.meta.url);",
      "const __filename = __bandit_fileURLToPath(import.meta.url);",
      "const __dirname = __bandit_dirname(__filename);"
    ].join(' ')
  },
  // ink components live in .tsx; the automatic JSX runtime lets us
  // skip the `import * as React from 'react'` boilerplate per file.
  jsx: 'automatic',
  jsxImportSource: 'react',
  loader: { '.tsx': 'tsx' },
  // Shave ~40% off the bundle by dropping whitespace/comments/unused code.
  // Stacks traces still work fine for our size — we map only on demand.
  minify: true,
  // Good enough error locations without shipping full sourcemaps in prod.
  keepNames: true,
  logLevel: 'info'
};

const publishEntries = [
  {
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/cli.js',
    // src/cli.ts already has a #!/usr/bin/env node shebang on its first
    // line; esbuild preserves it through the bundle. Adding a `banner`
    // would duplicate it and break Node's parser.
    executable: true
  }
];

const devEntries = [
  {
    entryPoints: ['src/__smoke__/smoke.ts'],
    outfile: 'dist/__smoke__/smoke.js'
  },
  {
    entryPoints: ['src/__integration__/ollama.ts'],
    outfile: 'dist/__integration__/ollama.js'
  },
  {
    entryPoints: ['src/__eval__/eval.ts'],
    outfile: 'dist/__eval__/eval.js'
  },
  {
    entryPoints: ['src/__eval__/benchmark.ts'],
    outfile: 'dist/__eval__/benchmark.js'
  },
  {
    // Turn-view demo (Phase 1 checkpoint, docs/ink-turn-view-plan.md).
    // Dev-only — never ships in the publish tarball.
    entryPoints: ['src/__demo__/turnViewDemo.tsx'],
    outfile: 'dist/__demo__/turn-view-demo.js'
  }
];

const entries = publishOnly ? publishEntries : [...publishEntries, ...devEntries];

for (const entry of entries) {
  const { executable, ...opts } = entry;
  await build({ ...common, ...opts });
  if (executable) {
    chmodSync(opts.outfile, 0o755);
  }
}

console.log(publishOnly ? '✓ bundled (publish)' : '✓ bundled');

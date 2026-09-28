#!/usr/bin/env node
// Bundles the extension host entry (src/extension.ts) and everything it
// imports — the @burtson-labs/* workspace packages, the MCP SDK, TypeScript,
// zod — into one file, out/extension.js. Only `vscode` and Node built-ins
// stay external.
//
// Why a bundle and not node_modules in the VSIX: the workspace packages are
// `workspace:*` dependencies, which exist only inside this monorepo. Shipping
// them meant copying pnpm's symlinked node_modules into the package, and
// 1.7.448 went to the Marketplace with that copy empty — the extension host
// then failed on `require('@burtson-labs/agent-adapters-vscode')` and the
// panel stayed blank. A bundle has no node_modules to get wrong, and
// scripts/verify-vsix.cjs refuses to package anything that still needs one.
//
//   node scripts/bundle-extension.cjs           # release build (no source map)
//   node scripts/bundle-extension.cjs --watch   # rebuild on change, with a source map
const path = require('node:path');
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const packageRoot = path.resolve(__dirname, '..');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(packageRoot, 'src', 'extension.ts')],
  outfile: path.join(packageRoot, 'out', 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // VS Code ^1.75 ships Node 16+; the current engine is Node 20/22. ES2020
  // matches tsconfig's target so the bundle runs on every supported host.
  target: ['node16', 'es2020'],
  mainFields: ['main', 'module'],
  conditions: ['node', 'require', 'default'],
  external: ['vscode'],
  sourcemap: watch ? 'linked' : false,
  minify: false,
  keepNames: true,
  legalComments: 'none',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
  // pdfjsShim patches Module._resolveFilename for 'pdfjs-dist' at runtime
  // (it is never bundled); nothing else is loaded by name at runtime.
  logOverride: { 'require-resolve-not-external': 'silent' },
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('bundle-extension: watching src/ → out/extension.js');
    return;
  }
  const result = await esbuild.build({ ...options, metafile: true });
  const out = result.metafile.outputs[path.relative(process.cwd(), options.outfile)] ?? Object.values(result.metafile.outputs)[0];
  console.log(`bundle-extension: out/extension.js (${(out.bytes / 1024 / 1024).toFixed(1)} MB, ${Object.keys(result.metafile.inputs).length} modules)`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

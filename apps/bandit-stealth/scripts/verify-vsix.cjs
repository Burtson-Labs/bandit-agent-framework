#!/usr/bin/env node
// Refuses a VSIX that would fail on a clean install. Run by build-vsix.cjs on
// every package and by CI before anything is published.
//
//   node scripts/verify-vsix.cjs [bandit-stealth.vsix]
//
// It checks the things that broke 1.7.448 (a manifest still carrying
// `workspace:*` and an empty node_modules) and the things a bundle build can
// get wrong (an unbundled require, a missing asset).
const path = require('node:path');
const AdmZip = require('adm-zip');

const BUILTINS = new Set(require('node:module').builtinModules);
const vsixPath = path.resolve(process.argv[2] ?? 'bandit-stealth.vsix');
const zip = new AdmZip(vsixPath);
const entries = new Map(zip.getEntries().map((e) => [e.entryName, e]));
const problems = [];
const read = (name) => entries.get(name)?.getData().toString('utf8');

// 1. The manifest: no workspace protocol, no runtime dependencies at all
//    (everything is bundled), and the entry point the manifest names exists.
const manifestText = read('extension/package.json');
if (!manifestText) {
  problems.push('extension/package.json is missing');
} else {
  if (manifestText.includes('workspace:')) problems.push('extension/package.json still contains a "workspace:" dependency');
  const manifest = JSON.parse(manifestText);
  const deps = Object.keys(manifest.dependencies ?? {});
  if (deps.length) problems.push(`extension/package.json lists runtime dependencies (${deps.join(', ')}); the bundle must carry them`);
  if (manifest.devDependencies) problems.push('extension/package.json still lists devDependencies');
  const main = `extension/${String(manifest.main ?? '').replace(/^\.\//, '')}`;
  if (!entries.has(main)) problems.push(`the manifest's main (${main}) is not in the package`);
}

// 2. The bundle. Two checks, because a generic "any require(\"pkg\")" scan is
//    unreliable here: ajv and TypeScript carry require() calls inside string
//    literals and generated code. (a) no workspace package is required by name
//    — the exact failure of 1.7.448; (b) esbuild's module markers show the
//    packages the extension needs at runtime were inlined.
const bundle = read('extension/out/extension.js');
if (!bundle) {
  problems.push('extension/out/extension.js is missing');
} else {
  const unbundled = [...bundle.matchAll(/require\((["'])(@burtson-labs\/[^"']+)\1\)/g)].map((m) => m[2]);
  if (unbundled.length) problems.push(`out/extension.js still requires workspace packages: ${[...new Set(unbundled)].join(', ')}`);
  for (const marker of [
    'packages/agent-adapters/vscode/',
    'packages/agent-core/',
    'packages/host-kit/',
    'packages/stealth-core-runtime/',
    'node_modules/typescript/lib/typescript.js',
    '@modelcontextprotocol/sdk/',
  ]) {
    if (!new RegExp(`^// .*${marker.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`, 'm').test(bundle)) {
      problems.push(`out/extension.js does not contain ${marker} — the bundle is incomplete`);
    }
  }
}

// 3. No node_modules in the package (a bundle needs none; their presence
//    means the old copy step ran).
const shippedModules = [...entries.keys()].filter((n) => n.startsWith('extension/node_modules/') && !entries.get(n).isDirectory);
if (shippedModules.length) problems.push(`the package ships ${shippedModules.length} node_modules files; the extension is bundled and must not`);

// 4. Assets the extension loads by path at runtime.
for (const asset of [
  'extension/media/webview/webview.js',
  'extension/media/webview/webview.css',
  'extension/media/logo.png',
  'extension/src/python/bandit_agent.py',
  'extension/media/recorders/bandit-mic-darwin',
]) {
  if (!entries.has(asset)) problems.push(`missing asset ${asset}`);
}

// 5. Sources and tests don't ship.
const stray = [...entries.keys()].filter((n) => !entries.get(n).isDirectory && /^extension\/(src\/(?!python\/)|test\/|webview\/|scripts\/|out\/test\/)/.test(n));
if (stray.length) problems.push(`the package ships ${stray.length} source/test files (e.g. ${stray[0]})`);

const sizeMb = require('node:fs').statSync(vsixPath).size / 1024 / 1024;
if (problems.length) {
  console.error(`verify-vsix: ${path.basename(vsixPath)} is not shippable:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`verify-vsix: ${path.basename(vsixPath)} OK — ${entries.size} entries, ${sizeMb.toFixed(1)} MB, bundled, no node_modules, no workspace deps`);

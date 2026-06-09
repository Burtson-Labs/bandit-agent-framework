/**
 * Prepack hook — strips devDependencies and dev-only scripts from the
 * shipped package.json so the npm tarball stays minimal and doesn't
 * reference workspace packages that aren't on the public npm registry.
 *
 * Flow:
 *   1. Back up package.json → package.json.bak
 *   2. Rewrite package.json with a publish-safe projection
 *      (keeps: identity, runtime deps, bin, files, engines, repo metadata)
 *   3. `postpack.mjs` restores the backup after the tarball is produced
 *
 * Running `pnpm pack` or `pnpm publish` calls this automatically via the
 * `prepack` script in package.json.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const PKG = 'package.json';
const BAK = 'package.json.bak';

if (existsSync(BAK)) {
  console.error(`[prepack] ${BAK} already exists — a previous pack run was interrupted. Restore manually and retry.`);
  process.exit(1);
}

copyFileSync(PKG, BAK);

const full = JSON.parse(readFileSync(PKG, 'utf8'));

// Projection of fields worth shipping. Anything not listed here is dropped.
const shipped = {
  name: full.name,
  version: full.version,
  description: full.description,
  keywords: full.keywords,
  homepage: full.homepage,
  bugs: full.bugs,
  repository: full.repository,
  license: full.license,
  author: full.author,
  bin: full.bin,
  main: full.main,
  files: full.files,
  engines: full.engines,
  publishConfig: full.publishConfig,
  dependencies: full.dependencies
};

// Drop undefined keys so the output is tidy.
for (const key of Object.keys(shipped)) {
  if (shipped[key] === undefined) delete shipped[key];
}

writeFileSync(PKG, JSON.stringify(shipped, null, 2) + '\n');
console.log('[prepack] wrote publish-safe package.json (backup at package.json.bak)');

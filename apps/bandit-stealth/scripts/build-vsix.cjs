#!/usr/bin/env node
const { execSync } = require('node:child_process');
const {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const options = {
  preRelease: false,
  out: 'bandit-stealth.vsix'
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--pre') {
    options.preRelease = true;
  } else if (arg === '--out') {
    options.out = args[i + 1] ?? options.out;
    i += 1;
  }
}

const packageRoot = process.cwd();
const repoRoot = path.resolve(packageRoot, '..', '..');
const tempRoot = path.join(packageRoot, '.vsce');
const deployDir = path.join(tempRoot, 'bandit-stealth');
const unpackDir = path.join(tempRoot, 'package');
const vsixPath = path.join(packageRoot, options.out);
const vsceBin = path.join(
  packageRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vsce.cmd' : 'vsce'
);

function run(command, cwd) {
  execSync(command, { stdio: 'inherit', cwd });
}

console.log('Building dependent workspace packages...');
run('pnpm --filter bandit-stealth... --if-present build', repoRoot);

console.log('Building webview bundle...');
run('pnpm run build:webview', packageRoot);

console.log('Compiling TypeScript output...');
run('pnpm run compile', packageRoot);

console.log('Resetting staging directory...');
rmSync(tempRoot, { recursive: true, force: true });
mkdirSync(tempRoot, { recursive: true });

const skipEntries = new Set([
  '.vsce',
  '.turbo',
  '.vscode',
  '.git',
  'node_modules',
  'bandit-stealth.vsix',
  'bandit-stealth-beta.vsix'
]);

function copyWorkspace(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (skipEntries.has(entry.name)) {
      continue;
    }
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyWorkspace(from, to);
    } else if (entry.isSymbolicLink()) {
      cpSync(from, to, { recursive: true, dereference: false });
    } else {
      cpSync(from, to);
    }
  }
}

console.log('Copying workspace files into staging directory...');
copyWorkspace(packageRoot, deployDir);

// node_modules is deliberately NOT copied. Since 1.7.450 the extension host is
// a single esbuild bundle (scripts/bundle-extension.cjs → out/extension.js)
// with the @burtson-labs/* workspace packages, the MCP SDK, TypeScript and
// zod inlined; only `vscode` and Node built-ins are required at runtime.
// The previous approach — copying pnpm's symlinked node_modules with
// dereference: true — shipped 1.7.448 with an EMPTY node_modules/@burtson-labs,
// and the extension failed to activate on every clean install
// ("Cannot find module '@burtson-labs/agent-adapters-vscode'").

const deployedPackageJson = path.join(deployDir, 'package.json');
const deployedPackage = JSON.parse(readFileSync(deployedPackageJson, 'utf8'));
// Everything runtime is inside the bundle, so the published manifest lists no
// dependencies at all — in particular no `workspace:*` entries, which only
// resolve inside this monorepo and which vsce would otherwise copy verbatim.
delete deployedPackage.dependencies;
delete deployedPackage.devDependencies;
delete deployedPackage.scripts;
writeFileSync(deployedPackageJson, JSON.stringify(deployedPackage, null, 2));

console.log('Packaging VSIX...');
const preFlag = options.preRelease ? '--pre-release ' : '';
// Source repo is private, so we deliberately omit the `repository` field
// from package.json (otherwise the marketplace listing's "Repository"
// link 404s for visitors). vsce then can't auto-detect a repo to rewrite
// relative links in README.md / CHANGELOG.md and errors out. Point its
// base URLs at our public marketing page instead — neither doc currently
// uses relative links, but the flags satisfy vsce's preflight check.
const baseUrl = 'https://burtson.ai/stealth';
run(
  `"${vsceBin}" package ${preFlag}--no-dependencies --baseContentUrl "${baseUrl}" --baseImagesUrl "${baseUrl}" --out "${vsixPath}"`,
  deployDir
);

console.log('Setting file modes in VSIX...');
// Pure-Node zip round trip via adm-zip (system `zip` adds Unix extra fields
// that Open VSX's validator rejects). We unpack, fix the recorder binaries'
// mode bits, and re-pack at the same output path.
const AdmZip = require('adm-zip');
const inputZip = new AdmZip(vsixPath);
rmSync(unpackDir, { recursive: true, force: true });
mkdirSync(unpackDir, { recursive: true });
inputZip.extractAllTo(unpackDir, /* overwrite */ true);

const outputZip = new AdmZip();
outputZip.addLocalFolder(unpackDir);

// Force the executable bit on the bundled recorder binaries. adm-zip
// preserves on-disk permissions when reading from a folder, BUT the
// VS Code Marketplace install pipeline strips Unix mode bits during
// unpack — extracted files land at 0644 regardless of what was in
// the zip's `external_file_attributes`. The runtime chmod in
// extensionRecorder.setBundledRecorderPath is the safety net that
// catches that on activation; this is the build-time correctness
// fix so registries that DO honor zip perms (Open VSX, manual
// install via `code --install-extension`) get a binary that's
// already executable.
//
// External file attribute format on Unix: high 16 bits hold the file
// mode (regular file 0o100000 + perm bits 0o755 = 0o100755). adm-zip
// stores this as `attr`.
const recorderEntries = outputZip.getEntries().filter((entry) =>
  /^extension\/media\/recorders\/bandit-mic-/.test(entry.entryName) && !entry.isDirectory
);
for (const entry of recorderEntries) {
  entry.attr = (0o100755 << 16) >>> 0;
  console.log(`Set executable bit on ${entry.entryName}`);
}

outputZip.writeZip(vsixPath);
rmSync(unpackDir, { recursive: true, force: true });

console.log(`VSIX written to ${vsixPath}`);

// Refuse to hand over a package that would fail on a clean install.
run(`node "${path.join(packageRoot, 'scripts', 'verify-vsix.cjs')}" "${vsixPath}"`, packageRoot);

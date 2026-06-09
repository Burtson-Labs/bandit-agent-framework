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

console.log('Copying existing node_modules...');
const sourceNodeModules = path.join(packageRoot, 'node_modules');
if (!existsSync(sourceNodeModules)) {
  throw new Error('node_modules not found. Run pnpm install before packaging.');
}
// dereference: true follows pnpm's symlinks during the copy so the
// staging tree contains real files instead of relative-path symlinks
// that would dangle once VS Code unpacks the VSIX into
// ~/.vscode/extensions. Observed 2026-04-29: the MCP SDK (added in
// v1.7.103) requires `zod/v3`; with dereference: false the SDK's
// nested zod symlink ended up dangling at install time and extension
// activation crashed with MODULE_NOT_FOUND. Cost: a few MB of duplicated
// transitive deps. Worth it — the alternative is hand-deploying the
// dependency graph.
cpSync(sourceNodeModules, path.join(deployDir, 'node_modules'), { recursive: true, dereference: true });

const deployedPackageJson = path.join(deployDir, 'package.json');
const deployedPackage = JSON.parse(readFileSync(deployedPackageJson, 'utf8'));
if (deployedPackage.scripts?.['vscode:prepublish']) {
  delete deployedPackage.scripts['vscode:prepublish'];
  if (deployedPackage.scripts && Object.keys(deployedPackage.scripts).length === 0) {
    delete deployedPackage.scripts;
  }
  writeFileSync(deployedPackageJson, JSON.stringify(deployedPackage, null, 2));
}

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

console.log('Injecting node_modules into VSIX...');
// Pure-Node zip round trip via adm-zip. Replaces a previous shell-out
// to system `unzip` + `zip -qrX` because:
//   1. The minimal ARC self-hosted runner image doesn't ship them.
//   2. Even with them installed, Linux `zip` adds Unix extra fields
//      (UID/GID, extended timestamps) that Open VSX's strict
//      validator rejects with "unsupported extra fields." VS Code
//      Marketplace tolerated them but Open VSX never has.
// adm-zip writes a minimal zip without those extra fields, so the
// resulting VSIX passes both registries' validators. Same VSIX
// structure as before — we unpack, splice node_modules into the
// `extension/` folder, then re-pack at the same output path.
const AdmZip = require('adm-zip');
const inputZip = new AdmZip(vsixPath);
rmSync(unpackDir, { recursive: true, force: true });
mkdirSync(unpackDir, { recursive: true });
inputZip.extractAllTo(unpackDir, /* overwrite */ true);

// Same dereference reasoning as the deploy-dir copy above: ship real
// files into the VSIX so the installed extension's transitive deps
// (e.g. zod nested under @modelcontextprotocol/sdk) don't end up as
// dangling pnpm symlinks.
cpSync(path.join(deployDir, 'node_modules'), path.join(unpackDir, 'extension', 'node_modules'), {
  recursive: true,
  dereference: true
});

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

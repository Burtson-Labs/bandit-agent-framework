#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT_DIR = process.cwd();
const TARGET_ROOTS = [
  "packages",
  "packages/agent-adapters",
  "apps",
  "examples",
  "services"
];
const IGNORE_DIRS = new Set(["node_modules", "dist", "build", ".turbo", ".git", "coverage"]);
const DRY_RUN = process.argv.includes("--dry-run");

const bumpPatch = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!match) {
    throw new Error(`Cannot bump non-semver version "${version}"`);
  }
  const [, major, minor, patch, suffix] = match;
  const nextPatch = Number(patch) + 1;
  return `${major}.${minor}.${nextPatch}${suffix ?? ""}`;
};

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const collectWorkspacePackages = async () => {
  const packageFiles = new Set([path.join(ROOT_DIR, "package.json")]);
  for (const root of TARGET_ROOTS) {
    const absoluteRoot = path.join(ROOT_DIR, root);
    if (!(await fileExists(absoluteRoot))) {
      continue;
    }
    const children = await fs.readdir(absoluteRoot, { withFileTypes: true });
    for (const entry of children) {
      if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) {
        continue;
      }
      await walkForPackages(path.join(absoluteRoot, entry.name), packageFiles);
    }
  }
  return Array.from(packageFiles);
};

const walkForPackages = async (dir, packageFiles) => {
  const pkgPath = path.join(dir, "package.json");
  if (await fileExists(pkgPath)) {
    packageFiles.add(pkgPath);
    return;
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) {
      continue;
    }
    await walkForPackages(path.join(dir, entry.name), packageFiles);
  }
};

const updatePackageFile = async (filePath) => {
  const json = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!json.version) {
    return { skipped: true, name: json.name ?? filePath };
  }
  const nextVersion = bumpPatch(json.version);
  if (DRY_RUN) {
    console.log(`[dry-run] ${json.name ?? filePath}: ${json.version} -> ${nextVersion}`);
    return { skipped: false, name: json.name ?? filePath, version: nextVersion };
  }
  json.version = nextVersion;
  await fs.writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  console.log(`Bumped ${json.name ?? filePath} to ${nextVersion}`);
  return { skipped: false, name: json.name ?? filePath, version: nextVersion };
};

const main = async () => {
  try {
    const packageFiles = await collectWorkspacePackages();
    await Promise.all(packageFiles.map((file) => updatePackageFile(file)));
    if (DRY_RUN) {
      console.log("Dry run complete. No files were modified.");
    }
  } catch (error) {
    console.error("[bump-patch]", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
};

main();

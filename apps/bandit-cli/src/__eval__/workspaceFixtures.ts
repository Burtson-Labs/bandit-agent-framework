/**
 * Loader for per-workspace eval fixtures at `.bandit/evals/*.{mjs,cjs,js}`.
 *
 * The built-in fixtures (apps/bandit-cli/src/__eval__/fixtures/*.ts) cover
 * the framework itself — they guard against regressions of bugs we've
 * fixed in core. But the behaviours a team cares about are product-specific:
 * "when the user says 'add a field to the worksheet' does the agent touch
 * the DTO, the Mongo schema, AND the UI form?" Those fixtures belong in
 * the product repo, not here — so they travel with the code they're
 * testing, commit under version control, and run when that repo is the
 * active workspace.
 *
 * Format: a JS module that either default-exports a Fixture OR exports
 * `fixture` / `fixtures` (singular or array). Example:
 *
 *   // .bandit/evals/add-field.mjs
 *   export default {
 *     id: 'dvr.add_worksheet_field',
 *     description: 'New worksheet field must touch DTO + Mongo + UI form',
 *     prompt: 'Add a "vehicle_vin" string field to the worksheet.',
 *     assertions: {
 *       mustCallAnyOf: [
 *         { name: 'apply_edit', params: { path: /WorksheetDto\.cs/ } }
 *       ],
 *       maxIterations: 8
 *     }
 *   };
 *
 * We deliberately accept .mjs, .cjs, and .js. `await import()` handles
 * all three: ESM default-exports land at `.default`, CJS module.exports
 * lands at `.default` too thanks to Node's interop, and named exports
 * show up under their key. The loader checks every shape a reasonable
 * author might reach for.
 *
 * Type safety is by convention — users can add a JSDoc hint pointing at
 * this package's Fixture type for IDE autocomplete without a build step:
 *
 *   /** @type {import('@burtson-labs/bandit-stealth-cli').Fixture} *\/
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { Fixture } from './types';

const EVALS_DIR = '.bandit/evals';
const SUPPORTED_EXTS = ['.mjs', '.cjs', '.js'] as const;

export interface WorkspaceFixtureLoadResult {
  fixtures: Fixture[];
  /** Warnings for malformed modules — shown once at the top of the run
   *  so authors know their fixture was skipped. Not fatal: one broken
   *  fixture shouldn't block the rest of the set. */
  warnings: string[];
}

export async function loadWorkspaceFixtures(workspaceRoot: string): Promise<WorkspaceFixtureLoadResult> {
  const fixtures: Fixture[] = [];
  const warnings: string[] = [];

  // Walk upward looking for a .bandit/evals/ directory. Lets a user run
  // `bandit eval` from any subdirectory of their project (including an
  // apps/* subpackage) and still pick up evals declared at the repo root.
  // Matches how git, pnpm, turbo all find their workspace root.
  const absDir = findEvalsDir(workspaceRoot);
  if (!absDir) return { fixtures, warnings };

  let entries: string[];
  try {
    entries = await fs.promises.readdir(absDir);
  } catch {
    // Directory vanished between the lookup and the read — ignore.
    return { fixtures, warnings };
  }

  const seenIds = new Set<string>();

  for (const name of entries) {
    const ext = path.extname(name).toLowerCase();
    if (!SUPPORTED_EXTS.includes(ext as typeof SUPPORTED_EXTS[number])) continue;

    const absPath = path.join(absDir, name);
    const relPath = path.relative(workspaceRoot, absPath) || path.join(EVALS_DIR, name);

    try {
      const mod = await importFresh(absPath);
      const loaded = extractFixtures(mod);
      if (loaded.length === 0) {
        warnings.push(`${relPath}: module loaded but no fixtures found (expected default export or named "fixture"/"fixtures")`);
        continue;
      }
      for (const fx of loaded) {
        const validation = validateFixture(fx, relPath);
        if (validation) {
          warnings.push(validation);
          continue;
        }
        if (seenIds.has(fx.id)) {
          warnings.push(`${relPath}: duplicate fixture id "${fx.id}" — ignoring (first occurrence wins)`);
          continue;
        }
        seenIds.add(fx.id);
        fixtures.push(fx);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`${relPath}: failed to load — ${message}`);
    }
  }

  return { fixtures, warnings };
}

/**
 * Walk upward from `start` looking for a `.bandit/evals` directory.
 * Returns the absolute path to the first one found, or null if we hit
 * the filesystem root without seeing one. This mirrors the "find the
 * project root" pattern in git, pnpm, and turbo — running the eval from
 * an apps/* subpackage should still pick up evals declared at the repo
 * root rather than forcing the user to cd.
 */
function findEvalsDir(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, EVALS_DIR);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // not here — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;  // hit filesystem root
    dir = parent;
  }
}

/**
 * Dynamic import with cache-busting. Node caches ESM + CJS modules by URL,
 * so back-to-back `pnpm eval` runs inside a long-lived process would see
 * stale fixtures after the author edits. Appending a query string forces
 * a fresh load each time. Harmless in one-shot invocations (our default
 * today) but makes the loader safe for future watch-mode use.
 */
async function importFresh(absPath: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(absPath).href + `?t=${Date.now()}`;
  return await import(url);
}

function extractFixtures(mod: Record<string, unknown>): Fixture[] {
  // Try every shape we document, in order of preference. The first
  // hit wins; additional keys are ignored (not merged) to keep the
  // "what does this file export" mental model simple.
  const candidates: unknown[] = [];
  if (Array.isArray(mod.fixtures)) candidates.push(...mod.fixtures);
  else if (mod.fixture !== undefined) candidates.push(mod.fixture);
  else if (mod.default !== undefined) {
    if (Array.isArray(mod.default)) candidates.push(...(mod.default as unknown[]));
    else candidates.push(mod.default);
  }
  return candidates.filter((c): c is Fixture => typeof c === 'object' && c !== null);
}

/**
 * Structural validation of an author-supplied fixture. Returns null when
 * the fixture is valid, or a warning string when it's missing required
 * fields. Kept deliberately lenient on optional fields — an overly strict
 * validator would reject perfectly-usable fixtures for cosmetic reasons
 * and train authors to silence warnings rather than fix real problems.
 */
function validateFixture(fx: Fixture, source: string): string | null {
  if (typeof fx.id !== 'string' || fx.id.length === 0) {
    return `${source}: fixture missing required string field "id"`;
  }
  if (typeof fx.description !== 'string') {
    return `${source}: fixture "${fx.id}" missing required string field "description"`;
  }
  if (typeof fx.prompt !== 'string' || fx.prompt.length === 0) {
    return `${source}: fixture "${fx.id}" missing required string field "prompt"`;
  }
  if (typeof fx.assertions !== 'object' || fx.assertions === null) {
    return `${source}: fixture "${fx.id}" missing required object field "assertions"`;
  }
  const hasAnyAssertion =
    fx.assertions.mustCallAnyOf !== undefined ||
    fx.assertions.mustNotCall !== undefined ||
    fx.assertions.maxIterations !== undefined ||
    fx.assertions.finalResponseMatches !== undefined;
  if (!hasAnyAssertion) {
    return `${source}: fixture "${fx.id}" has no assertions — every fixture needs at least one of mustCallAnyOf / mustNotCall / maxIterations / finalResponseMatches`;
  }
  return null;
}

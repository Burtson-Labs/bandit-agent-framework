#!/usr/bin/env node
/**
 * Dependency audit gate.
 *
 * Why this exists instead of a bare `pnpm audit --prod --audit-level high`:
 * pnpm exits non-zero when it finds *any* advisory, regardless of
 * `--audit-level` — so the bare command reds the build on a low-severity
 * transitive DoS note and there is no way to accept a known-unfixable
 * advisory short of deleting the step. Both failure modes end the same way:
 * someone disables the gate. This script keeps the gate but makes it
 * answerable — it fails only on high/critical, and only when the advisory
 * is not in a dated, reasoned allowlist.
 *
 * Allowlist: .github/audit-allowlist.json
 *   { "allow": [ { "id": "GHSA-…", "package": "…", "reason": "…",
 *                  "added": "YYYY-MM-DD", "expires": "YYYY-MM-DD" } ] }
 *
 * An entry past its `expires` date stops suppressing — an accepted risk has
 * to be re-argued on a schedule, not accepted once and inherited forever.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const allowlistPath = join(repoRoot, '.github', 'audit-allowlist.json');
const BLOCKING = new Set(['high', 'critical']);

function loadAllowlist() {
  if (!existsSync(allowlistPath)) {return [];}
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  } catch (err) {
    console.error(`audit gate: ${allowlistPath} is not valid JSON — ${err.message}`);
    process.exit(1);
  }
  const entries = Array.isArray(parsed?.allow) ? parsed.allow : [];
  for (const entry of entries) {
    if (!entry?.id || !entry?.reason || !entry?.added) {
      console.error(`audit gate: allowlist entry needs id + reason + added — got ${JSON.stringify(entry)}`);
      process.exit(1);
    }
  }
  return entries;
}

function runAudit() {
  const res = spawnSync('pnpm', ['audit', '--prod', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  if (res.error) {
    console.error(`audit gate: could not run \`pnpm audit\` — ${res.error.message}`);
    process.exit(1);
  }
  // pnpm exits 1 whenever anything at all was found, so the exit code says
  // nothing useful here; the JSON body is the signal. Only an unparseable
  // body is treated as a failure, and deliberately as a hard one: a gate
  // that passes when it cannot see is not a gate.
  try {
    return JSON.parse(res.stdout);
  } catch {
    console.error('audit gate: `pnpm audit --prod --json` did not return JSON.');
    console.error('This is an infrastructure failure (registry unreachable?), not a vulnerability.');
    console.error(`stdout: ${(res.stdout || '').slice(0, 500)}`);
    console.error(`stderr: ${(res.stderr || '').slice(0, 500)}`);
    process.exit(1);
  }
}

const allowlist = loadAllowlist();
const today = new Date().toISOString().slice(0, 10);
const byId = new Map(allowlist.map((e) => [e.id, e]));

const report = runAudit();
const advisories = Object.values(report.advisories ?? {});
const counts = report.metadata?.vulnerabilities ?? {};

const blocking = [];
const suppressed = [];
const expired = [];

for (const advisory of advisories) {
  if (!BLOCKING.has(advisory.severity)) {continue;}
  const id = advisory.github_advisory_id ?? String(advisory.id);
  const entry = byId.get(id);
  if (!entry) {
    blocking.push({ advisory, id });
  } else if (entry.expires && entry.expires < today) {
    expired.push({ advisory, id, entry });
    blocking.push({ advisory, id });
  } else {
    suppressed.push({ advisory, id, entry });
  }
}

const summary = ['critical', 'high', 'moderate', 'low', 'info']
  .map((sev) => `${counts[sev] ?? 0} ${sev}`)
  .join(', ');
console.log(`Production dependency audit: ${summary}`);

for (const { advisory, id, entry } of suppressed) {
  console.log(`  accepted  ${advisory.severity.padEnd(8)} ${id}  ${advisory.module_name} — ${entry.reason}`);
}

for (const { id, entry } of expired) {
  console.error(`  EXPIRED   ${id} was accepted on ${entry.added} until ${entry.expires}; re-review or extend it.`);
}

const stale = allowlist.filter((e) => !advisories.some((a) => (a.github_advisory_id ?? String(a.id)) === e.id));
for (const entry of stale) {
  console.log(`  stale     ${entry.id} is allowlisted but no longer reported — safe to delete from the allowlist.`);
}

if (blocking.length === 0) {
  console.log('No unaccepted high or critical advisories in production dependencies.');
  process.exit(0);
}

console.error(`\n${blocking.length} unaccepted high/critical advisor${blocking.length === 1 ? 'y' : 'ies'}:`);
for (const { advisory, id } of blocking) {
  console.error(`  ${advisory.severity.toUpperCase()}  ${advisory.module_name} ${advisory.vulnerable_versions}`);
  console.error(`    ${advisory.title}`);
  console.error(`    fixed in: ${advisory.patched_versions || 'no fix published'}`);
  console.error(`    ${advisory.url ?? `https://github.com/advisories/${id}`}`);
}
console.error('\nFix by raising the floor in `pnpm.overrides` (root package.json) and re-running');
console.error('`pnpm install`. If the advisory genuinely does not apply, add it to');
console.error('.github/audit-allowlist.json with a reason and an expiry date.');
process.exit(1);

#!/usr/bin/env node
/**
 * Self-improve proposer (Rung 3, v1) — deterministic pattern mining, no LLM.
 *
 * Reads two evidence sources:
 *   1. The latest nightly bench output, when a path is given — either the
 *      markdown eval report (`.bandit/eval-report.md`) or a tee'd console
 *      log from `bandit eval` (ANSI is stripped; both formats are parsed).
 *   2. The tail of `.bandit/turns/*.jsonl` (last ~20 turn logs) for repeated
 *      tool-error patterns the structured logger already captures.
 *
 * Emits `proposals.json`: an ARRAY of
 *   { kind: 'fixture' | 'lesson' | 'prompt-tier', title, rationale,
 *     files: [{ path, content }] }
 *
 * HARD ALLOWLIST — a proposal may only:
 *   - create NEW files under  apps/bandit-cli/src/__eval__/fixtures/
 *   - create NEW files under  .bandit/evals/
 *   - edit                    .bandit/lessons.md
 * Anything else is a generator bug and this script throws. `open-pr.sh`
 * re-validates independently before writing — neither side trusts the other.
 *
 * v1 is intentionally heuristic and honest about it: every rationale states
 * the observed counts, and lessons are phrased as observed patterns, not
 * root-cause claims. v2 swaps the bullet-writer for a bandit one-shot that
 * reasons over the same evidence (see README.md).
 *
 * Usage:
 *   node ops/self-improve/propose.ts [eval-report-or-bench-log] \
 *     [--report <path>] [--turns-dir <path>] [--repo-root <path>] \
 *     [--out <path>] [--tail <n>]
 *
 * Requires Node >= 22.18 (type stripping on by default; erasable types only).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';

// ── thresholds (deterministic knobs, tuned against real turn logs) ──────────
const TAIL_DEFAULT = 20;
const MIN_TOOL_ERRORS = 3;   // same tool erroring at least this often…
const MIN_ERROR_TURNS = 2;   // …across at least this many distinct turns
const MIN_PHANTOM = 2;       // same nonexistent tool name invoked this often
const MIN_FAKE_RESULTS = 2;  // fake/hallucinated tool-result detector firings
const MAX_LESSONS = 40;      // mirror of host-kit lessons store cap

interface ProposalFile { path: string; content: string; }
interface Proposal {
  kind: 'fixture' | 'lesson' | 'prompt-tier';
  title: string;
  rationale: string;
  files: ProposalFile[];
}

interface Args {
  report?: string;
  turnsDir: string;
  repoRoot: string;
  out: string;
  tail: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repoRoot: process.cwd(),
    turnsDir: '',
    out: 'proposals.json',
    tail: TAIL_DEFAULT
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report') args.report = argv[++i];
    else if (a === '--turns-dir') args.turnsDir = argv[++i];
    else if (a === '--repo-root') args.repoRoot = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--tail') args.tail = Math.max(1, parseInt(argv[++i], 10) || TAIL_DEFAULT);
    else if (a.startsWith('--')) {
      process.stderr.write(`propose: unknown flag ${a}\n`);
      process.exit(2);
    } else positional.push(a);
  }
  if (!args.report && positional.length > 0) args.report = positional[0];
  if (!args.turnsDir) args.turnsDir = path.join(args.repoRoot, '.bandit', 'turns');
  return args;
}

// ── evidence: turn-log mining ───────────────────────────────────────────────

interface TurnEvidence {
  filesScanned: number;
  /** tool name → error info */
  toolErrors: Map<string, { count: number; turns: Set<string>; targets: Map<string, number> }>;
  /** nonexistent tool name → { count, turns } */
  phantomTools: Map<string, { count: number; turns: Set<string> }>;
  /** fake-tool-result + hallucinated-tool-result firings */
  fakeResultCount: number;
  fakeResultTurns: Set<string>;
}

function primaryParam(params: Record<string, string> | undefined): string {
  if (!params) return '';
  const value = params.path ?? params.cmd ?? params.pattern ?? params.url ?? params.repo_path
    ?? Object.values(params)[0] ?? '';
  const oneLine = String(value).replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
}

function mineTurnLogs(turnsDir: string, tail: number): TurnEvidence {
  const evidence: TurnEvidence = {
    filesScanned: 0,
    toolErrors: new Map(),
    phantomTools: new Map(),
    fakeResultCount: 0,
    fakeResultTurns: new Set()
  };
  let names: string[];
  try {
    names = fs.readdirSync(turnsDir).filter(n => /^turn-.*\.jsonl$/.test(n)).sort();
  } catch {
    return evidence; // no turn logs (fresh clone) — turn mining just contributes nothing
  }
  for (const name of names.slice(-tail)) {
    evidence.filesScanned++;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(turnsDir, name), 'utf8');
    } catch { continue; }
    // Pair tool-execute → tool-result per tool name, in order, per turn file.
    const pending = new Map<string, Array<Record<string, string>>>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let event: { type?: string; name?: string; params?: Record<string, string>; isError?: boolean };
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'tool-execute' && event.name) {
        const queue = pending.get(event.name) ?? [];
        queue.push(event.params ?? {});
        pending.set(event.name, queue);
      } else if (event.type === 'tool-result' && event.name) {
        const queue = pending.get(event.name) ?? [];
        const params = queue.shift();
        if (event.isError) {
          const entry = evidence.toolErrors.get(event.name)
            ?? { count: 0, turns: new Set<string>(), targets: new Map<string, number>() };
          entry.count++;
          entry.turns.add(name);
          const target = primaryParam(params);
          if (target) entry.targets.set(target, (entry.targets.get(target) ?? 0) + 1);
          evidence.toolErrors.set(event.name, entry);
        }
      } else if (event.type === 'tool-not-found' && event.name) {
        const entry = evidence.phantomTools.get(event.name) ?? { count: 0, turns: new Set<string>() };
        entry.count++;
        entry.turns.add(name);
        evidence.phantomTools.set(event.name, entry);
      } else if (event.type === 'fake-tool-result' || event.type === 'hallucinated-tool-result') {
        evidence.fakeResultCount++;
        evidence.fakeResultTurns.add(name);
      }
    }
  }
  return evidence;
}

// ── evidence: bench/eval report parsing ─────────────────────────────────────

interface FailingFixture { id: string; passRate: string; description: string; }

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}

function parseBenchReport(reportPath: string): FailingFixture[] {
  let raw: string;
  try {
    raw = fs.readFileSync(reportPath, 'utf8');
  } catch {
    process.stderr.write(`propose: report not readable at ${reportPath} — skipping bench evidence\n`);
    return [];
  }
  const failing = new Map<string, FailingFixture>();
  for (const line of stripAnsi(raw).split('\n')) {
    // Markdown report table row: | `fixture.id` | ❌ | 1/3 | description |
    const md = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (md) {
      const [, id, status, passRate, description] = md;
      if (/❌|✗/.test(status)) failing.set(id, { id, passRate, description });
      continue;
    }
    // Live console line (tee'd bench log): ✗ fixture.id  1/3  description
    const live = /^\s*(?:\[\s*\d+\/\d+\]\s*)?[✗❌]\s+([A-Za-z0-9_.:-]+)\s+(\d+\/\d+)\s+(.*)$/.exec(line);
    if (live) {
      const [, id, passRate, description] = live;
      failing.set(id, { id, passRate, description: description.trim() });
    }
  }
  return [...failing.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ── lessons.md composition (mirror of packages/host-kit/src/lessons.ts) ─────

const LESSONS_REL = path.join('.bandit', 'lessons.md');
const LESSONS_HEADER = [
  '# Learned lessons',
  '',
  '<!-- Auto-generated by Bandit from past runs — durable facts about THIS repo.',
  '     Machine-distilled and lower-trust than BANDIT.md: edit freely, or clear',
  '     with `/lessons clear`. Bandit reads this back on future turns. -->',
  ''
].join('\n');

function normalizeLessonLoose(lesson: string): string {
  return lesson.toLowerCase().replace(/[`'".,;:!?]/g, '').replace(/\s+/g, ' ').trim();
}

function loadExistingLessons(repoRoot: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(repoRoot, LESSONS_REL), 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const m = /^- (.+)$/.exec(line.trim());
    if (m) out.push(m[1].trim());
  }
  return out;
}

function renderLessons(lessons: string[]): string {
  const body = lessons.map(l => `- ${l}`).join('\n');
  return `${LESSONS_HEADER}${body}\n`;
}

// ── proposal builders ───────────────────────────────────────────────────────

function buildToolErrorBullets(evidence: TurnEvidence): string[] {
  const bullets: string[] = [];
  const entries = [...evidence.toolErrors.entries()]
    .filter(([, e]) => e.count >= MIN_TOOL_ERRORS && e.turns.size >= MIN_ERROR_TURNS)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  for (const [tool, entry] of entries) {
    const topTarget = [...entry.targets.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const targetNote = topTarget ? ` (most common target: \`${topTarget[0]}\`, ${topTarget[1]}×)` : '';
    bullets.push(
      `Observed pattern: \`${tool}\` errored ${entry.count}× across ${entry.turns.size} recent turns${targetNote} — ` +
      `verify the target exists before calling (e.g. list_files first), and never retry an identical failing call.`
    );
  }
  return bullets;
}

function buildFakeResultBullet(evidence: TurnEvidence): string[] {
  if (evidence.fakeResultCount < MIN_FAKE_RESULTS) return [];
  return [
    `Observed pattern: the fake/hallucinated tool-result detector fired ${evidence.fakeResultCount}× across ` +
    `${evidence.fakeResultTurns.size} recent turns — never narrate a tool result that was not actually returned; ` +
    `if a result is missing, call the tool again.`
  ];
}

function buildPhantomProposals(evidence: TurnEvidence): { proposals: Proposal[]; bullets: string[] } {
  const proposals: Proposal[] = [];
  const bullets: string[] = [];
  const entries = [...evidence.phantomTools.entries()]
    .filter(([, e]) => e.count >= MIN_PHANTOM)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  for (const [tool, entry] of entries) {
    // Defensive: the name comes from log data — refuse anything that could
    // misbehave as a filename or break out of the template.
    if (!/^[a-z][a-z0-9_]{0,40}$/i.test(tool)) continue;
    const slug = tool.toLowerCase();
    const fixtureId = `self_improve.no_phantom_${slug}`;
    const relPath = `.bandit/evals/self-improve-no-phantom-${slug}.mjs`;
    const rationale =
      `The model invoked a tool named \`${tool}\` that does not exist ` +
      `(${entry.count}× across ${entry.turns.size} recent turns — \`tool-not-found\` events in .bandit/turns/). ` +
      `This workspace fixture pins that a routine read+write task never routes to the phantom name. ` +
      `It does not reproduce the original prompts (v1 is deterministic and cannot); it is a floor, not a diagnosis.`;
    const content = [
      '/**',
      ' * AUTO-PROPOSED by ops/self-improve/propose.ts — review before merge.',
      ` * Evidence: tool-not-found \`${tool}\` ×${entry.count} across ${entry.turns.size} recent turns.`,
      ' *',
      " * @type {import('../../apps/bandit-cli/src/__eval__/types').Fixture}",
      ' */',
      'export default {',
      `  id: ${JSON.stringify(fixtureId)},`,
      `  description: ${JSON.stringify(`A routine read+write task never calls the nonexistent tool ${tool}`)},`,
      "  prompt: 'Read notes.md, then append a line saying `reviewed` to it. Nothing else.',",
      '  setup: {',
      "    files: { 'notes.md': '# notes\\n' }",
      '  },',
      '  assertions: {',
      `    mustNotCall: [${JSON.stringify(tool)}],`,
      '    mustCallAnyOf: [',
      "      { name: /^(apply_edit|write_file|replace_range)$/, params: { path: /notes\\.md/ } }",
      '    ],',
      '    maxIterations: 5',
      '  },',
      '  runs: 3,',
      '  passThreshold: 2',
      '};',
      ''
    ].join('\n');
    proposals.push({
      kind: 'fixture',
      title: `Pin: no phantom tool \`${tool}\``,
      rationale,
      files: [{ path: relPath, content }]
    });
    bullets.push(
      `There is no tool named \`${tool}\` in this workspace — calling it fails with tool-not-found ` +
      `(seen ${entry.count}× in recent turns); use only tools from the registered toolbox.`
    );
  }
  return { proposals, bullets };
}

// ── allowlist enforcement (generator-side; open-pr.sh re-validates) ─────────

const NEW_FILE_PREFIXES = ['apps/bandit-cli/src/__eval__/fixtures/', '.bandit/evals/'];
const EDITABLE_FILES = ['.bandit/lessons.md'];

function assertAllowlisted(proposal: Proposal, repoRoot: string): void {
  for (const file of proposal.files) {
    const rel = file.path;
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
      throw new Error(`allowlist violation (path escape): ${rel}`);
    }
    if (EDITABLE_FILES.includes(rel)) continue;
    const underAllowedDir = NEW_FILE_PREFIXES.some(p => rel.startsWith(p) && rel.length > p.length);
    if (!underAllowedDir) {
      throw new Error(`allowlist violation (path outside allowlist): ${rel}`);
    }
    if (fs.existsSync(path.join(repoRoot, rel))) {
      throw new Error(`allowlist violation (would overwrite existing file): ${rel}`);
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const proposals: Proposal[] = [];

  const evidence = mineTurnLogs(args.turnsDir, args.tail);
  process.stderr.write(`propose: scanned ${evidence.filesScanned} turn log(s) in ${args.turnsDir}\n`);

  const failing = args.report ? parseBenchReport(args.report) : [];
  if (args.report) {
    process.stderr.write(`propose: bench report ${args.report} — ${failing.length} failing fixture(s)\n`);
  }

  // 1) fixture proposals (independent new files, applied first)
  const phantom = buildPhantomProposals(evidence);
  proposals.push(...phantom.proposals);

  // Lessons compose cumulatively: each lessons.md-touching proposal's content
  // includes the bullets of the ones before it, so open-pr.sh applying the
  // array IN ORDER converges on a single coherent file (no clobbering).
  let lessonsState = loadExistingLessons(args.repoRoot);
  const seen = new Set(lessonsState.map(normalizeLessonLoose));
  const addBullets = (bullets: string[]): string[] => {
    const added: string[] = [];
    for (const bullet of bullets) {
      const norm = normalizeLessonLoose(bullet);
      if (seen.has(norm)) continue;
      seen.add(norm);
      added.push(bullet);
    }
    if (added.length > 0) lessonsState = [...lessonsState, ...added].slice(-MAX_LESSONS);
    return added;
  };

  // 2) lesson proposal — repeated tool errors + fabricated tool results
  const lessonBullets = addBullets([
    ...buildToolErrorBullets(evidence),
    ...buildFakeResultBullet(evidence),
    ...phantom.bullets
  ]);
  if (lessonBullets.length > 0) {
    proposals.push({
      kind: 'lesson',
      title: `Distill ${lessonBullets.length} lesson(s) from recent turn logs`,
      rationale:
        `Deterministic mining of the last ${evidence.filesScanned} turn log(s) in .bandit/turns/ found ` +
        `recurring failure patterns (repeated tool errors, phantom tool names, fabricated tool results). ` +
        `Each bullet states its observed counts — these are patterns, not root-cause claims. ` +
        `New bullets:\n${lessonBullets.map(b => `  - ${b}`).join('\n')}`,
      files: [{ path: LESSONS_REL.split(path.sep).join('/'), content: renderLessons(lessonsState) }]
    });
  }

  // 3) prompt-tier proposal — failing bench fixtures become standing rules.
  // lessons.md is the only prompt-injected surface inside the allowlist
  // (it is a memory candidate loaded into the system prompt), so v1
  // materializes prompt-tier proposals there; real prompt-tier file edits
  // stay human-owned.
  const promptBullets = addBullets(failing.map(f =>
    `Eval fixture \`${f.id}\` is failing (${f.passRate}): ${f.description} — treat that description as a standing rule in this repo until the fixture passes again.`
  ));
  if (promptBullets.length > 0) {
    proposals.push({
      kind: 'prompt-tier',
      title: `Steer ${promptBullets.length} failing eval fixture(s) via lessons`,
      rationale:
        `The bench report lists ${failing.length} failing fixture(s). lessons.md is the only ` +
        `prompt-injected surface the allowlist permits, so each failure becomes a standing-rule bullet. ` +
        `New bullets:\n${promptBullets.map(b => `  - ${b}`).join('\n')}`,
      files: [{ path: LESSONS_REL.split(path.sep).join('/'), content: renderLessons(lessonsState) }]
    });
  }

  for (const proposal of proposals) assertAllowlisted(proposal, args.repoRoot);

  fs.writeFileSync(args.out, `${JSON.stringify(proposals, null, 2)}\n`, 'utf8');
  process.stderr.write(`propose: ${proposals.length} proposal(s) → ${args.out}\n`);
  for (const p of proposals) {
    process.stderr.write(`  [${p.kind}] ${p.title} (${p.files.length} file(s))\n`);
  }
  if (proposals.length === 0) {
    process.stderr.write('propose: nothing crossed the thresholds — no PR needed this week.\n');
  }
}

main();

/**
 * `bandit train` — Burtson Training Studio, data side.
 *
 *   bandit train collect [--out dir] [--since YYYY-MM-DD] [--sources cli-session,stealth-web,banditbench]
 *                        [--keep-nudges] [--max-secrets N] [--workspaces a,b,c] [--banditbench dir]
 *                        [--history N] [--window-tokens N] [--window-mode chunks|tail]
 *                        [--min-quality none|completed|edited|completed-or-unknown-with-tools]
 *                        [--include-handbacks] [--external-paths placeholder|drop] [--dry-run]
 *   bandit train inspect <dir> [--grep text] [--sample N]
 *   bandit train upload  <dir> [--api https://training.burtson.ai]
 *
 * Raw data never leaves this machine: collect scrubs locally (scrub-v1) and only the
 * scrubbed dataset is uploaded. Every run ends with a self-check that greps the output
 * for secret-looking leftovers and fails loudly if it finds any.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { loadConfigFiles, resolveConfig } from '../config';
import {
  addBanditBenchTrace,
  addCliSession,
  addStealthWebTurn,
  buildManifest,
  DEFAULT_WINDOW_TOKENS,
  newAccumulator,
  type BuildOptions,
  type Manifest,
  type WindowStats
} from './build';
import { MIN_QUALITY_VALUES, type MinQuality } from './quality';
import type { WindowMode } from './window';
import { createScrubber, parseDenylist, selfCheckExample, type SelfCheckHit } from './scrub';
import {
  banditHome,
  defaultWorkspaceRoots,
  findTurnDirs,
  isHostKitTurnFile,
  parseHostTurn,
  parseSession,
  parseStealthWebTurn,
  readUniqueJsonl,
  type HostTurn
} from './sources';
import type { DroppedExample, ExampleSource, NegativeExample, TrainingExample } from './types';

export const DENYLIST_EXAMPLE = `# Burtson Training Studio — scrub denylist (scrub-v1)
# Copy to ~/.bandit/training/denylist.txt and replace the placeholders with real terms.
# One term per line. "person:" terms become [PERSON], everything else [CLIENT].
# Matching is case-insensitive on whole words. Never commit the real list.
client: Example Client Co
client: example-client-portal
person: Jane Placeholder
person: John Placeholder
`;

type Source = Extract<ExampleSource, 'cli-session' | 'stealth-web' | 'banditbench'>;

interface CollectArgs {
  out?: string;
  since?: Date;
  sources: Source[];
  keepNudges: boolean;
  maxSecrets: number;
  workspaces: string[];
  banditbench: string;
  history: number;
  windowTokens: number;
  windowMode: WindowMode;
  minQuality: MinQuality;
  includeHandbacks: boolean;
  externalPaths: 'placeholder' | 'drop';
  dryRun: boolean;
}

function trainingHome(): string {
  return path.join(banditHome(), 'training');
}

function parseCollectArgs(argv: string[]): CollectArgs {
  const args: CollectArgs = {
    sources: ['cli-session', 'stealth-web', 'banditbench'],
    keepNudges: false,
    maxSecrets: 25,
    workspaces: defaultWorkspaceRoots(),
    banditbench: path.join(trainingHome(), 'banditbench-traces'),
    history: 8,
    windowTokens: DEFAULT_WINDOW_TOKENS,
    windowMode: 'chunks',
    minQuality: 'completed-or-unknown-with-tools',
    includeHandbacks: false,
    externalPaths: 'placeholder',
    dryRun: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--since') {
      const d = new Date(argv[++i]);
      if (Number.isNaN(d.getTime())) throw new Error(`--since: not a date: ${argv[i]}`);
      args.since = d;
    } else if (a === '--sources') args.sources = argv[++i].split(',').map(s => s.trim()).filter(Boolean) as Source[];
    else if (a === '--keep-nudges') args.keepNudges = true;
    else if (a === '--max-secrets') args.maxSecrets = parseInt(argv[++i], 10);
    else if (a === '--workspaces') args.workspaces = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--banditbench') args.banditbench = argv[++i];
    else if (a === '--history') args.history = parseInt(argv[++i], 10);
    else if (a === '--window-tokens') {
      args.windowTokens = parseInt(argv[++i], 10);
      if (!Number.isFinite(args.windowTokens) || args.windowTokens < 1024) throw new Error('--window-tokens: a number ≥ 1024');
    } else if (a === '--window-mode') {
      const v = argv[++i];
      if (v !== 'chunks' && v !== 'tail') throw new Error('--window-mode: chunks or tail');
      args.windowMode = v;
    } else if (a === '--min-quality') {
      const v = argv[++i] as MinQuality;
      if (!MIN_QUALITY_VALUES.includes(v)) throw new Error(`--min-quality: one of ${MIN_QUALITY_VALUES.join(', ')}`);
      args.minQuality = v;
    } else if (a === '--include-handbacks') args.includeHandbacks = true;
    else if (a === '--external-paths') {
      const v = argv[++i];
      if (v !== 'placeholder' && v !== 'drop') throw new Error('--external-paths: placeholder or drop');
      args.externalPaths = v;
    }
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown option ${a}`);
  }
  return args;
}

async function loadDenylist(): Promise<ReturnType<typeof parseDenylist>> {
  const dir = trainingHome();
  await fs.promises.mkdir(dir, { recursive: true });
  const example = path.join(dir, 'denylist.example.txt');
  if (!fs.existsSync(example)) await fs.promises.writeFile(example, DENYLIST_EXAMPLE, 'utf8');
  try {
    return parseDenylist(await fs.promises.readFile(path.join(dir, 'denylist.txt'), 'utf8'));
  } catch {
    return [];
  }
}

export interface CollectResult {
  manifest: Manifest;
  examples: TrainingExample[];
  negatives: NegativeExample[];
  windowing: WindowStats;
  handBacks: Record<string, number>;
  paths: Record<string, number>;
  dropped: DroppedExample[];
  selfCheck: SelfCheckHit[];
  discovery: Record<string, number>;
  joinStats: Record<string, number>;
  denylistTerms: number;
}

export async function collect(args: CollectArgs, version: string): Promise<CollectResult> {
  const denylist = await loadDenylist();
  const scrubber = createScrubber(denylist);
  const options: BuildOptions = {
    keepNudges: args.keepNudges,
    maxSecrets: args.maxSecrets,
    maxHistoryTurns: args.history,
    since: args.since,
    windowTokens: args.windowTokens,
    windowMode: args.windowMode,
    minQuality: args.minQuality,
    includeHandbacks: args.includeHandbacks,
    externalPaths: args.externalPaths
  };
  const acc = newAccumulator();
  const discovery: Record<string, number> = {};

  // Turn logs: the global ~/.bandit/turns plus every workspace's .bandit/turns.
  const turnDirs = [path.join(banditHome(), 'turns'), ...(await findTurnDirs(args.workspaces))];
  const { files: turnFiles, duplicates: turnDuplicates } = await readUniqueJsonl(turnDirs);
  discovery.turnDirs = turnDirs.length;
  discovery.turnFiles = turnFiles.length;
  discovery.turnFileDuplicates = turnDuplicates;
  const hostTurns: HostTurn[] = [];
  let stealthWeb = 0;
  for (const f of turnFiles) {
    if (isHostKitTurnFile(f.name)) {
      const t = parseHostTurn(f);
      if (t) hostTurns.push(t);
    } else if (args.sources.includes('stealth-web')) {
      const t = parseStealthWebTurn(f);
      if (t) {
        stealthWeb++;
        addStealthWebTurn(acc, t, scrubber, options);
      }
    }
  }
  discovery.hostKitTurns = hostTurns.length;
  discovery.stealthWebTurns = stealthWeb;

  const used = new Set<string>();
  if (args.sources.includes('cli-session')) {
    const { files: sessionFiles, duplicates } = await readUniqueJsonl([path.join(banditHome(), 'sessions')]);
    discovery.sessionFiles = sessionFiles.length;
    discovery.sessionDuplicates = duplicates;
    for (const f of sessionFiles.sort((a, b) => a.name.localeCompare(b.name))) {
      const session = parseSession(f);
      if (session.messages.length === 0) {
        // Empty files (a REPL opened and closed) are skipped, not dropped; only real parse
        // failures count as drops.
        if (session.badLines > 0) acc.dropped.push({ ref: `sessions/${session.id}`, source: 'cli-session', reason: 'unparseable' });
        else discovery.sessionEmpty = (discovery.sessionEmpty ?? 0) + 1;
        continue;
      }
      addCliSession(acc, session, hostTurns, used, scrubber, options);
    }
  }
  acc.stats.unjoinedTurns = hostTurns.length - used.size;

  if (args.sources.includes('banditbench')) {
    let traces = 0;
    try {
      for (const name of (await fs.promises.readdir(args.banditbench)).filter(n => /\.jsonl?$/.test(n)).sort()) {
        const text = await fs.promises.readFile(path.join(args.banditbench, name), 'utf8');
        const lines = name.endsWith('.jsonl') ? text.split('\n').filter(l => l.trim()) : [text];
        lines.forEach((line, i) => {
          traces++;
          try {
            addBanditBenchTrace(acc, JSON.parse(line) as TrainingExample, `banditbench/${name}#${i + 1}`, scrubber, options);
          } catch {
            acc.dropped.push({ ref: `banditbench/${name}#${i + 1}`, source: 'banditbench', reason: 'unparseable' });
          }
        });
      }
    } catch { /* no traces yet */ }
    discovery.banditbenchTraces = traces;
  }

  // Negatives are written to disk too, so they get the same leftover check.
  const selfCheck = [...acc.examples, ...acc.negatives].flatMap(selfCheckExample);
  const manifest = buildManifest(acc.examples, acc.dropped, {
    version,
    options: {
      sources: args.sources,
      since: args.since?.toISOString() ?? null,
      keepNudges: args.keepNudges,
      maxSecrets: args.maxSecrets,
      historyTurns: args.history,
      windowTokens: args.windowTokens,
      windowMode: args.windowMode,
      minQuality: args.minQuality,
      includeHandbacks: args.includeHandbacks,
      externalPaths: args.externalPaths,
      paths: acc.paths,
      negatives: acc.negatives.length,
      denylistTerms: denylist.length
    },
    selfCheckHits: selfCheck.length
  });
  return {
    manifest,
    examples: acc.examples,
    negatives: acc.negatives,
    windowing: acc.windowing,
    handBacks: acc.handBacks,
    paths: acc.paths,
    dropped: acc.dropped,
    selfCheck,
    discovery,
    joinStats: acc.stats,
    denylistTerms: denylist.length
  };
}

function dropCounts(dropped: DroppedExample[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of dropped) out[`${d.source}:${d.reason}`] = (out[`${d.source}:${d.reason}`] ?? 0) + 1;
  return out;
}

function printStats(r: CollectResult): void {
  const m = r.manifest;
  const w = (s: string): boolean => process.stdout.write(s);
  w(`dataset ${m.datasetId}  (${m.scrubVersion}, ${m.format})\n`);
  w(`discovery   ${JSON.stringify(r.discovery)}\n`);
  w(`join        ${JSON.stringify(r.joinStats)}\n`);
  w(`examples    ${m.examples}   dropped ${m.dropped}\n`);
  w(`by source   ${JSON.stringify(m.bySource)}\n`);
  w(`by status   ${JSON.stringify(m.byStatus)}\n`);
  w(`by model    ${JSON.stringify(m.byModel)}\n`);
  w(`drops       ${JSON.stringify(dropCounts(r.dropped))}\n`);
  w(`windowing   ${JSON.stringify(r.windowing)}\n`);
  w(`paths       ${JSON.stringify(r.paths)}\n`);
  w(`quality     ${JSON.stringify(m.byQuality)}\n`);
  w(`hand-backs  ${JSON.stringify(r.handBacks)} → ${r.negatives.length} negative(s) for preference training\n`);
  w(`redactions  ${JSON.stringify(m.redactions)}\n`);
  w(`tokens      ${JSON.stringify(m.tokens)}\n`);
  const topTools = Object.entries(m.byTool).sort((a, b) => b[1] - a[1]).slice(0, 15);
  w(`top tools   ${topTools.map(([k, v]) => `${k}=${v}`).join(' ')}\n`);
  w(`denylist    ${r.denylistTerms} term(s) from ~/.bandit/training/denylist.txt\n`);
  if (r.selfCheck.length) {
    const kinds: Record<string, number> = {};
    for (const h of r.selfCheck) kinds[h.kind] = (kinds[h.kind] ?? 0) + 1;
    w(`SELF-CHECK FAILED: ${r.selfCheck.length} leftover secret-looking string(s) ${JSON.stringify(kinds)}\n`);
    w(`  in: ${[...new Set(r.selfCheck.map(h => h.exampleId))].slice(0, 20).join(', ')}\n`);
  } else {
    w('self-check  passed (no secret-looking leftovers)\n');
  }
}

async function writeDataset(r: CollectResult, outDir: string): Promise<void> {
  await fs.promises.mkdir(outDir, { recursive: true });
  const jsonl = r.examples.map(e => JSON.stringify(e)).join('\n') + (r.examples.length ? '\n' : '');
  await fs.promises.writeFile(path.join(outDir, 'examples.jsonl.gz'), zlib.gzipSync(jsonl));
  await fs.promises.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(r.manifest, null, 2));
  // Rejected trajectories (hand-backs) for future preference training; never uploaded as SFT.
  await fs.promises.writeFile(path.join(outDir, 'negatives.jsonl'), r.negatives.map(e => JSON.stringify(e)).join('\n') + (r.negatives.length ? '\n' : ''));
  const report = {
    datasetId: r.manifest.datasetId,
    scrubVersion: r.manifest.scrubVersion,
    redactions: r.manifest.redactions,
    discovery: r.discovery,
    join: r.joinStats,
    dropCounts: dropCounts(r.dropped),
    windowing: r.windowing,
    handBacks: r.handBacks,
    negatives: r.negatives.length,
    dropped: r.dropped.map(d => ({ ref: d.ref, source: d.source, reason: d.reason, ...(d.detail ? { detail: d.detail } : {}) })),
    selfCheck: { passed: r.selfCheck.length === 0, hits: r.selfCheck.map(h => ({ exampleId: h.exampleId, kind: h.kind })) }
  };
  await fs.promises.writeFile(path.join(outDir, 'scrub-report.json'), JSON.stringify(report, null, 2));
}

export async function readDataset(dir: string): Promise<{ manifest: Manifest; examples: TrainingExample[] }> {
  const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const raw = zlib.gunzipSync(await fs.promises.readFile(path.join(dir, 'examples.jsonl.gz'))).toString('utf8');
  const examples = raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as TrainingExample);
  return { manifest, examples };
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

async function inspect(argv: string[]): Promise<number> {
  const dir = argv.find(a => !a.startsWith('--'));
  if (!dir) {
    process.stdout.write('usage: bandit train inspect <dir> [--grep text] [--sample N]\n');
    return 1;
  }
  const grep = argv.includes('--grep') ? argv[argv.indexOf('--grep') + 1] : undefined;
  const sample = argv.includes('--sample') ? parseInt(argv[argv.indexOf('--sample') + 1], 10) : 3;
  const { manifest, examples } = await readDataset(dir);
  process.stdout.write(`${manifest.datasetId}: ${examples.length} example(s)\n`);
  const hits = examples.flatMap(selfCheckExample);
  let pool = examples;
  if (grep) pool = examples.filter(e => JSON.stringify(e.messages).toLowerCase().includes(grep.toLowerCase()));
  const picked = [...pool].sort(() => Math.random() - 0.5).slice(0, sample);
  for (const ex of picked) {
    process.stdout.write(`\n── ${ex.id}  ${ex.source}  ${ex.status}  model=${ex.model ?? '?'}  tools=${ex.labels.toolCalls}  redactions=${JSON.stringify(ex.scrub.redactions)}\n`);
    for (const m of ex.messages) {
      if (m.role === 'system') {
        process.stdout.write(`  system: (${m.content.length} chars)\n`);
      } else if (m.role === 'assistant') {
        if (m.reasoning) process.stdout.write(`  assistant.reasoning: ${clip(m.reasoning, 160)}\n`);
        if (m.content) process.stdout.write(`  assistant: ${clip(m.content, 300)}\n`);
        for (const c of m.tool_calls ?? []) process.stdout.write(`  → ${c.function.name}(${clip(c.function.arguments, 200)})\n`);
      } else if (m.role === 'tool') {
        process.stdout.write(`  ← ${m.name}: ${clip(m.content, 200)}\n`);
      } else {
        process.stdout.write(`  user: ${clip(m.content, 300)}\n`);
      }
    }
  }
  if (hits.length) {
    process.stderr.write(`\nSELF-CHECK FAILED: ${hits.length} leftover secret-looking string(s) in ${new Set(hits.map(h => h.exampleId)).size} example(s): ${JSON.stringify(hits.slice(0, 20))}\n`);
    return 2;
  }
  process.stdout.write('\nself-check passed\n');
  return 0;
}

async function upload(argv: string[], cwd: string): Promise<number> {
  const dir = argv.find(a => !a.startsWith('--'));
  const api = (argv.includes('--api') ? argv[argv.indexOf('--api') + 1] : process.env.BANDIT_TRAINING_API ?? 'https://training.burtson.ai').replace(/\/+$/, '');
  if (!dir) {
    process.stdout.write('usage: bandit train upload <dir> [--api https://training.burtson.ai]\n');
    return 1;
  }
  const { manifest, examples } = await readDataset(dir);
  const hits = examples.flatMap(selfCheckExample);
  if (hits.length || !manifest.selfCheck?.passed) {
    process.stderr.write(`refusing to upload: self-check found ${hits.length} leftover secret-looking string(s). Run \`bandit train inspect ${dir}\`.\n`);
    return 2;
  }
  let token = process.env.BANDIT_TRAINING_TOKEN?.trim();
  if (!token) token = resolveConfig(await loadConfigFiles(cwd), {}).apiKey;
  if (!token) {
    process.stderr.write('set BANDIT_TRAINING_TOKEN (or sign in with `bandit login`) to upload.\n');
    return 1;
  }
  const form = new FormData();
  // Multipart fields (contract v1): manifest, examples, scrub_report — each with its file name.
  const parts = [
    ['manifest', 'manifest.json', 'application/json'],
    ['examples', 'examples.jsonl.gz', 'application/gzip'],
    ['scrub_report', 'scrub-report.json', 'application/json']
  ] as const;
  for (const [field, name, type] of parts) {
    const bytes = await fs.promises.readFile(path.join(dir, name));
    form.append(field, new Blob([bytes], { type }), name);
  }
  const res = await fetch(`${api}/api/datasets`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const text = await res.text();
  if (!res.ok) {
    process.stderr.write(`upload failed: HTTP ${res.status} ${text.slice(0, 300)}\n`);
    return 1;
  }
  process.stdout.write(`uploaded ${manifest.datasetId} (${examples.length} examples) → ${api}\n${text.slice(0, 500)}\n`);
  return 0;
}

export async function runTrainCommand(argv: string[], cwd: string, version: string): Promise<number> {
  const sub = argv[0];
  try {
    if (sub === 'collect') {
      const args = parseCollectArgs(argv.slice(1));
      const result = await collect(args, version);
      printStats(result);
      if (!args.dryRun) {
        const outDir = args.out
          ? path.resolve(cwd, args.out.replace(/^~(?=$|\/)/, os.homedir()))
          : path.join(trainingHome(), result.manifest.datasetId);
        await writeDataset(result, outDir);
        process.stdout.write(`wrote ${outDir}\n  manifest.json  examples.jsonl.gz  scrub-report.json  negatives.jsonl\n`);
        process.stdout.write(`next: bandit train inspect ${outDir}   then   bandit train upload ${outDir}\n`);
      }
      return result.selfCheck.length ? 2 : 0;
    }
    if (sub === 'inspect') return await inspect(argv.slice(1));
    if (sub === 'upload') return await upload(argv.slice(1), cwd);
  } catch (err) {
    process.stderr.write(`bandit train ${sub}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stdout.write(
    'usage:\n' +
    '  bandit train collect [--out dir] [--since YYYY-MM-DD] [--sources cli-session,stealth-web,banditbench]\n' +
    '                       [--keep-nudges] [--max-secrets N] [--workspaces a,b] [--banditbench dir] [--history N]\n' +
    '                       [--window-tokens N] [--window-mode chunks|tail] [--min-quality none|completed|edited|completed-or-unknown-with-tools]\n' +
    '                       [--include-handbacks] [--dry-run]\n' +
    '  bandit train inspect <dir> [--grep text] [--sample N]\n' +
    '  bandit train upload  <dir> [--api https://training.burtson.ai]\n'
  );
  return sub ? 1 : 0;
}

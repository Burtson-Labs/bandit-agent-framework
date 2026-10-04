#!/usr/bin/env node
/**
 * Synthetic edit-task generator for Training Studio teacher data.
 *
 * Writes N randomized eval fixtures into <out>/.bandit/evals/*.mjs (the harness's workspace
 * fixture format), so a teacher model can be run through the real Bandit tool loop:
 *
 *   node scripts/synthetic-tasks.mjs --out ~/bandit-synth --count 300 --seed 20261004
 *   cd ~/bandit-synth && node <cli>/dist/__eval__/eval.js --only-workspace --runs 1 \
 *     --provider bandit --model bandit-logic-2 --exclude-tools apply_patch \
 *     --concurrency 6 --trace-out ~/bandit-synth/traces
 *
 * The task FAMILIES mirror the skills BanditBench measures (locate-then-edit, multi-file
 * rename, doc comments, config change, version bump, changelog, create file, read/answer,
 * synthesis, honest missing file, no-tools restraint, failing command, edit-then-verify), but
 * the content is generated from separate vocabularies and checked against every builtin
 * fixture so BanditBench stays a held-out eval. Every edit task asserts the final file
 * content, not just the tool choice.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const OUT = path.resolve((args.out ?? '').replace(/^~(?=\/)/, process.env.HOME));
const COUNT = parseInt(args.count ?? '300', 10);
let seed = parseInt(args.seed ?? '20261004', 10) >>> 0;
if (!args.out) { console.error('usage: synthetic-tasks.mjs --out <dir> [--count N] [--seed S] [--families a,b]'); process.exit(2); }

// ---- seeded randomness ------------------------------------------------------------------------
function rand() { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = xs => xs[Math.floor(rand() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const shuffle = xs => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const sample = (xs, n) => shuffle(xs).slice(0, n);

// Vocabulary deliberately disjoint from the builtin fixtures (checked below).
const DOMAINS = ['orchard', 'harbor', 'glacier', 'bakery', 'observatory', 'aquarium', 'vineyard', 'lighthouse', 'greenhouse', 'quarry', 'monastery', 'carnival', 'apiary', 'tannery', 'brewery', 'stable', 'marina', 'foundry', 'pantry', 'kiln'];
const NOUNS = ['ticket', 'parcel', 'voucher', 'ledger', 'shipment', 'roster', 'beacon', 'sensor', 'invoice', 'satchel', 'pallet', 'coupon', 'badge', 'lantern', 'crate', 'docket', 'harvest', 'batch', 'tariff', 'quota'];
const VERBS = ['compute', 'resolve', 'tally', 'normalize', 'reconcile', 'estimate', 'allocate', 'stamp', 'encode', 'sweep', 'rotate', 'grade', 'route', 'audit', 'pack'];
const ADJ = ['Primary', 'Spare', 'Nightly', 'Regional', 'Pending', 'Archived', 'Bulk', 'Express', 'Seasonal', 'Remote'];
const QUALS = ['MAX', 'MIN', 'BASE', 'DEFAULT', 'SOFT', 'HARD'];
const UNITS = ['LIMIT', 'WINDOW_SEC', 'BATCH_SIZE', 'RETRY_COUNT', 'POOL_SIZE', 'TTL_MS', 'THRESHOLD', 'QUOTA'];
const cap = s => s[0].toUpperCase() + s.slice(1);
const camel = (...ws) => ws[0] + ws.slice(1).map(cap).join('');
const pascal = (...ws) => ws.map(cap).join('');
const snake = (...ws) => ws.join('_');
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// ---- language helpers ---------------------------------------------------------------------------
const LANGS = {
  ts: { ext: 'ts', constDef: (n, v) => `export const ${n} = ${v};`, constImport: (n, from) => `import { ${n} } from './${from}';`, fn: (name, body) => `export function ${name}(value: number): number {\n  ${body}\n}`, comment: t => `/** ${t} */` },
  js: { ext: 'js', constDef: (n, v) => `export const ${n} = ${v};`, constImport: (n, from) => `import { ${n} } from './${from}.js';`, fn: (name, body) => `export function ${name}(value) {\n  ${body}\n}`, comment: t => `/** ${t} */` },
  py: { ext: 'py', constDef: (n, v) => `${n} = ${v}`, constImport: (n, from) => `from .${from} import ${n}`, fn: (name, body) => `def ${name}(value):\n    ${body.replace(/;$/, '')}`, comment: t => `# ${t}` },
  go: { ext: 'go', constDef: (n, v) => `const ${n} = ${v}`, constImport: () => '', fn: (name, body) => `func ${name}(value int) int {\n\t${body.replace(/;$/, '')}\n}`, comment: t => `// ${t}` },
  cs: { ext: 'cs', constDef: (n, v) => `public static class Limits { public const int ${n} = ${v}; }`, constImport: () => 'using App.Config;', fn: (name, body) => `public static int ${name}(int value)\n{\n    ${body}\n}`, comment: t => `/// <summary>${t}</summary>` }
};

const EDIT_TOOLS = /^(apply_edit|replace_range)$/;
const NO_PATCH = ['apply_patch'];

// ---- families -----------------------------------------------------------------------------------
const FAMILIES = {
  search_edit() {
    const lang = pick(['ts', 'js', 'py', 'go', 'cs']); const L = LANGS[lang];
    const name = snake(pick(QUALS), pick(NOUNS).toUpperCase(), pick(UNITS));
    const decoy = `${name}_LEGACY`;
    const from = int(2, 40) * 5; let to = int(2, 80) * 10; if (to === from) to += 7;
    const dir = pick(['src/core', 'lib', 'pkg/tuning', 'app/shared', 'internal/limits']);
    const defFile = `${dir}/${pick(NOUNS)}_limits.${L.ext}`;
    const files = { [defFile]: `${L.constDef(name, from)}\n${L.constDef(decoy, from)}\n` };
    const users = int(1, 3);
    for (let i = 0; i < users; i++) {
      const f = `${dir}/${pick(VERBS)}_${pick(NOUNS)}${i}.${L.ext}`;
      files[f] = `${L.constImport(name, path.basename(defFile, '.' + L.ext))}\n\n// uses ${name}\n${L.fn(camel(pick(VERBS), pick(NOUNS)), lang === 'py' || lang === 'go' ? `return value * ${name}` : `return value * ${name};`)}\n`;
    }
    files['README.md'] = `# ${pick(DOMAINS)} service\n\nLimits live in ${dir}.\n`;
    const expected = files[defFile].replace(`${L.constDef(name, from)}`, L.constDef(name, to));
    return {
      prompt: `${name} is wrong. Find where it is defined and change its value from ${from} to ${to}. Leave ${decoy} alone.`,
      files,
      assertions: {
        mustCallAllOf: [{ name: /^(search_code|list_files|read_file)$/ }, { name: EDIT_TOOLS, params: { path: new RegExp(reEsc(path.basename(defFile)) + '$') } }],
        mustNotCall: ['write_file', ...NO_PATCH],
        finalFiles: Object.fromEntries(Object.entries(files).map(([f, c]) => [f, f === defFile ? expected : c])),
        maxIterations: 8
      },
      maxIterations: 10
    };
  },

  multi_rename() {
    const lang = pick(['ts', 'js', 'py']); const L = LANGS[lang];
    const oldName = camel(pick(VERBS), pick(NOUNS)); let newName = camel(pick(VERBS), pick(NOUNS), 'value');
    if (lang === 'py') { newName = newName.replace(/[A-Z]/g, c => '_' + c.toLowerCase()); }
    const old = lang === 'py' ? oldName.replace(/[A-Z]/g, c => '_' + c.toLowerCase()) : oldName;
    const base = pick(['src', 'lib', 'app']);
    const defFile = `${base}/${pick(NOUNS)}_math.${L.ext}`;
    const files = { [defFile]: `${L.fn(old, lang === 'py' ? 'return value + 1' : 'return value + 1;')}\n` };
    const callers = sample(NOUNS, int(2, 3)).map((n, i) => `${base}/${n}_view${i}.${L.ext}`);
    const modName = path.basename(defFile, '.' + L.ext);
    for (const f of callers) {
      files[f] = lang === 'py'
        ? `from .${modName} import ${old}\n\n\ndef show(x):\n    return ${old}(x) * 2\n`
        : `import { ${old} } from './${modName}${lang === 'js' ? '.js' : ''}';\n\nexport const shown = (x${lang === 'ts' ? ': number' : ''}) => ${old}(x) * 2;\n`;
    }
    const finalFiles = Object.fromEntries(Object.entries(files).map(([f, c]) => [f, c.split(old).join(newName)]));
    return {
      prompt: `Rename the function ${old} to ${newName} everywhere it is defined or used in this project.`,
      files,
      assertions: {
        mustCallAllOf: [{ name: EDIT_TOOLS, params: { path: new RegExp(reEsc(path.basename(defFile)) + '$') } }, ...callers.map(f => ({ name: /^(apply_edit|replace_range|write_file)$/, params: { path: new RegExp(reEsc(path.basename(f)) + '$') } }))],
        mustNotCall: NO_PATCH,
        finalFiles,
        maxIterations: 14
      },
      maxIterations: 16
    };
  },

  doc_comments() {
    const lang = pick(['ts', 'js', 'py', 'go']); const L = LANGS[lang];
    const fns = sample(VERBS, int(3, 5)).map(v => camel(v, pick(NOUNS)));
    const targets = sample(fns, int(1, 2));
    const file = `${pick(['src', 'lib', 'pkg'])}/${pick(DOMAINS)}_${pick(NOUNS)}s.${L.ext}`;
    const body = lang === 'py' || lang === 'go' ? 'return value * 2' : 'return value * 2;';
    const content = fns.map(f => L.fn(f, body)).join('\n\n') + '\n';
    const notes = Object.fromEntries(targets.map(t => [t, `${cap(t.replace(/[A-Z]/g, c => ' ' + c.toLowerCase()))} for the ${pick(DOMAINS)} desk.`]));
    const finalRe = new RegExp(targets.map(t => `(?=[\\s\\S]*${reEsc(L.comment(notes[t]).split(notes[t])[0].trim())}[^\\n]*${reEsc(notes[t].slice(0, 24))}[^\\n]*\\n${lang === 'cs' ? '' : '[^\\n]*'}${reEsc(t)})`).join(''));
    return {
      prompt: `In ${file}, add a one-line doc comment directly above ${targets.map(t => `${t} reading "${notes[t]}"`).join(' and above ')}. Don't change any code.`,
      files: { [file]: content, 'NOTES.md': '# notes\n' },
      assertions: {
        mustCallAnyOf: [{ name: EDIT_TOOLS, params: { path: new RegExp(reEsc(path.basename(file)) + '$') } }],
        mustNotCall: ['write_file', ...NO_PATCH],
        finalFiles: { [file]: finalRe },
        maxIterations: 8
      },
      maxIterations: 10
    };
  },

  config_change() {
    const yaml = rand() < 0.5;
    const section = pick(['cache', 'queue', 'mailer', 'scheduler', 'uploads']); const other = pick(['metrics', 'search', 'billing', 'auth'].filter(x => x !== section));
    const key = pick(['timeoutSeconds', 'maxItems', 'workers', 'retries', 'batchSize']);
    const from = int(2, 30); let to = int(31, 300);
    const file = yaml ? `config/${pick(DOMAINS)}.yaml` : `config/${pick(DOMAINS)}.json`;
    const obj = { [section]: { [key]: from, enabled: true }, [other]: { [key]: from, enabled: false } };
    const render = o => yaml
      ? Object.entries(o).map(([s, v]) => `${s}:\n${Object.entries(v).map(([k, x]) => `  ${k}: ${x}`).join('\n')}`).join('\n') + '\n'
      : JSON.stringify(o, null, 2) + '\n';
    const after = JSON.parse(JSON.stringify(obj)); after[section][key] = to;
    return {
      prompt: `Set ${section}.${key} to ${to} in ${file}. The ${other} section must keep its current value.`,
      files: { [file]: render(obj), 'README.md': `# ${pick(DOMAINS)} config\n` },
      assertions: { mustCallAnyOf: [{ name: EDIT_TOOLS, params: { path: new RegExp(reEsc(path.basename(file)) + '$') } }], mustNotCall: ['write_file', ...NO_PATCH], finalFiles: { [file]: render(after) }, maxIterations: 6 },
      maxIterations: 8
    };
  },

  version_bump() {
    const kind = pick(['package.json', 'pyproject.toml', 'csproj']);
    const [a, b, c] = [int(0, 4), int(0, 20), int(0, 30)];
    const from = `${a}.${b}.${c}`, to = `${a}.${b}.${c + 1}`;
    const name = `${pick(DOMAINS)}-${pick(NOUNS)}s`;
    let file, before;
    if (kind === 'package.json') { file = 'package.json'; before = JSON.stringify({ name, version: from, private: true, scripts: { start: 'node index.js' } }, null, 2) + '\n'; }
    else if (kind === 'pyproject.toml') { file = 'pyproject.toml'; before = `[project]\nname = "${name}"\nversion = "${from}"\nrequires-python = ">=3.10"\n`; }
    else { file = `${pascal(pick(DOMAINS), pick(NOUNS))}.csproj`; before = `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <Version>${from}</Version>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n`; }
    return {
      prompt: 'Bump the patch version of this project and tell me the new version.',
      files: { [file]: before, 'CHANGES.txt': `${from}: initial\n` },
      assertions: { mustCallAnyOf: [{ name: EDIT_TOOLS, params: { path: new RegExp(reEsc(file) + '$') } }], mustNotCall: ['write_file', ...NO_PATCH], finalFiles: { [file]: before.replace(from, to), 'CHANGES.txt': `${from}: initial\n` }, finalResponseMatches: new RegExp(reEsc(to)), maxIterations: 6 },
      maxIterations: 8
    };
  },

  changelog_append() {
    const item = `${cap(pick(VERBS))} ${pick(NOUNS)} totals for ${pick(DOMAINS)} reports`;
    const before = `# History\n\n## Unreleased\n\n- ${cap(pick(VERBS))} ${pick(NOUNS)} export\n\n## 1.${int(0, 9)}.0\n\n- First public build\n`;
    return {
      prompt: `Add "${item}" as a new bullet at the end of the Unreleased section of HISTORY.md.`,
      files: { 'HISTORY.md': before, 'src/index.js': 'console.log("ok");\n' },
      assertions: { mustCallAnyOf: [{ name: EDIT_TOOLS, params: { path: /HISTORY\.md$/ } }], mustNotCall: ['write_file', ...NO_PATCH], finalFiles: { 'HISTORY.md': new RegExp(`## Unreleased\\n\\n- [^\\n]+\\n- ${reEsc(item)}\\n\\n## 1\\.`) }, maxIterations: 6 },
      maxIterations: 8
    };
  },

  create_file() {
    const lang = pick(['ts', 'py', 'md']);
    const file = lang === 'md' ? `docs/${pick(DOMAINS)}-${pick(NOUNS)}.md` : `${lang === 'py' ? 'tools' : 'src/util'}/${pick(NOUNS)}_${pick(VERBS)}.${lang}`;
    const content = lang === 'md'
      ? `# ${cap(pick(DOMAINS))} ${pick(NOUNS)}s\n\nOwner: ${pick(ADJ)} team\n`
      : lang === 'py' ? `def ${pick(VERBS)}_${pick(NOUNS)}(value):\n    return value * ${int(2, 9)}\n` : `export const ${camel(pick(ADJ).toLowerCase(), pick(NOUNS))} = ${int(10, 999)};\n`;
    return {
      prompt: `Create ${file} with exactly this content:\n\n${content}`,
      files: { 'README.md': `# ${pick(DOMAINS)}\n` },
      assertions: { mustCallAnyOf: ['write_file'], mustNotCall: NO_PATCH, finalFiles: { [file]: content }, maxIterations: 4 },
      maxIterations: 6
    };
  },

  read_answer() {
    const port = int(3001, 9900), region = pick(['eu-north', 'ap-east', 'us-central', 'sa-west']), owner = `${pick(ADJ)} ${pick(DOMAINS)}`;
    const file = `deploy/${pick(DOMAINS)}.json`;
    return {
      prompt: `Which port, region and owner does ${file} configure? Don't change anything.`,
      files: { [file]: JSON.stringify({ service: { port, region }, meta: { owner } }, null, 2) + '\n', 'deploy/old.json': JSON.stringify({ service: { port: port + 1, region: 'retired' } }, null, 2) + '\n' },
      assertions: { mustCallAnyOf: [{ name: 'read_file', params: { path: new RegExp(reEsc(path.basename(file)) + '$') } }], mustNotCall: ['write_file', 'apply_edit', 'replace_range', ...NO_PATCH], finalResponseMatches: new RegExp(`(?=[\\s\\S]*${port})(?=[\\s\\S]*${reEsc(region)})(?=[\\s\\S]*${reEsc(owner)})`), maxIterations: 4 },
      maxIterations: 6
    };
  },

  multi_synthesis() {
    const parts = sample(NOUNS, 3).map(n => ({ n, v: int(2, 99), f: `limits/${n}.yaml` }));
    const files = Object.fromEntries(parts.map(p => [p.f, `name: ${p.n}\ncap: ${p.v}\n`]));
    const total = parts.reduce((s, p) => s + p.v, 0);
    return {
      prompt: `Read the three files in limits/ and tell me each cap and their total. Don't edit anything.`,
      files,
      assertions: { mustCallAnyOf: ['read_file'], mustNotCall: ['write_file', 'apply_edit', 'replace_range', ...NO_PATCH], finalResponseMatches: new RegExp(parts.map(p => `(?=[\\s\\S]*${p.v})`).join('') + `(?=[\\s\\S]*${total})`), maxIterations: 6 },
      maxIterations: 8
    };
  },

  missing_file() {
    const ghost = `${pick(['src', 'lib', 'docs'])}/${pick(DOMAINS)}_${pick(NOUNS)}_${pick(VERBS)}.${pick(['ts', 'py', 'md'])}`;
    return {
      prompt: `Summarize what ${ghost} does.`,
      files: { 'src/main.ts': 'export const ok = true;\n', 'README.md': `# ${pick(DOMAINS)}\n` },
      assertions: { mustNotCall: ['write_file', 'apply_edit', 'replace_range', ...NO_PATCH], finalResponseMatches: /doesn['’]t exist|does not exist|no such file|not found|couldn['’]t find|could not find|isn['’]t (?:present|there)|missing/i, maxIterations: 4 },
      maxIterations: 5
    };
  },

  no_tools() {
    const q = pick([
      ['What does an HTTP 503 response mean?', /unavailable|overload|maintenance/i],
      ['In git, what is the difference between merge and rebase? Keep it short.', /rebase[\s\S]*(rewrite|replay|linear)|histor/i],
      ['What is the time complexity of binary search?', /log/i],
      ['What does the SQL keyword DISTINCT do?', /duplicate|unique/i],
      ['Explain what a race condition is in one or two sentences.', /concurren|simultaneous|order|timing/i],
      ['What port does HTTPS use by default?', /443/],
      ['What is the difference between a process and a thread?', /memory|address space|share/i]
    ]);
    return {
      prompt: q[0],
      files: { 'README.md': `# ${pick(DOMAINS)}\n` },
      assertions: { mustNotCall: ['read_file', 'list_files', 'search_code', 'run_command', 'write_file', 'apply_edit', 'replace_range', 'ls', ...NO_PATCH], finalResponseMatches: q[1], maxIterations: 2 },
      maxIterations: 3
    };
  },

  failing_command() {
    const code = int(2, 9), word = pick(['checksum mismatch', 'schema drift', 'missing seed rows', 'stale lockfile']);
    const script = `scripts/inspect_${pick(NOUNS)}.js`;
    return {
      prompt: `Run node ${script} and tell me if it succeeds.`,
      files: { [script]: `console.error('inspect: ${word}');\nprocess.exit(${code});\n`, 'package.json': `{ "name": "${pick(DOMAINS)}-tools", "private": true }\n` },
      assertions: { mustCallAnyOf: [{ name: 'run_command', params: { commandLine: new RegExp(reEsc(path.basename(script))) } }], mustNotCall: ['write_file', 'apply_edit', 'replace_range', ...NO_PATCH], finalResponseMatches: new RegExp(`(?=[\\s\\S]*(fail|did not pass|didn['’]t pass|error|exit(ed)? (with )?(code )?${code}))(?=[\\s\\S]*${reEsc(word.split(' ')[0])})`, 'i'), maxIterations: 4 },
      maxIterations: 5
    };
  },

  edit_then_verify() {
    const fn = camel(pick(VERBS), pick(NOUNS)), mult = int(3, 9), wrong = mult + int(1, 3), input = int(2, 12);
    const file = `src/${pick(NOUNS)}.js`;
    const testFile = 'test/run.js';
    return {
      prompt: `${fn} in ${file} multiplies by ${wrong} but should multiply by ${mult}. Fix it, then run the tests with npm test and tell me the result.`,
      files: {
        [file]: `function ${fn}(value) {\n  return value * ${wrong};\n}\n\nmodule.exports = { ${fn} };\n`,
        [testFile]: `const assert = require('assert');\nconst { ${fn} } = require('../${file.replace(/\.js$/, '')}');\nassert.strictEqual(${fn}(${input}), ${input * mult});\nconsole.log('all ${pick(NOUNS)} checks passed');\n`,
        'package.json': JSON.stringify({ name: `${pick(DOMAINS)}-calc`, private: true, scripts: { test: `node ${testFile}` } }, null, 2) + '\n'
      },
      assertions: {
        mustCallAllOf: [{ name: EDIT_TOOLS, params: { path: new RegExp(reEsc(path.basename(file)) + '$') } }, { name: 'run_command', params: { commandLine: /npm (run )?test|node test/ } }],
        mustNotCall: ['write_file', ...NO_PATCH],
        finalFiles: { [file]: `function ${fn}(value) {\n  return value * ${mult};\n}\n\nmodule.exports = { ${fn} };\n` },
        finalResponseMatches: /pass/i,
        maxIterations: 8
      },
      maxIterations: 10
    };
  }
};

// ---- overlap guard -----------------------------------------------------------------------------
function builtinVocabulary() {
  const dir = path.resolve(here, '../src/__eval__/fixtures');
  const words = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    for (const w of fs.readFileSync(path.join(dir, f), 'utf8').match(/[A-Za-z_][A-Za-z0-9_]{5,}/g) ?? []) words.add(w);
  }
  return words;
}
const COMMON = new Set(['README', 'return', 'export', 'import', 'function', 'number', 'string', 'private', 'version', 'console', 'value', 'values', 'project', 'process', 'module', 'exports', 'require', 'assert', 'strictEqual', 'scripts', 'content', 'section', 'enabled', 'should', 'without', 'change', 'exactly', 'anything', 'during', 'search_code', 'list_files', 'read_file', 'apply_edit', 'replace_range', 'write_file', 'run_command', 'apply_patch', 'Unreleased', 'package', 'config', 'deploy', 'service', 'region', 'Summarize', 'comment', 'doesn', 'Create', 'Rename', 'defined', 'everywhere', 'wrong', 'tests', 'result', 'multiplies', 'should', 'public', 'static', 'History', 'History', 'PropertyGroup', 'TargetFramework', 'Project', 'Microsoft', 'requires', 'python', 'restraint', 'timeout', 'workers', 'retries', 'cache', 'queue', 'search', 'metrics', 'billing', 'export', 'Express', 'Remote', 'Primary', 'MAX', 'DEFAULT', 'LIMIT', 'THRESHOLD', 'shipment', 'invoice', 'ledger', 'quota']);

// ---- write ---------------------------------------------------------------------------------------
const familyNames = (args.families ? args.families.split(',') : Object.keys(FAMILIES));
const evalsDir = path.join(OUT, '.bandit', 'evals');
fs.mkdirSync(evalsDir, { recursive: true });
for (const f of fs.readdirSync(evalsDir)) if (f.startsWith('syn-')) fs.unlinkSync(path.join(evalsDir, f));
const vocab = builtinVocabulary();
const counts = {};
const overlaps = new Map();
const serialize = v => {
  if (v instanceof RegExp) return v.toString();
  if (Array.isArray(v)) return `[${v.map(serialize).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${serialize(x)}`).join(', ')} }`;
  return JSON.stringify(v);
};
for (let i = 0; i < COUNT; i++) {
  const family = familyNames[i % familyNames.length];
  const task = FAMILIES[family]();
  const id = `syn.${family}.${String(i).padStart(4, '0')}`;
  const text = task.prompt + JSON.stringify(task.files);
  for (const w of text.match(/[A-Za-z_][A-Za-z0-9_]{5,}/g) ?? []) {
    if (vocab.has(w) && !COMMON.has(w)) overlaps.set(w, (overlaps.get(w) ?? 0) + 1);
  }
  const fixture = {
    id, description: `synthetic ${family}`, prompt: task.prompt,
    setup: { files: task.files }, assertions: task.assertions, runs: 1, passThreshold: 1,
    maxIterations: task.maxIterations, excludeTools: ['apply_patch']
  };
  fs.writeFileSync(path.join(evalsDir, `${id.replace(/\./g, '-')}.mjs`), `export default ${serialize(fixture)};\n`);
  counts[family] = (counts[family] ?? 0) + 1;
}
console.log(JSON.stringify({ out: evalsDir, total: COUNT, byFamily: counts, overlapWithBuiltins: Object.fromEntries([...overlaps].sort((a, b) => b[1] - a[1])) }, null, 2));

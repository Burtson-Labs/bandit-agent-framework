/**
 * Live give-up bench: the 2026-11-15 failure, against real models.
 *
 * A cloud turn asked to "add a comment in the file where the apple o auth
 * and other provider logic is ... make a pull request" ran one search and an
 * `ls`, answered in prose and stopped with no edit. This replays that prompt
 * (or any other) on a fresh copy of a repository, through the built runner
 * (`dist/turn.js`, text tool channel as production runs it), and reports per
 * run: terminal event, reminders sent, tool calls, files changed, and whether
 * the expected file changed. Run with nudges off and on to see what the
 * give-up recovery buys for each model.
 *
 *   pnpm build
 *   node scripts/giveup-bench.mjs --repo ~/Documents/GitHub/AuthApi \
 *     --models kimi-k3:cloud,qwen3.6:27b --runs 3 --nudges 0,2 \
 *     --expect AuthApi/Services/OAuthService.cs
 *
 * Flags: --ollama <url> (default http://127.0.0.1:11434), --prompt <text>,
 * --max-iterations <n> (default 40), --native (native tool channel),
 * --out <file.json>, --dist <dir> (another runner build, for before/after).
 * The repository is copied with `git archive HEAD`, so
 * only tracked files are seen and the original is never touched.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const repo = flag('repo');
if (!repo) {
  console.error('--repo <path to a git repository> is required');
  process.exit(2);
}
const prompt =
  flag('prompt') ??
  'Can you add a comment in the file where the apple o auth and other provider logic is I want to see a ninja emoji at the top of the file make a pull request please';
const models = (flag('models') ?? 'qwen3.6:27b').split(',').filter(Boolean);
const nudgeSettings = (flag('nudges') ?? '0,2').split(',').map(Number);
const runs = Number(flag('runs') ?? '1');
const ollama = flag('ollama') ?? 'http://127.0.0.1:11434';
const maxIterations = Number(flag('max-iterations') ?? '40');
const expect = flag('expect');
const out = flag('out');
const nativeTools = has('native');

process.env.RUNNER_GRAPH ??= '0';
// --dist <dir> runs another build of the runner (e.g. origin/main's) for a
// before/after comparison; maxNudges is ignored by builds that predate it.
const distDir = flag('dist');
const { runTurn } = await import(
  distDir ? new URL(`file://${resolve(distDir)}/turn.js`).href : new URL('../dist/turn.js', import.meta.url).href
);

function freshCopy() {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'giveup-bench-')));
  const tar = execFileSync('git', ['-C', resolve(repo), 'archive', 'HEAD'], { maxBuffer: 512 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', ws], { input: tar });
  execFileSync('git', ['init', '-q'], { cwd: ws });
  execFileSync('git', ['add', '-A'], { cwd: ws });
  execFileSync('git', ['-c', 'user.email=bench@burtson.ai', '-c', 'user.name=bench', 'commit', '-qm', 'baseline'], { cwd: ws });
  return ws;
}

const results = [];
for (const model of models) {
  for (const maxNudges of nudgeSettings) {
    for (let r = 1; r <= runs; r += 1) {
      const ws = freshCopy();
      const events = [];
      const started = Date.now();
      try {
        await runTurn(
          {
            protocol: 1,
            taskId: `bench-${r}`,
            workspacePath: ws,
            prompt,
            provider: { kind: 'ollama', baseUrl: ollama, model },
            maxIterations,
          },
          (e) => events.push(e),
          { permissionMode: 'standard', nativeTools, maxNudges },
        );
      } catch (err) {
        events.push({ type: 'turn.error', code: 'BENCH_THREW', message: String(err?.message ?? err) });
      }
      const changed = execFileSync('git', ['status', '--porcelain'], { cwd: ws, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(3));
      const terminal = events.at(-1) ?? {};
      const calls = events.filter((e) => e.type === 'tool.call').map((e) => e.tool);
      const row = {
        model,
        maxNudges,
        run: r,
        seconds: Math.round((Date.now() - started) / 1000),
        terminal: terminal.type === 'turn.error' ? `error ${terminal.code}` : 'completed',
        nudges: events.filter((e) => e.type === 'turn.nudged').length,
        toolCalls: calls.length,
        tools: calls.join(' '),
        changed,
        expectedChanged: expect ? changed.includes(expect) : undefined,
        lastReply: String(terminal.assistantText ?? terminal.message ?? '').replace(/\s+/g, ' ').slice(0, 240),
      };
      results.push(row);
      console.log(
        `${model.padEnd(22)} nudges≤${maxNudges} r${r}  ${row.terminal.padEnd(32)} ` +
          `${String(row.seconds).padStart(4)}s  reminders ${row.nudges}  calls ${String(row.toolCalls).padStart(2)}  ` +
          `changed [${changed.join(', ')}]${expect ? (row.expectedChanged ? '  ✓ expected' : '  ✗ expected') : ''}`,
      );
      console.log(`    tools: ${row.tools}`);
      if (row.lastReply) console.log(`    last: ${row.lastReply}`);
      rmSync(ws, { recursive: true, force: true });
    }
  }
}

if (out) writeFileSync(out, JSON.stringify({ prompt, ollama, maxIterations, nativeTools, results }, null, 2));

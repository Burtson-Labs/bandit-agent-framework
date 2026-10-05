import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultLanguageAdapters } from '@burtson-labs/agent-core';
import {
  EvalSandboxContext,
  SANDBOX_WORKSPACE_REL,
  createSandboxLayout,
  isSandboxViolation,
  sandboxEnv,
  type EvalSandboxLayout
} from '../src/__eval__/sandboxContext';
import { buildRunTrace, TRACE_WORKSPACE } from '../src/__eval__/traceOut';
import { runFixture, type RunnerProvider } from '../src/__eval__/runner';
import type { Fixture } from '../src/__eval__/types';

const roots: string[] = [];
afterEach(() => { for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function sandbox(): Promise<{ ctx: EvalSandboxContext; layout: EvalSandboxLayout }> {
  const layout = await createSandboxLayout('bandit-eval-sbx-');
  roots.push(layout.root);
  return { ctx: new EvalSandboxContext(layout, createDefaultLanguageAdapters()), layout };
}

describe('eval sandbox: layout', () => {
  it('puts the workspace under a private home, inside a real-path root', async () => {
    const { layout } = await sandbox();
    expect(layout.root).toBe(fs.realpathSync(layout.root));
    expect(layout.home).toBe(path.join(layout.root, 'home'));
    expect(layout.workspace).toBe(path.join(layout.home, SANDBOX_WORKSPACE_REL));
    expect(fs.statSync(layout.workspace).isDirectory()).toBe(true);
  });
});

describe('eval sandbox: the home directory is the sandbox, never the real one', () => {
  it('resolves ~ to the sandbox home for reads and listings', async () => {
    const { ctx, layout } = await sandbox();
    fs.mkdirSync(path.join(layout.home, 'Downloads'));
    fs.writeFileSync(path.join(layout.home, 'Downloads', 'report.pdf'), 'x');
    expect(await ctx.listDirectoryEntries('~/Downloads')).toEqual(['report.pdf']);
    expect(await ctx.readFile('~/Downloads/report.pdf')).toBe('x');
    expect(await ctx.listFiles('*', '~/Downloads')).toHaveLength(1);
    expect(ctx.denials).toEqual([]);
  });

  it('a home path that does not exist is an ordinary "not there", not a denial', async () => {
    const { ctx } = await sandbox();
    await expect(ctx.listDirectoryEntries('~/Documents/GitHub')).rejects.toThrow(/ENOENT/);
    expect(ctx.denials).toEqual([]);
  });

  it('runs commands with HOME pointing at the sandbox and ~ arguments expanded into it', async () => {
    const { ctx, layout } = await sandbox();
    fs.writeFileSync(path.join(layout.home, 'note.txt'), 'from the sandbox home');
    const home = await ctx.runCommand('node', ['-e', 'process.stdout.write(process.env.HOME)']);
    expect(home.stdout).toBe(layout.home);
    const cat = await ctx.runCommand('cat', ['~/note.txt']);
    expect(cat.stdout).toBe('from the sandbox home');
    expect(ctx.denials).toEqual([]);
  });

  it('accepts a sibling directory as a command cwd', async () => {
    const { ctx, layout } = await sandbox();
    fs.mkdirSync(path.join(layout.home, 'projects', 'other'));
    const pwd = await ctx.runCommand('node', ['-e', 'process.stdout.write(process.cwd())'], '../other');
    expect(pwd.stdout).toBe(path.join(layout.home, 'projects', 'other'));
  });
});

describe('eval sandbox: what is refused', () => {
  it('refuses anything outside the root and records what was asked for', async () => {
    const { ctx } = await sandbox();
    await expect(ctx.runCommand('git', ['status'], '/workspace')).rejects.toThrow(/outside the workspace \(run\)/);
    await expect(ctx.searchCode('x', '/workspace/repo')).rejects.toThrow(/Permission denied/);
    await expect(ctx.runCommand('git', ['-C', '/tmp/some-other-project', 'log'])).rejects.toThrow(/run argument/);
    await expect(ctx.runCommand('ls', [os.homedir()])).rejects.toThrow(/Permission denied/);
    expect(ctx.denials).toEqual([
      { kind: 'run', path: '/workspace' },
      { kind: 'search', path: '/workspace/repo' },
      { kind: 'run argument', path: '/tmp/some-other-project' },
      { kind: 'run argument', path: os.homedir() }
    ]);
    expect(ctx.denials.some(isSandboxViolation)).toBe(false);
  });

  it('names the working directory in the error so the model can correct itself', async () => {
    const { ctx, layout } = await sandbox();
    await expect(ctx.readFile('/workspace/src/app.ts')).rejects.toThrow(layout.workspace);
  });

  it('refuses writes and deletes outside the workspace even under the sandbox home', async () => {
    const { ctx, layout } = await sandbox();
    await expect(ctx.writeFile('~/Documents/GitHub/widget/sample.ts', 'x')).rejects.toThrow(/outside the workspace \(write\)/);
    await expect(ctx.deleteFile('~/note.txt')).rejects.toThrow(/outside the workspace \(delete\)/);
    expect(fs.existsSync(path.join(layout.home, 'Documents'))).toBe(false);
    expect(ctx.denials.every(isSandboxViolation)).toBe(true);
  });

  it('treats the same directory reached through a symlinked prefix as inside', async () => {
    const { ctx, layout } = await sandbox();
    const link = path.join(os.tmpdir(), `bandit-eval-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(layout.root, link);
    roots.push(link);
    await ctx.writeFile(path.join(link, 'home', SANDBOX_WORKSPACE_REL, 'a.txt'), 'through the link');
    expect(fs.readFileSync(path.join(layout.workspace, 'a.txt'), 'utf8')).toBe('through the link');
    expect(ctx.denials).toEqual([]);
  });

  it('does not follow a symlink that leaves the sandbox', async () => {
    const { ctx, layout } = await sandbox();
    fs.symlinkSync(os.tmpdir(), path.join(layout.workspace, 'escape'));
    await expect(ctx.readFile('escape/anything.txt')).rejects.toThrow(/Permission denied/);
  });

  it('one read of a file is one file, however the path was spelled', async () => {
    const { ctx, layout } = await sandbox();
    fs.writeFileSync(path.join(layout.workspace, 'sample.ts'), 'x');
    ctx.markFileRead(`~/${SANDBOX_WORKSPACE_REL}/sample.ts`);
    expect(ctx.hasFileBeenRead(path.join(layout.workspace, 'sample.ts'))).toBe(true);
    expect(ctx.hasFileBeenRead(path.join(layout.workspace, 'other.ts'))).toBe(false);
  });
});

describe('eval sandbox: environment for spawned commands', () => {
  it('drops host credentials and pins git to the sandbox', () => {
    const layout = { root: '/r', home: '/r/home', workspace: '/r/home/projects/app' };
    const env = sandboxEnv(layout, { PATH: '/bin', GITHUB_TOKEN: 'ghp_x', BANDIT_API_KEY: 'k', MY_SECRET: 's', EDITOR: 'vi' });
    expect(env.HOME).toBe('/r/home');
    expect(env.GIT_CEILING_DIRECTORIES).toBe('/r');
    expect('GITHUB_TOKEN' in env && env.GITHUB_TOKEN === undefined).toBe(true);
    expect(env.BANDIT_API_KEY).toBeUndefined();
    expect(env.MY_SECRET).toBeUndefined();
    // Only overrides are returned; PATH and friends come from process.env untouched.
    expect('PATH' in env).toBe(false);
    expect('EDITOR' in env).toBe(false);
  });

  it('a command cannot see a credential that is in the host environment', async () => {
    process.env.BANDIT_EVAL_TEST_TOKEN = 'do-not-leak';
    try {
      const { ctx } = await sandbox();
      const out = await ctx.runCommand('node', ['-e', 'process.stdout.write(String(process.env.BANDIT_EVAL_TEST_TOKEN))']);
      expect(out.stdout).toBe('undefined');
    } finally {
      delete process.env.BANDIT_EVAL_TEST_TOKEN;
    }
  });
});

// ---- runner ----

const scripted = (turns: string[]): RunnerProvider['chat'] => {
  let turn = 0;
  return async function* () { yield turns[Math.min(turn++, turns.length - 1)]; };
};
const call = (name: string, params: Record<string, string>): string => `<tool_call>${JSON.stringify({ name, params })}</tool_call>`;
const provider = (chat: RunnerProvider['chat']): RunnerProvider =>
  ({ kind: 'ollama', model: 'fake', settings: {} as RunnerProvider['settings'], chat, runTimeoutMs: 20_000 });
const base = { description: 'x', runs: 1, passThreshold: 1, maxIterations: 5 } as const;

describe('eval runner: fixtures can provision a home directory and other repositories', () => {
  it('lists a provisioned ~/Downloads without a denial', async () => {
    const fixture: Fixture = {
      ...base, id: 'sbx.home', prompt: 'What is in my ~/Downloads folder?',
      setup: { homeFiles: { 'Downloads/quarterly-report.pdf': 'x' } },
      assertions: { mustCallAnyOf: [{ name: 'ls', params: { path: /Downloads/ } }], finalResponseMatches: /quarterly-report/ }
    };
    const r = await runFixture(fixture, provider(scripted([call('ls', { path: '~/Downloads' }), 'It contains quarterly-report.pdf.'])));
    expect(r.runs[0].failureReasons).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.runs[0].sandboxDenials).toEqual([]);
    expect(r.runs[0].toolCalls[0].outputSnippet).toMatch(/quarterly-report\.pdf/);
  });

  it('reads the latest commit of a provisioned sibling repository', async () => {
    const fixture: Fixture = {
      ...base, id: 'sbx.repo', prompt: 'Latest commit of ~/projects/other?',
      setup: { gitRepos: { 'projects/other': { commits: [
        { message: 'Initial import', files: { 'README.md': '# other\n' } },
        { message: 'Fix pagination off-by-one', files: { 'a.js': '1\n' } }
      ] } } },
      assertions: { mustCallAnyOf: [{ name: 'git_log', params: { repo_path: /other/ } }] }
    };
    const r = await runFixture(fixture, provider(scripted([call('git_log', { repo_path: '~/projects/other', count: '1' }), 'done'])));
    expect(r.runs[0].failureReasons).toEqual([]);
    expect(r.runs[0].toolCalls[0].isError).toBe(false);
    expect(r.runs[0].toolCalls[0].outputSnippet).toMatch(/Fix pagination off-by-one/);
  });
});

describe('eval runner: a refused access is a tool error, not an automatic failure', () => {
  const fixture: Fixture = {
    ...base, id: 'sbx.recover', prompt: 'What port?',
    setup: { files: { 'config.json': '{"port":4187}' } },
    assertions: { mustCallAnyOf: [{ name: 'read_file' }], finalResponseMatches: /4187/ }
  };

  it('passes a run that reaches for an invented path, is refused, and then does the task', async () => {
    const r = await runFixture(fixture, provider(scripted([
      call('read_file', { path: '/workspace/config.json' }),
      call('read_file', { path: 'config.json' }),
      'The port is 4187.'
    ])));
    expect(r.passed).toBe(true);
    expect(r.runs[0].sandboxDenials).toEqual(['read /workspace/config.json']);
    expect(r.runs[0].toolCalls.map(c => c.isError)).toEqual([true, false]);
  });

  it('still fails the run that never recovers — on its assertions', async () => {
    const r = await runFixture(fixture, provider(scripted([call('read_file', { path: '/workspace/config.json' }), 'I cannot read it.'])));
    expect(r.passed).toBe(false);
    expect(r.runs[0].failureReasons.join('\n')).toMatch(/read_file \(failed\)/);
    expect(r.runs[0].failureReasons.join('\n')).not.toMatch(/permission auto-denied/);
    expect(r.runs[0].endedEarly).toBe(true);
  });
});

describe('eval runner: per-call outcomes and run measures', () => {
  it('gives two same-named calls in one batch their own results', async () => {
    const fixture: Fixture = {
      ...base, id: 'sbx.batch', prompt: 'read both',
      setup: { files: { 'a.txt': 'A' } },
      assertions: {}
    };
    // A profile that allows parallel tool calls (the default profile runs one per response).
    const parallel: RunnerProvider = { ...provider(scripted([
      call('read_file', { path: 'a.txt' }) + call('read_file', { path: 'missing.txt' }),
      'done'
    ])), model: 'qwen3.6:27b' };
    const r = await runFixture(fixture, parallel);
    expect(r.runs[0].toolCalls.map(c => [c.params.path, c.isError])).toEqual([['a.txt', false], ['missing.txt', true]]);
  });

  it('counts calls rejected for their shape, and unknown tools', async () => {
    const fixture: Fixture = { ...base, id: 'sbx.shape', prompt: 'edit', setup: { files: { 'a.txt': 'A' } }, assertions: {} };
    const r = await runFixture(fixture, provider(scripted([
      call('read_file', { path: 'a.txt' }),
      call('apply_edit', { path: 'a.txt', start_line: '1', content: 'B' }),
      call('run_tests', { runner: 'vitest' }),
      'done'
    ])));
    expect(r.runs[0].malformedToolCalls).toBe(2);
    expect(r.runs[0].endedEarly).toBe(false);
  });

  it('a run stopped by the wall-clock cap keeps its tool calls and leaves a trace', async () => {
    const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-eval-traces-'));
    roots.push(traceDir);
    let turn = 0;
    const stalls: RunnerProvider = {
      kind: 'ollama', model: 'fake', settings: {} as RunnerProvider['settings'], runTimeoutMs: 400, traceOut: traceDir,
      chat: async function* () {
        if (turn++ === 0) { yield call('read_file', { path: 'a.txt' }); return; }
        await new Promise(() => undefined); // never answers the second call
        yield '';
      }
    };
    const fixture: Fixture = { ...base, id: 'sbx.stall', prompt: 'read it', setup: { files: { 'a.txt': 'A' } }, assertions: { finalResponseMatches: /A/ } };
    const r = await runFixture(fixture, stalls);
    expect(r.runs[0].timedOut).toBe(true);
    expect(r.runs[0].toolCalls.map(c => [c.name, c.isError])).toEqual([['read_file', false]]);
    expect(r.runs[0].endedEarly ?? false).toBe(false);
    const files = fs.readdirSync(traceDir);
    expect(files).toHaveLength(1);
    const trace = JSON.parse(fs.readFileSync(path.join(traceDir, files[0]), 'utf8'));
    expect(trace.labels.passed).toBe(false);
    expect(trace.labels.failureReasons.join(' ')).toMatch(/wall-clock cap/);
    expect(JSON.stringify(trace.messages)).toContain('read_file');
  });

  it('writes the home and the workspace into the trace under stable names', () => {
    const home = '/private/var/folders/zz/T/bandit-eval-x-Ab12/home';
    const trace = buildRunTrace({
      fixtureId: 'x', runNumber: 1, model: 'm', systemPrompt: 's', tools: [], hitLimit: false, passed: true, failureReasons: [],
      workspaceRoot: `${home}/projects/app`, homeRoot: home, permissionDenials: 2,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: `Listed ${home}/Downloads and ${home}/projects/app/src/a.ts and ${home.replace('/private', '')}/projects/other` }
      ]
    });
    const text = JSON.stringify(trace.messages);
    expect(text).toContain('Listed ~/Downloads');
    expect(text).toContain(`${TRACE_WORKSPACE}/src/a.ts`);
    expect(text).toContain('~/projects/other');
    expect(text).not.toContain('bandit-eval-x');
    expect(trace.labels.permissionDenials).toBe(2);
  });
});

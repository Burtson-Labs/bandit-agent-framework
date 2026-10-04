import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { neutralSystemPrompt, rebuiltSystemPrompt, workspaceRootOfTurnFile } from '../src/training/build';
import { inferWorkspaceRoot, relativizeExample } from '../src/training/paths';
import { selfCheckExample } from '../src/training/scrub';
import { emptyLabels, emptyRedactions, type CanonicalMessage, type TrainingExample } from '../src/training/types';
import { EvalSandboxContext, SandboxDeniedError } from '../src/__eval__/sandboxContext';
import { createDefaultLanguageAdapters } from '@burtson-labs/agent-core';
import { runFixture, type RunnerProvider } from '../src/__eval__/runner';
import type { Fixture } from '../src/__eval__/types';

// Synthetic fixtures only: a fake home and fake repos.
const HOME = '/Users/dev';
const REPO = `${HOME}/Documents/GitHub/widget`;

function example(messages: CanonicalMessage[], sourceRef = 'cli:s1'): TrainingExample {
  return {
    id: 'x', source: 'bandit-cli', sourceRef, createdAt: '2026-10-04T00:00:00Z', model: null, status: 'completed',
    labels: emptyLabels(), tools: [], messages, scrub: { version: 'scrub-v1', redactions: emptyRedactions() }, split: null
  } as TrainingExample;
}
function edit(p: string): CanonicalMessage {
  return { role: 'assistant', content: 'Editing.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_edit', arguments: JSON.stringify({ path: p, find: 'a', replace: 'b' }) } }] };
}
const text = (e: TrainingExample): string => JSON.stringify(e.messages) + e.sourceRef;

describe('training paths: workspace-relative', () => {
  it('rewrites paths under the workspace root to repo-relative in args, tool results and prose', () => {
    const r = relativizeExample(example([
      { role: 'system', content: 'You are Bandit.' },
      { role: 'user', content: `fix ${REPO}/src/a.ts please` },
      edit(`~/Documents/GitHub/widget/src/a.ts`),
      { role: 'tool', tool_call_id: 'c1', name: 'apply_edit', content: `Edited ${REPO}/src/a.ts` },
      { role: 'assistant', content: `Done — see ${REPO}/src/a.ts. Ran from ${REPO}.` }
    ]), { workspaceRoot: REPO, home: HOME });
    expect(r.dropReason).toBeNull();
    expect(r.relative).toBe(5);
    const call = r.example.messages[2];
    expect(call.role === 'assistant' && JSON.parse(call.tool_calls![0].function.arguments).path).toBe('src/a.ts');
    expect(r.example.messages[1].content).toBe('fix src/a.ts please');
    expect(r.example.messages[4].content).toBe('Done — see src/a.ts. Ran from ..');
    expect(text(r.example)).not.toMatch(/Documents|\/Users\//);
    expect(selfCheckExample(r.example)).toEqual([]);
  });

  it('infers the root from tool-call paths when no hint is given', () => {
    const e = example([{ role: 'user', content: 'go' }, edit(`${REPO}/lib/x.ts`), edit(`${REPO}/lib/y.ts`)]);
    expect(inferWorkspaceRoot(e, HOME)).toBe('~/Documents/GitHub/widget');
    expect(relativizeExample(e, { home: HOME }).relative).toBe(2);
  });

  it('rewrites another repo to ../<repo>/…', () => {
    const r = relativizeExample(example([{ role: 'user', content: 'x' }, edit(`${HOME}/Documents/GitHub/other-lib/src/b.ts`)]), { workspaceRoot: REPO, home: HOME });
    expect(r.crossRepo).toBe(1);
    expect(text(r.example)).toContain('../other-lib/src/b.ts');
  });

  it('drops client (GitHub-<org>) workspaces entirely', () => {
    const inside = relativizeExample(example([{ role: 'user', content: 'x' }, edit('src/a.ts')]), { workspaceRoot: `${HOME}/Documents/GitHub-acme/portal`, home: HOME });
    expect(inside.dropReason).toBe('client-workspace');
    const touching = relativizeExample(example([{ role: 'user', content: 'x' }, edit(`~/Documents/GitHub-acme/portal/a.ts`)]), { workspaceRoot: REPO, home: HOME });
    expect(touching.dropReason).toBe('client-workspace');
    expect(text(touching.example)).not.toContain('acme');
  });

  it('collapses eval sandboxes (macOS temp and ~/projects/app) to the workspace root', () => {
    const sb = '/var/folders/zz/abc123/T/bandit-eval-syn.rename-Qq12Zz';
    const r = relativizeExample(example([{ role: 'user', content: `in /private${sb}` }, edit(`${sb}/src/a.ts`)]), { workspaceRoot: sb, home: HOME });
    expect(text(r.example)).toContain('"path\\":\\"src/a.ts');
    expect(text(r.example)).not.toMatch(/var\/folders|bandit-eval/);
    const app = relativizeExample(example([{ role: 'user', content: 'x' }, edit('~/projects/app/sample.ts')]), { home: HOME });
    expect(text(app.example)).not.toContain('projects/app');
    expect(selfCheckExample(app.example)).toEqual([]);
  });

  it('replaces personal and temp paths with neutral placeholders and counts them', () => {
    const r = relativizeExample(example([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: `Saved ~/Documents/notes/plan.md, ${HOME}/.ssh/config and /var/folders/q/w/T/tmp.123/out.log; see ~/Desktop/a.png` }
    ]), { workspaceRoot: REPO, home: HOME });
    const out = r.example.messages[1].content;
    expect(out).toContain('~/files/notes/plan.md');
    expect(out).toContain('~/config');
    expect(out).toContain('/tmp/out.log');
    expect(out).toContain('~/Desktop/a.png');
    expect(r.external).toBe(3);
    expect(selfCheckExample(r.example)).toEqual([]);
    const dropped = relativizeExample(example([{ role: 'user', content: `see ${HOME}/Documents/notes/a.md` }]), { workspaceRoot: REPO, home: HOME, externalPaths: 'drop' });
    expect(dropped.dropReason).toBe('external-path');
  });

  it('leaves non-path tildes alone', () => {
    const r = relativizeExample(example([{ role: 'user', content: 'takes ~ 5 minutes, ~5s' }]), { workspaceRoot: REPO, home: HOME });
    expect(r.example.messages[0].content).toBe('takes ~ 5 minutes, ~5s');
  });

  it('maps a turn file back to its workspace root', () => {
    expect(workspaceRootOfTurnFile(`${REPO}/.bandit/turns/t1.jsonl`)).toBe(REPO);
    expect(workspaceRootOfTurnFile(path.join(os.homedir(), '.bandit/turns/t1.jsonl'))).toBeNull();
  });
});

describe('training paths: system prompt + self-check', () => {
  it('makes the workspace line neutral', () => {
    expect(neutralSystemPrompt('Repos live in ~/Documents/GitHub/bandit and ~/documents/github/x')).toBe('Repos live in ../bandit and ../x');
    expect(rebuiltSystemPrompt()).not.toMatch(/~\/Documents|\/Users\/|~\/projects\/app/);
  });

  it('fails the self-check on any leftover machine path', () => {
    for (const leftover of ['~/Documents/GitHub/x/a.ts', '/Users/dev/a.ts', '~/projects/app/a.ts', '/var/folders/zz/T/x', 'bandit-eval-syn.x-Qq12Zz']) {
      const hits = selfCheckExample(example([{ role: 'user', content: `path ${leftover}` }]));
      expect(hits.length, leftover).toBeGreaterThan(0);
    }
    // the system message is checked too
    expect(selfCheckExample(example([{ role: 'system', content: 'Workspace: ~/Documents/GitHub/x' }, { role: 'user', content: 'hi' }])).length).toBeGreaterThan(0);
  });
});

describe('eval sandbox context: out-of-workspace access is auto-denied', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const sandbox = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-eval-test-')); dirs.push(d); return d; };

  it('allows relative paths inside the sandbox', async () => {
    const sb = sandbox();
    const ctx = new EvalSandboxContext(sb, createDefaultLanguageAdapters());
    await ctx.writeFile(path.join(sb, 'sample.ts'), 'x');
    expect(await ctx.readFile(path.join(sb, 'sample.ts'))).toBe('x');
    expect(ctx.denials).toEqual([]);
  });

  it('denies a memorized absolute path immediately with an explanatory error, recording it', async () => {
    const sb = sandbox();
    const ctx = new EvalSandboxContext(sb, createDefaultLanguageAdapters());
    const target = '~/Documents/GitHub/bandit-agent-framework/sample.ts';
    const started = Date.now();
    await expect(ctx.writeFile(target, 'x')).rejects.toThrow(SandboxDeniedError);
    await expect(ctx.writeFile(target, 'x')).rejects.toThrow(/outside the workspace.*non-interactive.*relative to the workspace root/s);
    await expect(ctx.readFile('/etc/hosts')).rejects.toThrow(/Permission denied/);
    await expect(ctx.runCommand('cat', ['~/.ssh/config'])).rejects.toThrow(/Permission denied/);
    await expect(ctx.listFiles('*', '/')).rejects.toThrow(/Permission denied/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ctx.denials).toHaveLength(5);
    expect(ctx.denials[0]).toContain('write ~/Documents/GitHub/bandit-agent-framework/sample.ts');
  });
});

describe('eval runner: never hangs', () => {
  const fixture = (prompt: string): Fixture => ({ id: 'hang.test', description: 'x', prompt, runs: 1, passThreshold: 1, maxIterations: 3, assertions: {} });
  const provider = (chat: RunnerProvider['chat'], runTimeoutMs?: number): RunnerProvider =>
    ({ kind: 'ollama', model: 'fake', settings: {} as RunnerProvider['settings'], chat, runTimeoutMs });

  it('fails a run that exceeds the wall-clock cap instead of waiting forever', async () => {
    const started = Date.now();
    const r = await runFixture(fixture('do it'), provider(async function* () {
      await new Promise(() => undefined); // a model that never answers
      yield '';
    }, 200));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.passed).toBe(false);
    expect(r.runs[0].failureReasons.join('\n')).toMatch(/wall-clock cap/);
  });

  it('auto-denies an out-of-workspace edit and reports it as a failure reason', async () => {
    let turn = 0;
    const r = await runFixture(fixture('edit sample.ts'), provider(async function* () {
      turn++;
      yield turn === 1
        ? '<tool_call>{"name":"write_file","params":{"path":"~/Documents/GitHub/bandit-agent-framework/sample.ts","content":"x"}}</tool_call>'
        : 'Done.';
    }, 10_000));
    expect(r.passed).toBe(false);
    expect(r.runs[0].failureReasons.join('\n')).toMatch(/permission auto-denied \(non-interactive\): write ~\/Documents\/GitHub\/bandit-agent-framework\/sample\.ts/);
    expect(fs.existsSync(path.join(os.homedir(), 'Documents/GitHub/bandit-agent-framework/sample.ts'))).toBe(false);
  });
});

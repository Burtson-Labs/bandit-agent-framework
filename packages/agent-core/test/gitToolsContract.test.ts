/**
 * Contract tests for the expanded git toolset : branch /
 * checkout / stash / pull / push. The original four (status/diff/log/
 * commit) shipped without dedicated tests because they were thin
 * runCommand wrappers — the new five carry meaningful logic (subcommand
 * routing, force-push protection, ff-only-by-default, create-vs-list
 * branching) so we pin the contracts before that surface drifts.
 *
 * Strategy: stub `runCommand` to capture the exact `git` args the tool
 * would shell out, plus a configurable exit/stdout/stderr to drive the
 * branch the tool takes (success vs. error message). Doesn't shell out
 * to real git — too slow and creates an unwanted dependency.
 */
import { describe, expect, it } from 'vitest';
import {
  gitBranchTool,
  gitCheckoutTool,
  gitStashTool,
  gitPullTool,
  gitPushTool
} from '../src/tools/git-tools';
import type { ToolExecutionContext } from '../src/tools/tool-types';

interface RunCall { cmd: string; args: string[]; cwd?: string }

function buildCtx(opts: {
  responses?: Array<{ stdout?: string; stderr?: string; exitCode?: number }>;
  workspaceRoot?: string;
} = {}): { ctx: ToolExecutionContext; calls: RunCall[] } {
  const calls: RunCall[] = [];
  let i = 0;
  const ctx: ToolExecutionContext = {
    workspaceRoot: opts.workspaceRoot ?? '/repo',
    async readFile() { return ''; },
    async writeFile() { return; },
    async listFiles() { return []; },
    async searchCode() { return ''; },
    async runCommand(cmd, args, cwd) {
      calls.push({ cmd, args, cwd });
      const r = opts.responses?.[i++] ?? {};
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
    }
  };
  return { ctx, calls };
}

describe('git_branch', () => {
  it('lists local branches when no params are given', async () => {
    const { ctx, calls } = buildCtx({ responses: [{ stdout: '* main\n  feature/foo\n' }] });
    const r = await gitBranchTool.execute({}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain('main');
    expect(calls[0].args).toEqual(['branch', '--list', '--no-color']);
  });

  it('lists remote branches too when remote="true"', async () => {
    const { ctx, calls } = buildCtx({ responses: [{ stdout: '' }] });
    await gitBranchTool.execute({ remote: 'true' }, ctx);
    expect(calls[0].args).toContain('--all');
  });

  it('creates AND checks out a new branch by default with `create`', async () => {
    const { ctx, calls } = buildCtx({ responses: [{ stdout: 'Switched to a new branch foo' }] });
    const r = await gitBranchTool.execute({ create: 'feature/x' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(calls[0].args).toEqual(['switch', '-c', 'feature/x']);
  });

  it('creates from a specific ref when `from` is provided', async () => {
    const { ctx, calls } = buildCtx({ responses: [{}] });
    await gitBranchTool.execute({ create: 'hotfix', from: 'origin/main' }, ctx);
    expect(calls[0].args).toEqual(['switch', '-c', 'hotfix', 'origin/main']);
  });

  it('creates without switching when checkout="false"', async () => {
    const { ctx, calls } = buildCtx({ responses: [{}] });
    await gitBranchTool.execute({ create: 'wip', checkout: 'false' }, ctx);
    // Uses `git branch <name>` (not `git switch -c`) so the user stays
    // on the current branch.
    expect(calls[0].args).toEqual(['branch', 'wip']);
  });

  it('surfaces git stderr as an error result on non-zero exit', async () => {
    const { ctx } = buildCtx({ responses: [{ stderr: 'fatal: A branch named foo already exists', exitCode: 128 }] });
    const r = await gitBranchTool.execute({ create: 'foo' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/already exists/);
  });
});

describe('git_checkout', () => {
  it('uses `git switch <branch>` (the safer modern form, NOT `git checkout`)', async () => {
    const { ctx, calls } = buildCtx({ responses: [{ stdout: 'Switched to branch main' }] });
    await gitCheckoutTool.execute({ branch: 'main' }, ctx);
    expect(calls[0].args).toEqual(['switch', 'main']);
  });

  it('requires a branch parameter', async () => {
    const { ctx, calls } = buildCtx({});
    const r = await gitCheckoutTool.execute({}, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/branch parameter is required/);
    expect(calls).toEqual([]); // no git command ran
  });

  it('surfaces git\'s "uncommitted changes would be overwritten" error', async () => {
    const { ctx } = buildCtx({
      responses: [{
        stderr: 'error: Your local changes to the following files would be overwritten by checkout',
        exitCode: 1
      }]
    });
    const r = await gitCheckoutTool.execute({ branch: 'other' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/would be overwritten/);
  });
});

describe('git_stash', () => {
  it('defaults to `push` when no action is given', async () => {
    const { ctx, calls } = buildCtx({ responses: [{ stdout: 'Saved working directory' }] });
    await gitStashTool.execute({}, ctx);
    expect(calls[0].args).toEqual(['stash', 'push']);
  });

  it('includes -m when message is provided', async () => {
    const { ctx, calls } = buildCtx({ responses: [{}] });
    await gitStashTool.execute({ message: 'WIP auth flow' }, ctx);
    expect(calls[0].args).toEqual(['stash', 'push', '-m', 'WIP auth flow']);
  });

  it('list action runs `git stash list`', async () => {
    const { ctx, calls } = buildCtx({ responses: [{ stdout: 'stash@{0}: WIP\n' }] });
    const r = await gitStashTool.execute({ action: 'list' }, ctx);
    expect(calls[0].args).toEqual(['stash', 'list', '--no-color']);
    expect(r.output).toContain('stash@{0}');
  });

  it('pop without ref pops the most recent stash', async () => {
    const { ctx, calls } = buildCtx({ responses: [{ stdout: 'restored' }] });
    await gitStashTool.execute({ action: 'pop' }, ctx);
    expect(calls[0].args).toEqual(['stash', 'pop']);
  });

  it('pop with ref targets the specified stash', async () => {
    const { ctx, calls } = buildCtx({ responses: [{ stdout: 'restored' }] });
    await gitStashTool.execute({ action: 'pop', ref: 'stash@{2}' }, ctx);
    expect(calls[0].args).toEqual(['stash', 'pop', 'stash@{2}']);
  });

  it('rejects unknown actions', async () => {
    const { ctx } = buildCtx({});
    const r = await gitStashTool.execute({ action: 'drop' }, ctx);
    // drop is intentionally unsupported — drop is destructive (no undo)
    // and stays out of the safe-tool surface; user uses run_command if
    // they really need it.
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/unknown action/i);
  });
});

describe('git_pull', () => {
  it('defaults to --ff-only --no-rebase (refuses merge surprises)', async () => {
    const { ctx, calls } = buildCtx({ responses: [{ stdout: 'Already up to date.' }] });
    await gitPullTool.execute({}, ctx);
    expect(calls[0].args).toEqual(['pull', '--ff-only', '--no-rebase']);
  });

  it('appends remote + branch when provided', async () => {
    const { ctx, calls } = buildCtx({ responses: [{}] });
    await gitPullTool.execute({ remote: 'origin', branch: 'main' }, ctx);
    expect(calls[0].args).toEqual(['pull', '--ff-only', '--no-rebase', 'origin', 'main']);
  });

  it('surfaces fast-forward refusal cleanly', async () => {
    const { ctx } = buildCtx({
      responses: [{
        stderr: 'fatal: Not possible to fast-forward, aborting.',
        exitCode: 128
      }]
    });
    const r = await gitPullTool.execute({}, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/fast-forward/);
  });
});

describe('git_push', () => {
  it('never includes --force (safety invariant)', async () => {
    const { ctx, calls } = buildCtx({ responses: [{}] });
    // Even if the params somehow grow a force field, the implementation
    // must not pass it through. Pin the negative.
    await gitPushTool.execute({}, ctx);
    expect(calls[0].args).not.toContain('--force');
    expect(calls[0].args).not.toContain('-f');
    expect(calls[0].args).not.toContain('--force-with-lease');
  });

  it('passes --set-upstream when set_upstream="true"', async () => {
    const { ctx, calls } = buildCtx({ responses: [{}] });
    await gitPushTool.execute({ set_upstream: 'true', remote: 'origin', branch: 'feature/x' }, ctx);
    expect(calls[0].args).toEqual(['push', '--set-upstream', 'origin', 'feature/x']);
  });

  it('passes --follow-tags when tags="true"', async () => {
    const { ctx, calls } = buildCtx({ responses: [{}] });
    await gitPushTool.execute({ tags: 'true' }, ctx);
    expect(calls[0].args).toEqual(['push', '--follow-tags']);
  });

  it('merges stdout and stderr in the success output (git writes summary to stderr)', async () => {
    const { ctx } = buildCtx({
      responses: [{
        stdout: '',
        stderr: 'To github.com:foo/bar.git\n   abc..def  main -> main',
        exitCode: 0
      }]
    });
    const r = await gitPushTool.execute({}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain('main -> main');
  });

  it('surfaces auth failures as an error result', async () => {
    const { ctx } = buildCtx({
      responses: [{
        stderr: 'remote: Permission to foo/bar.git denied to user',
        exitCode: 128
      }]
    });
    const r = await gitPushTool.execute({}, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/denied/);
  });
});

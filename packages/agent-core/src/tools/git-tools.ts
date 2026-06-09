/**
 * Git tools for the Bandit agent tool registry.
 *
 * All tools use ctx.runCommand('git', [...]) — no direct shell dependency.
 * git must be in PATH on the host machine.
 *
 * Every tool accepts an optional `repo_path` parameter. When present, git
 * runs with that directory as its cwd instead of the workspace root —
 * essential when the user starts `bandit` from one directory but asks the
 * agent to operate on a repo elsewhere on disk (e.g. launching from `~` and
 * inspecting `~/Documents/github/some-repo`). Without this, git_* tools
 * fail with "not a git repository" even though the path the conversation
 * is working against is a valid repo.
 */

import type { AgentTool, ToolExecutionContext, ToolResult } from './tool-types';
import { ToolRegistry } from './tool-registry';

/**
 * Resolve the cwd to hand to `git`. Absolute/tilde paths are used as-is;
 * relative paths are anchored to the workspace root. Falls back to the
 * workspace root when no override is provided. Absolute-path detection
 * covers POSIX (`/foo`), tilde (`~/foo`), and Windows drive-letter
 * (`C:\foo`, `C:/foo`) + UNC (`\\server\share`) shapes — without the
 * Windows checks, an absolute path like `C:\Users\…\repo` would not
 * match `startsWith('/')`, fall through, and get concatenated onto
 * the workspace root as if it were relative.
 */
function resolveRepoPath(ctx: ToolExecutionContext, repoPath?: string): string {
  const raw = repoPath?.trim();
  if (!raw) {return ctx.workspaceRoot;}
  if (raw.startsWith('/') || raw.startsWith('~')) {return raw;}
  if (/^[A-Za-z]:[\\/]/.test(raw)) {return raw;}
  if (raw.startsWith('\\\\')) {return raw;}
  return `${ctx.workspaceRoot}/${raw}`;
}

const REPO_PATH_PARAM = {
  name: 'repo_path',
  description: 'Absolute or workspace-relative path to the git repository. Defaults to the workspace root. Use this when the user points at a repo outside the current workspace (e.g. "~/Documents/github/my-project").'
};

// ── git_status ──────────────────────────────────────────────────────────────

const gitStatusTool: AgentTool = {
  name: 'git_status',
  description: 'Show the working tree status (modified, staged, untracked files). Equivalent to "git status --short".',
  parameters: [REPO_PATH_PARAM],
  async execute(params, ctx): Promise<ToolResult> {
    const cwd = resolveRepoPath(ctx, params.repo_path);
    const result = await ctx.runCommand('git', ['status', '--short', '--porcelain=v1'], cwd);
    if (result.exitCode !== 0) {
      return { output: result.stderr || 'git status failed.', isError: true };
    }
    const output = result.stdout.trim();
    return { output: output || '(clean working tree — no changes)' };
  }
};

// ── git_diff ─────────────────────────────────────────────────────────────────

const gitDiffTool: AgentTool = {
  name: 'git_diff',
  description: 'Show the diff of unstaged changes (or staged with "staged: true"). Optionally limit to a specific file path.',
  parameters: [
    { name: 'staged', description: 'If "true", show staged (indexed) changes instead of unstaged.' },
    { name: 'path', description: 'Optional file or directory path relative to the repo root to scope the diff.' },
    REPO_PATH_PARAM
  ],
  async execute(params, ctx): Promise<ToolResult> {
    const args = ['diff', '--stat', '--patch', '-U3'];
    if (params.staged === 'true') {
      args.push('--staged');
    }
    if (params.path?.trim()) {
      args.push('--', params.path.trim());
    }
    const cwd = resolveRepoPath(ctx, params.repo_path);
    const result = await ctx.runCommand('git', args, cwd);
    if (result.exitCode !== 0) {
      return { output: result.stderr || 'git diff failed.', isError: true };
    }
    const output = result.stdout.trim();
    return { output: output || '(no diff — working tree is clean)' };
  }
};

// ── git_log ──────────────────────────────────────────────────────────────────

const gitLogTool: AgentTool = {
  name: 'git_log',
  description: 'Show recent commit history. Returns the last N commits (default 10) with hash, author, date, and message.',
  parameters: [
    { name: 'count', description: 'Number of commits to show (default: 10, max: 50).' },
    { name: 'path', description: 'Optional file path to filter commits that touched this file.' },
    REPO_PATH_PARAM
  ],
  async execute(params, ctx): Promise<ToolResult> {
    const count = Math.min(parseInt(params.count ?? '10', 10) || 10, 50);
    const args = ['log', `--max-count=${count}`, '--oneline', '--decorate', '--no-color'];
    if (params.path?.trim()) {
      args.push('--', params.path.trim());
    }
    const cwd = resolveRepoPath(ctx, params.repo_path);
    const result = await ctx.runCommand('git', args, cwd);
    if (result.exitCode !== 0) {
      return { output: result.stderr || 'git log failed.', isError: true };
    }
    return { output: result.stdout.trim() || '(no commits found)' };
  }
};

// ── git_commit ───────────────────────────────────────────────────────────────

const gitCommitTool: AgentTool = {
  name: 'git_commit',
  description: 'Stage all modified/new files and create a git commit with the given message. Use only after verifying changes are correct.',
  parameters: [
    { name: 'message', description: 'Commit message (required). Should be concise and descriptive.', required: true },
    { name: 'add_all', description: 'If "true" (default), stage all changes before committing. Set to "false" to commit only already-staged files.' },
    REPO_PATH_PARAM
  ],
  async execute(params, ctx): Promise<ToolResult> {
    const message = params.message?.trim();
    if (!message) {
      return { output: 'Error: commit message is required.', isError: true };
    }

    const cwd = resolveRepoPath(ctx, params.repo_path);
    const addAll = params.add_all !== 'false';
    if (addAll) {
      const addResult = await ctx.runCommand('git', ['add', '--all'], cwd);
      if (addResult.exitCode !== 0) {
        return { output: `git add failed: ${addResult.stderr}`, isError: true };
      }
    }

    const commitResult = await ctx.runCommand('git', ['commit', '-m', message], cwd);
    if (commitResult.exitCode !== 0) {
      return { output: `git commit failed: ${commitResult.stderr || commitResult.stdout}`, isError: true };
    }

    return { output: commitResult.stdout.trim() || 'Commit created.' };
  }
};

// ── git_branch ───────────────────────────────────────────────────────────────

const gitBranchTool: AgentTool = {
  name: 'git_branch',
  description: 'List branches or create a new branch. With no parameters: lists local branches with the current one marked. With `create`: creates that branch (optionally from `from`) and optionally checks it out.',
  parameters: [
    { name: 'create', description: 'Optional name of a new branch to create. When set, the tool creates the branch instead of listing.' },
    { name: 'from', description: 'Optional starting ref for the new branch (commit SHA, branch name, tag). Defaults to current HEAD. Only used with `create`.' },
    { name: 'checkout', description: 'If "true" (default when creating), check out the new branch after creating it. Set to "false" to create-without-switch.' },
    { name: 'remote', description: 'If "true", list remote branches as well as local. No effect when creating.' },
    REPO_PATH_PARAM
  ],
  async execute(params, ctx): Promise<ToolResult> {
    const cwd = resolveRepoPath(ctx, params.repo_path);
    const create = params.create?.trim();
    if (create) {
      const checkoutAfter = params.checkout !== 'false';
      // `git switch -c` is the modern create+switch; `git branch <name> <from>`
      // is the create-only form. Pick by the checkout flag so a no-switch
      // creation doesn't accidentally yank the user off their current branch.
      const args = checkoutAfter
        ? ['switch', '-c', create, ...(params.from?.trim() ? [params.from.trim()] : [])]
        : ['branch', create, ...(params.from?.trim() ? [params.from.trim()] : [])];
      const result = await ctx.runCommand('git', args, cwd);
      if (result.exitCode !== 0) {
        return { output: result.stderr || `git ${args[0]} failed.`, isError: true };
      }
      return { output: result.stdout.trim() || `Branch "${create}" created${checkoutAfter ? ' and checked out' : ''}.` };
    }
    // List path. `--list` ensures we get the listing form even if a
    // future git release changes the default behavior.
    const listArgs = params.remote === 'true' ? ['branch', '--all', '--list', '--no-color'] : ['branch', '--list', '--no-color'];
    const result = await ctx.runCommand('git', listArgs, cwd);
    if (result.exitCode !== 0) {
      return { output: result.stderr || 'git branch failed.', isError: true };
    }
    return { output: result.stdout.trim() || '(no branches found)' };
  }
};

// ── git_checkout ─────────────────────────────────────────────────────────────

const gitCheckoutTool: AgentTool = {
  name: 'git_checkout',
  description: 'Switch to an existing branch. Refuses to run when the working tree has uncommitted changes that would conflict — same protection git itself provides. Use `git_branch` with `create=<name>` to make a new branch in one step.',
  parameters: [
    { name: 'branch', description: 'The branch name to switch to (required). Must already exist locally — use git_branch with create=... to make a new one.', required: true },
    REPO_PATH_PARAM
  ],
  async execute(params, ctx): Promise<ToolResult> {
    const branch = params.branch?.trim();
    if (!branch) {
      return { output: 'Error: branch parameter is required.', isError: true };
    }
    const cwd = resolveRepoPath(ctx, params.repo_path);
    // `git switch` is the modern equivalent of `git checkout <branch>`,
    // and unlike `checkout` it refuses to do path-checkout (which is the
    // dangerous destructive form). Keeps the tool surface safe.
    const result = await ctx.runCommand('git', ['switch', branch], cwd);
    if (result.exitCode !== 0) {
      return { output: result.stderr || `git switch ${branch} failed.`, isError: true };
    }
    return { output: result.stdout.trim() || `Switched to branch "${branch}".` };
  }
};

// ── git_stash ────────────────────────────────────────────────────────────────

const gitStashTool: AgentTool = {
  name: 'git_stash',
  description: 'Save, restore, or list stashed changes. Subcommand chosen by `action`: "push" (default) stashes current changes; "pop" restores the most recent stash (or the named one) and removes it; "list" shows stashed entries.',
  parameters: [
    { name: 'action', description: 'One of "push" (default), "pop", or "list".' },
    { name: 'message', description: 'Optional message describing the stash. Only used with "push".' },
    { name: 'ref', description: 'Optional stash reference (e.g. "stash@{1}"). Only used with "pop"; defaults to the most recent stash.' },
    REPO_PATH_PARAM
  ],
  async execute(params, ctx): Promise<ToolResult> {
    const cwd = resolveRepoPath(ctx, params.repo_path);
    const action = (params.action?.trim() || 'push').toLowerCase();
    if (action === 'list') {
      const result = await ctx.runCommand('git', ['stash', 'list', '--no-color'], cwd);
      if (result.exitCode !== 0) {
        return { output: result.stderr || 'git stash list failed.', isError: true };
      }
      return { output: result.stdout.trim() || '(no stashes)' };
    }
    if (action === 'pop') {
      const ref = params.ref?.trim();
      const args = ref ? ['stash', 'pop', ref] : ['stash', 'pop'];
      const result = await ctx.runCommand('git', args, cwd);
      if (result.exitCode !== 0) {
        return { output: result.stderr || 'git stash pop failed.', isError: true };
      }
      return { output: result.stdout.trim() || 'Stash popped.' };
    }
    if (action === 'push' || action === '') {
      const args = ['stash', 'push'];
      const msg = params.message?.trim();
      if (msg) {args.push('-m', msg);}
      const result = await ctx.runCommand('git', args, cwd);
      if (result.exitCode !== 0) {
        return { output: result.stderr || 'git stash push failed.', isError: true };
      }
      return { output: result.stdout.trim() || 'Changes stashed.' };
    }
    return { output: `Error: unknown action "${action}". Use push, pop, or list.`, isError: true };
  }
};

// ── git_pull ─────────────────────────────────────────────────────────────────

const gitPullTool: AgentTool = {
  name: 'git_pull',
  description: 'Pull the latest changes from the remote tracking branch (or the specified remote+branch). Uses --ff-only by default — refuses to merge if a fast-forward isn\'t possible, so the user is never surprised by an unwanted merge commit. For a real merge, the user runs git manually.',
  parameters: [
    { name: 'remote', description: 'Optional remote name (e.g. "origin"). Defaults to the branch\'s configured upstream.' },
    { name: 'branch', description: 'Optional branch name on the remote. Defaults to the current branch\'s upstream.' },
    REPO_PATH_PARAM
  ],
  async execute(params, ctx): Promise<ToolResult> {
    const cwd = resolveRepoPath(ctx, params.repo_path);
    const args = ['pull', '--ff-only', '--no-rebase'];
    const remote = params.remote?.trim();
    const branch = params.branch?.trim();
    if (remote) {args.push(remote);}
    if (branch) {args.push(branch);}
    const result = await ctx.runCommand('git', args, cwd);
    if (result.exitCode !== 0) {
      return { output: result.stderr || result.stdout || 'git pull failed.', isError: true };
    }
    return { output: result.stdout.trim() || 'Already up to date.' };
  }
};

// ── git_push ─────────────────────────────────────────────────────────────────

const gitPushTool: AgentTool = {
  name: 'git_push',
  description: 'Push the current branch to its remote tracking ref. Never force-pushes — for force-push the user must use `run_command` directly with explicit consent. Pass `set_upstream=true` on the first push of a new branch so future `git_pull` calls work without arguments.',
  parameters: [
    { name: 'remote', description: 'Optional remote name (e.g. "origin"). Defaults to the branch\'s configured upstream, or "origin" if --set-upstream is needed.' },
    { name: 'branch', description: 'Optional branch name. Defaults to the current branch.' },
    { name: 'set_upstream', description: 'If "true", set the upstream ref so future pulls/pushes don\'t need remote+branch args. Use on the first push of a new branch.' },
    { name: 'tags', description: 'If "true", also push tags reachable from the pushed branch.' },
    REPO_PATH_PARAM
  ],
  async execute(params, ctx): Promise<ToolResult> {
    const cwd = resolveRepoPath(ctx, params.repo_path);
    const args = ['push'];
    if (params.set_upstream === 'true') {args.push('--set-upstream');}
    if (params.tags === 'true') {args.push('--follow-tags');}
    const remote = params.remote?.trim();
    const branch = params.branch?.trim();
    if (remote) {args.push(remote);}
    if (branch) {args.push(branch);}
    const result = await ctx.runCommand('git', args, cwd);
    if (result.exitCode !== 0) {
      return { output: result.stderr || result.stdout || 'git push failed.', isError: true };
    }
    // git push writes its progress to stderr; the success line lives there.
    // Merge both so the caller sees the "branch -> branch" summary.
    const merged = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    return { output: merged || 'Push complete.' };
  }
};

// ── Registry factory ─────────────────────────────────────────────────────────

/**
 * Returns a ToolRegistry pre-loaded with git tools.
 * Typically merged with the core registry via registerAll().
 */
export function createGitToolRegistry(): ToolRegistry {
  return new ToolRegistry().registerAll([
    gitStatusTool,
    gitDiffTool,
    gitLogTool,
    gitCommitTool,
    gitBranchTool,
    gitCheckoutTool,
    gitStashTool,
    gitPullTool,
    gitPushTool
  ]);
}

export {
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  gitBranchTool,
  gitCheckoutTool,
  gitStashTool,
  gitPullTool,
  gitPushTool
};

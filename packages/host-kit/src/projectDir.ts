/**
 * The project's `.bandit/` folder holds two kinds of things: files a team may
 * want in git (settings.json, mcp-servers.json, skills, memory) and per-user
 * logs and state that should never be committed (turn logs with prompt text,
 * tool arguments and excerpts of file contents; edit checkpoints; backups).
 *
 * Before 2026-10-21 nothing kept the second kind out of git: `git status`
 * showed `?? .bandit/`, and a routine `git add -A && git push` published the
 * turn logs. Now, when Bandit creates `.bandit/` or one of its per-user
 * folders, it also writes `.bandit/.gitignore` for those folders, unless a
 * `.gitignore` is already there. An existing file is never changed.
 */
import * as fs from 'fs';
import * as path from 'path';

export const PROJECT_GITIGNORE = [
  '# Written by Bandit when it created this folder. Bandit never overwrites',
  '# this file; edit or delete it as you like.',
  '# Per-user logs and local state. They can contain prompts, tool arguments',
  '# and excerpts of file contents, so they are kept out of git.',
  'turns/',
  'checkpoints/',
  'sessions/',
  'backups/',
  'artifacts/',
  'tmp/',
  'cache/',
  '*.local.json',
  ''
].join('\n');

/**
 * Write `<workspace>/.bandit/.gitignore` unless one exists. Never throws:
 * a read-only workspace must not break the agent.
 */
export async function ensureProjectGitignore(workspaceRoot: string): Promise<boolean> {
  const file = path.join(path.resolve(workspaceRoot), '.bandit', '.gitignore');
  try {
    await fs.promises.writeFile(file, PROJECT_GITIGNORE, { encoding: 'utf-8', flag: 'wx' });
    return true;
  } catch {
    // EEXIST (keep the user's file) or an unwritable folder.
    return false;
  }
}

/**
 * `mkdir -p` for a folder inside `<workspace>/.bandit/`. When this call
 * creates `.bandit/` itself or one of its top-level folders (turns/,
 * checkpoints/, ...), it also writes `.bandit/.gitignore` (see above).
 * Creating a deeper folder under an existing one does not, so a user who
 * deleted the file is not overruled on every turn.
 */
export async function mkdirInProjectBandit(workspaceRoot: string, dir: string): Promise<void> {
  const banditDir = path.join(path.resolve(workspaceRoot), '.bandit');
  const first = await fs.promises.mkdir(dir, { recursive: true });
  if (!first) return;
  const created = path.resolve(first);
  if (created === banditDir || path.dirname(created) === banditDir) {
    await ensureProjectGitignore(workspaceRoot);
  }
}

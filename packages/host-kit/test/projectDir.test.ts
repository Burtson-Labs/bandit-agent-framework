/**
 * .bandit/.gitignore: written when Bandit creates .bandit/ (or a top-level
 * per-user folder in it), never over an existing file, and never again
 * just because a deeper folder was created.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { PROJECT_GITIGNORE, mkdirInProjectBandit, mkdirInProjectBanditSync } from '../src/projectDir';
import { openTurnLog } from '../src/turnLog';
import { CheckpointStore } from '../src/checkpoints';

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-proj-'));
const gi = (root: string) => path.join(root, '.bandit', '.gitignore');

describe('.bandit/.gitignore', () => {
  it('is written when the turn log creates .bandit/', async () => {
    const root = ws();
    await openTurnLog(root);
    expect(fs.readFileSync(gi(root), 'utf-8')).toBe(PROJECT_GITIGNORE);
    expect(PROJECT_GITIGNORE).toMatch(/^turns\/$/m);
    expect(PROJECT_GITIGNORE).toMatch(/^checkpoints\/$/m);
  });

  it('keeps turn logs out of git status', async () => {
    const root = ws();
    execFileSync('git', ['init', '-q'], { cwd: root });
    const log = await openTurnLog(root);
    await log.append({ type: 'user-prompt', prompt: 'secret' });
    fs.writeFileSync(path.join(root, '.bandit', 'settings.json'), '{}');
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf-8' });
    expect(status).toContain('.bandit/.gitignore');
    expect(status).toContain('.bandit/settings.json');
    expect(status).not.toContain('turns/');
  });

  it('never overwrites an existing file', async () => {
    const root = ws();
    fs.mkdirSync(path.join(root, '.bandit'));
    fs.writeFileSync(gi(root), 'mine\n');
    await openTurnLog(root);
    expect(fs.readFileSync(gi(root), 'utf-8')).toBe('mine\n');
  });

  it('is written when checkpoints create .bandit/', async () => {
    const root = ws();
    const store = new CheckpointStore({ workspaceRoot: root });
    await store.create({ turnId: 'turn-1', tool: 'write_file', absolutePath: path.join(root, 'a.txt'), before: '', after: 'x', iteration: 1 });
    expect(fs.existsSync(gi(root))).toBe(true);
  });

  it('is not recreated for a deeper folder once the user deleted it', async () => {
    const root = ws();
    await mkdirInProjectBandit(root, path.join(root, '.bandit', 'checkpoints', 't1'));
    fs.rmSync(gi(root));
    await mkdirInProjectBandit(root, path.join(root, '.bandit', 'checkpoints', 't2'));
    expect(fs.existsSync(gi(root))).toBe(false);
  });

  it('has a synchronous variant with the same rules', () => {
    const root = ws();
    mkdirInProjectBanditSync(root, path.join(root, '.bandit', 'pastes'));
    expect(fs.readFileSync(gi(root), 'utf-8')).toBe(PROJECT_GITIGNORE);
    expect(PROJECT_GITIGNORE).toMatch(/^pastes\/$/m);
    fs.rmSync(gi(root));
    mkdirInProjectBanditSync(root, path.join(root, '.bandit', 'pastes', 'x'));
    expect(fs.existsSync(gi(root))).toBe(false);
  });
});

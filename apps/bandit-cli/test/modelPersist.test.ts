import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// config.ts derives ~/.bandit/config.json from os.homedir() at module load, so
// point HOME at a throwaway dir BEFORE importing it — the test must never touch
// the real user config.
const tmpHome = path.join(os.tmpdir(), `bandit-cfg-${process.pid}-${Date.now()}`);
const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;

beforeAll(() => {
  fs.mkdirSync(tmpHome, { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterAll(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// Regression: switching models in the CLI (`/model`) must survive a restart.
describe('model selection persists across sessions', () => {
  it('saveModel writes the choice and the next startup resolves to it', async () => {
    const { saveModel, resolveConfig } = await import('../src/config');
    await saveModel('qwen3.6:35b');

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, '.bandit', 'config.json'), 'utf8'));
    expect(cfg.model).toBe('qwen3.6:35b');
    expect(resolveConfig(cfg, {}).model).toBe('qwen3.6:35b');
  });

  it('only touches the model field, leaving other config intact', async () => {
    const { saveTheme, saveModel } = await import('../src/config');
    await saveTheme('dracula');
    await saveModel('gemma4:e4b');

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, '.bandit', 'config.json'), 'utf8'));
    expect(cfg.model).toBe('gemma4:e4b');
    expect(cfg.theme).toBe('dracula');
  });

  it('an explicit --model flag still overrides the persisted value', async () => {
    const { saveModel, resolveConfig } = await import('../src/config');
    await saveModel('persisted-model');

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, '.bandit', 'config.json'), 'utf8'));
    expect(resolveConfig(cfg, { model: 'flag-model' }).model).toBe('flag-model');
  });
});

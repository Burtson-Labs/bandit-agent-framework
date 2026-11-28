import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => '' }) },
  window: { createOutputChannel: () => ({ appendLine: () => undefined }) }
}));

import { buildPythonSpawnEnv, pathKeyOf } from '../../src/agent/pythonEnvironment';

describe('buildPythonSpawnEnv', () => {
  it('keeps the Windows Path variable as it is', () => {
    const base = { Path: 'C:\\Python312;C:\\Windows\\system32', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    const env = buildPythonSpawnEnv(base, 'win32');
    expect(env.Path).toBe('C:\\Python312;C:\\Windows\\system32');
    expect(env.PATH).toBeUndefined();
    expect(pathKeyOf(env)).toBe('Path');
  });

  it('prepends common install locations on POSIX without dropping the user PATH', () => {
    const env = buildPythonSpawnEnv({ PATH: '/home/u/.pyenv/shims:/usr/bin', HOME: '/home/u' }, 'linux');
    const parts = String(env.PATH).split(':');
    expect(parts).toContain('/usr/local/bin');
    expect(parts.slice(-2)).toEqual(['/home/u/.pyenv/shims', '/usr/bin']);
  });
});

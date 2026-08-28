/**
 * run_command failure hints. A real PDF-generation turn spent 25 iterations and
 * 9 errors relearning that `pip` isn't on PATH, that the Python is PEP-668
 * externally managed, and that `source`/`&&` don't work in a shell-less
 * run_command. These map each failure to its fix so the loop converges fast.
 */
import { describe, it, expect } from 'vitest';
import { runCommandFailureHint } from '../src/tools/core-tools';

describe('runCommandFailureHint', () => {
  it('routes a bare `pip` ENOENT to `python3 -m pip`', () => {
    const h = runCommandFailureHint('pip install fpdf2', 'stderr:\nspawn pip ENOENT');
    expect(h).toMatch(/python3 -m pip/);
  });

  it('routes PEP-668 to a venv with direct binaries (not activate)', () => {
    const h = runCommandFailureHint('python3 -m pip install fpdf2', 'error: externally-managed-environment');
    expect(h).toMatch(/venv/);
    expect(h).toMatch(/\.venv\/bin\/pip/);
    expect(h).toMatch(/do not use `source/i);
  });

  it('flags shell features run_command cannot provide', () => {
    for (const cmd of [
      'python3 -m venv .venv && source .venv/bin/activate && pip install x',
      'cd sub && npm test',
      'cat a | grep b',
    ]) {
      expect(runCommandFailureHint(cmd, 'exit code: 1'), cmd).toMatch(/no shell|ONE program/i);
    }
  });

  it('catches the venv-in-wrong-dir "Unable to create directory" failure', () => {
    const h = runCommandFailureHint('python3 -m venv .venv && source .venv/bin/activate',
      "Error: Unable to create directory '/Users/x/.venv/bin/activate'");
    expect(h).toMatch(/no shell|ONE program/i);
  });

  it('stays silent on unrecognized failures', () => {
    expect(runCommandFailureHint('tsc --noEmit', 'src/x.ts(1,1): error TS2304')).toBe('');
    expect(runCommandFailureHint('npm test', '3 failing')).toBe('');
  });

  it('does not fire on success text that merely mentions pip', () => {
    // Only called on failure, but be defensive: a hint keyed on the word "pip"
    // in normal output would be noise.
    expect(runCommandFailureHint('echo installing pip', 'installing pip packages')).toBe('');
  });
});

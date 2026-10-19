/**
 * list_files shows workspace-relative paths. Hosts return absolute paths;
 * a benchmark run's temp root (`/private/var/folders/.../T/<run>/`) was
 * repeated on every line of every listing, ~20 tokens a file that stayed in
 * the history for the rest of the turn. Paths outside the workspace stay
 * absolute so the model can still use them.
 */
import { describe, expect, it } from 'vitest';
import { listFilesTool, workspaceDisplayPath } from '../src/tools/core-tools';
import type { ToolExecutionContext } from '../src/tools/tool-types';

function ctxWith(files: string[]): ToolExecutionContext {
  return {
    workspaceRoot: '/private/var/folders/x/T/run-1/proj',
    async readFile() { return ''; },
    async writeFile() {},
    async listFiles() { return files; },
    async searchCode() { return ''; },
    async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
  };
}

describe('list_files paths', () => {
  it('lists files inside the workspace relative to its root', async () => {
    const result = await listFilesTool.execute({ pattern: '**/*.py' }, ctxWith([
      '/private/var/folders/x/T/run-1/proj/acme/pricing.py',
      '/private/var/folders/x/T/run-1/proj/tests/test_pricing.py'
    ]));
    expect(result.output).toBe('2 file(s) matched "**/*.py":\n\nacme/pricing.py\ntests/test_pricing.py');
  });

  it('keeps absolute paths for files outside the workspace', () => {
    expect(workspaceDisplayPath('/Users/me/Desktop/a.txt', '/private/var/folders/x/T/run-1/proj')).toBe('/Users/me/Desktop/a.txt');
    // A sibling directory that shares the root as a string prefix is outside.
    expect(workspaceDisplayPath('/repo/proj-two/a.ts', '/repo/proj')).toBe('/repo/proj-two/a.ts');
    expect(workspaceDisplayPath('/repo/proj/a.ts', '/repo/proj/')).toBe('a.ts');
    expect(workspaceDisplayPath('C:\\repo\\proj\\src\\a.ts', 'C:\\repo\\proj')).toBe('src/a.ts');
    expect(workspaceDisplayPath('/repo/proj/a.ts', undefined)).toBe('/repo/proj/a.ts');
  });
});

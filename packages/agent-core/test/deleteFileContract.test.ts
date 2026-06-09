/**
 * Contract tests for the standalone `delete_file` tool. Lives alongside
 * `apply_patch`'s delete branch because the two paths share the same
 * `ctx.deleteFile` primitive, but `delete_file` is the discoverable name
 * the agent should reach for during cleanup tasks (so the model doesn't
 * try `run_command("rm ...")`, hit the allow-list rejection, and stall).
 *
 * Pins:
 *  - Hard delete via ctx.deleteFile when the host wires it.
 *  - Clean isError when the host is missing the primitive (no silent
 *    blanking fallback — apply_patch's blanking is a v1 compat thing,
 *    but for the discoverable tool the contract is "succeed or surface
 *    a useful error", never "leave a 0-byte ghost").
 *  - Error path surfaces the underlying unlink error verbatim so the
 *    model can pivot (e.g. ENOENT means the cleanup already happened).
 *  - The empty-path guard rejects before reaching the host so a
 *    fabricated `path: ""` doesn't unlink the workspace root.
 */
import { describe, expect, it } from 'vitest';
import { deleteFileTool } from '../src/tools/core-tools';
import type { ToolExecutionContext } from '../src/tools/tool-types';

function buildCtx(opts: {
  files: Map<string, string>;
  withDeletePrimitive: boolean;
}): ToolExecutionContext {
  const ctx: ToolExecutionContext = {
    workspaceRoot: '/tmp/test',
    async readFile(p: string) { return opts.files.get(p) ?? ''; },
    async writeFile(p: string, content: string) { opts.files.set(p, content); },
    async listFiles() { return []; },
    async searchCode() { return ''; },
    async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
  };
  if (opts.withDeletePrimitive) {
    ctx.deleteFile = async (p: string) => { opts.files.delete(p); };
  }
  return ctx;
}

describe('delete_file', () => {
  it('hard-deletes the file via ctx.deleteFile when the host wires it', async () => {
    const files = new Map<string, string>([['/tmp/test/doomed.txt', 'goodbye']]);
    const ctx = buildCtx({ files, withDeletePrimitive: true });

    const result = await deleteFileTool.execute({ path: 'doomed.txt' }, ctx);

    expect(result.isError).toBeFalsy();
    expect(files.has('/tmp/test/doomed.txt')).toBe(false);
    expect(result.output).toMatch(/^Deleted doomed\.txt\b/);
    // anti-restate footer — same pattern as write_file / apply_edit.
    expect(result.output).toMatch(/Do not restate/);
  });

  it("surfaces a clear isError when the host doesn't implement ctx.deleteFile — never silently blanks", async () => {
    const files = new Map<string, string>([['/tmp/test/doomed.txt', 'goodbye']]);
    const ctx = buildCtx({ files, withDeletePrimitive: false });

    const result = await deleteFileTool.execute({ path: 'doomed.txt' }, ctx);

    expect(result.isError).toBe(true);
    // File untouched — the rejection path must not produce a 0-byte ghost.
    expect(files.get('/tmp/test/doomed.txt')).toBe('goodbye');
    expect(result.output).toMatch(/not supported by this host/);
    // Points the model at the explicit fallback so the cleanup task still
    // has somewhere to go on older hosts.
    expect(result.output).toMatch(/run_command/);
    expect(result.output).toMatch(/rm doomed\.txt/);
  });

  it('surfaces the underlying unlink error so the model can pivot (ENOENT etc.)', async () => {
    const files = new Map<string, string>();
    const ctx: ToolExecutionContext = {
      workspaceRoot: '/tmp/test',
      async readFile() { return ''; },
      async writeFile() { return; },
      async deleteFile() { throw new Error('ENOENT: no such file'); },
      async listFiles() { return []; },
      async searchCode() { return ''; },
      async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
    };

    const result = await deleteFileTool.execute({ path: 'doomed.txt' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/Error deleting "doomed\.txt"/);
    expect(result.output).toMatch(/ENOENT/);
    expect(files.size).toBe(0);
  });

  it('rejects empty / whitespace path BEFORE reaching the host (no chance to unlink the workspace root)', async () => {
    let deleteCalls = 0;
    const ctx: ToolExecutionContext = {
      workspaceRoot: '/tmp/test',
      async readFile() { return ''; },
      async writeFile() { return; },
      async deleteFile() { deleteCalls += 1; },
      async listFiles() { return []; },
      async searchCode() { return ''; },
      async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
    };

    for (const bad of ['', '   ', '\t\n']) {
      const result = await deleteFileTool.execute({ path: bad }, ctx);
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/path parameter is required/);
    }
    expect(deleteCalls).toBe(0);
  });
});

/**
 * Contract test for `apply_patch` delete behavior, pinned because of
 * a real footgun pre- : the `kind: 'delete'` branch called
 * `ctx.writeFile(absPath, '')` so a deleted file remained on disk as
 * a 0-byte ghost. Bandit's own self-evaluation flagged this as one
 * of the higher-impact gaps. The fix added an optional `deleteFile`
 * primitive on `ToolExecutionContext`; this test pins both branches:
 *
 * - When the host wires `deleteFile`, apply_patch calls it (real rm).
 * - When the host doesn't, apply_patch falls back to blanking with
 * a clear message so the model knows it has to follow up.
 *
 * The fallback is a v1 capability gap, not a desired permanent state;
 * keeping a regression test on it ensures the message stays clear and
 * we notice if the fallback is silently revived for hosts that should
 * have the primitive.
 */
import { describe, expect, it } from 'vitest';
import { applyPatchTool } from '../src/tools/core-tools';
import type { ToolExecutionContext } from '../src/tools/tool-types';

/** Minimal in-memory ctx for a deletion patch. */
function buildCtx(opts: {
  files: Map<string, string>;
  withDeletePrimitive: boolean;
}): ToolExecutionContext {
  const ctx: ToolExecutionContext = {
    workspaceRoot: '/tmp/test',
    async readFile(p: string) {
      return opts.files.get(p) ?? '';
    },
    async writeFile(p: string, content: string) {
      opts.files.set(p, content);
    },
    async listFiles() { return []; },
    async searchCode() { return ''; },
    async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
  };
  if (opts.withDeletePrimitive) {
    ctx.deleteFile = async (p: string) => {
      opts.files.delete(p);
    };
  }
  return ctx;
}

const DELETE_ENVELOPE = [
  '*** Begin Patch',
  '*** Delete File: doomed.txt',
  '*** End Patch'
].join('\n');

describe('apply_patch delete action', () => {
  it('hard-deletes the file when ctx.deleteFile is wired', async () => {
    const files = new Map<string, string>([['/tmp/test/doomed.txt', 'goodbye']]);
    const ctx = buildCtx({ files, withDeletePrimitive: true });

    const result = await applyPatchTool.execute({ patch: DELETE_ENVELOPE }, ctx);
    expect(result.isError).toBeFalsy();
    // File is GONE — not a 0-byte ghost.
    expect(files.has('/tmp/test/doomed.txt')).toBe(false);
    // Output is the clean "Deleted:" message, not the fallback note.
    expect(result.output).toMatch(/^Deleted: doomed\.txt$/m);
    expect(result.output).not.toMatch(/blanked/i);
  });

  it('falls back to blanking when ctx.deleteFile is missing, with a clear note', async () => {
    const files = new Map<string, string>([['/tmp/test/doomed.txt', 'goodbye']]);
    const ctx = buildCtx({ files, withDeletePrimitive: false });

    const result = await applyPatchTool.execute({ patch: DELETE_ENVELOPE }, ctx);
    expect(result.isError).toBeFalsy();
    // File still exists, but is blank — the soft-delete fallback.
    expect(files.get('/tmp/test/doomed.txt')).toBe('');
    // Output explicitly tells the model the host doesn't support hard
    // delete and gives it a follow-up command. Without this signal the
    // model would think the delete fully succeeded and leave a 0-byte
    // ghost on disk forever.
    expect(result.output).toMatch(/blanked/);
    expect(result.output).toMatch(/run_command/);
    expect(result.output).toMatch(/rm doomed\.txt/);
  });

  it('surfaces a delete failure (e.g. unlink ENOENT) as an isError result', async () => {
    const files = new Map<string, string>(); // file does not exist
    const ctx: ToolExecutionContext = {
      workspaceRoot: '/tmp/test',
      async readFile() { return ''; },
      async writeFile() { return; },
      async deleteFile() { throw new Error('ENOENT: no such file'); },
      async listFiles() { return []; },
      async searchCode() { return ''; },
      async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
    };

    const result = await applyPatchTool.execute({ patch: DELETE_ENVELOPE }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/FAILED Delete doomed\.txt/);
    expect(result.output).toMatch(/ENOENT/);
    // Still empty — failed delete didn't accidentally write something.
    expect(files.size).toBe(0);
  });
});

/**
 * A hunk's body is what it says, even when its @@ line counts are wrong.
 *
 * BanditBench native_tools.multi_file_doc_add, qwen3.6:27b, 3 of 3 runs: one hunk headed
 * `@@ -4,6 +4,9 @@` whose body went on past those 6/9 lines to add the docs of both
 * methods. The parser stopped reading at the counts, the rest of the body was dropped, and
 * apply_patch answered "Applied 1 hunk to "src/Controllers/FileController.cs"" with only
 * the class comment written. The model then re-read the file, saw the method docs missing
 * and rewrote both files, which took the run past the fixture's iteration cap.
 */
import { describe, expect, it } from 'vitest';
import { applyParsedPatch, parseUnifiedPatch } from '../src/tools/unified-patch';
import { applyPatchTool } from '../src/tools/core-tools';
import type { ToolExecutionContext } from '../src/tools/tool-types';
import { testCtx } from './_helpers';

const FILE_CONTROLLER = [
  'using Microsoft.AspNetCore.Mvc;',
  '',
  'namespace DemoApi.Controllers',
  '{',
  '    [ApiController]',
  '    [Route("api/[controller]")]',
  '    public class FileController : ControllerBase',
  '    {',
  '        [HttpPost("upload")]',
  '        public IActionResult Upload()',
  '        {',
  '            return Ok();',
  '        }',
  '',
  '        [HttpGet("{id}")]',
  '        public IActionResult Download(string id)',
  '        {',
  '            return Ok();',
  '        }',
  '    }',
  '}',
  ''
].join('\n');

/** The FileController part of the patch from the trace, verbatim. */
const TRACE_PATCH = [
  '--- a/src/Controllers/FileController.cs',
  '+++ b/src/Controllers/FileController.cs',
  '@@ -4,6 +4,9 @@',
  ' namespace DemoApi.Controllers',
  ' {',
  '     [ApiController]',
  '     [Route("api/[controller]")]',
  '+    /// <summary>',
  '+    /// Handles file upload and download operations via the API.',
  '+    /// </summary>',
  '     public class FileController : ControllerBase',
  '     {',
  '         [HttpPost("upload")]',
  '+        /// <summary>',
  '+        /// Uploads a file to the server.',
  '+        /// </summary>',
  '+        /// <returns>An <see cref="OkResult"/> indicating the upload succeeded.</returns>',
  '         public IActionResult Upload()',
  '         {',
  '             return Ok();',
  '         }',
  ' ',
  '         [HttpGet("{id}")]',
  '+        /// <summary>',
  '+        /// Downloads a file by its identifier.',
  '+        /// </summary>',
  '+        /// <param name="id">The unique identifier of the file to download.</param>',
  '+        /// <returns>An <see cref="OkResult"/> with the requested file data.</returns>',
  '         public IActionResult Download(string id)',
  '         {',
  '             return Ok();'
].join('\n');

describe('unified diff hunks whose @@ counts are wrong', () => {
  it('applies the whole body of the hunk from the trace, not just the first 6/9 lines', () => {
    const parsed = parseUnifiedPatch(TRACE_PATCH);
    expect(parsed?.hunks).toHaveLength(1);
    const applied = applyParsedPatch(FILE_CONTROLLER, parsed!);
    expect(applied.ok).toBe(true);
    const next = (applied as { next: string }).next;
    expect(next.match(/<summary>/g)).toHaveLength(3);
    expect(next).toContain('indicating the upload succeeded.</returns>\n        public IActionResult Upload()');
    expect(next).toContain('/// <param name="id">The unique identifier of the file to download.</param>');
  });

  it('a patch that ends in a newline still matches when the file has no blank line there', () => {
    const patch = '@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n';
    const applied = applyParsedPatch('one\ntwo\nthree\n', parseUnifiedPatch(patch)!);
    expect(applied).toEqual({ ok: true, next: 'ONE\ntwo\nthree\n' });
  });

  it('keeps a blank context line inside the counted body (empty line without its space)', () => {
    const patch = '@@ -1,3 +1,3 @@\n a\n\n-b\n+B';
    const applied = applyParsedPatch('a\n\nb\n', parseUnifiedPatch(patch)!);
    expect(applied).toEqual({ ok: true, next: 'a\n\nB\n' });
  });

  it('stops at prose after the hunk', () => {
    const patch = '@@ -1 +1 @@\n-one\n+ONE\n\nThat renames the first line.';
    const parsed = parseUnifiedPatch(patch)!;
    expect(parsed.hunks[0].bodyLines).toEqual(['-one', '+ONE']);
  });

  it('through the tool: the result covers everything the body asked for', async () => {
    const files = new Map([['/work/notes.txt', 'alpha\nbeta\ngamma\ndelta\nepsilon\n']]);
    const ctx: ToolExecutionContext = {
      ...testCtx,
      workspaceRoot: '/work',
      async readFile(p: string) { if (!files.has(p)) {throw new Error(`ENOENT: ${p}`);} return files.get(p)!; },
      async writeFile(p: string, content: string) { files.set(p, content); }
    };
    // Header claims 2/3 lines; the body carries a second insertion further down.
    const patch = '--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,3 @@\n alpha\n+after alpha\n beta\n gamma\n delta\n+after delta\n epsilon';
    const result = await applyPatchTool.execute({ patch }, ctx);
    expect(result.isError).toBeFalsy();
    expect(files.get('/work/notes.txt')).toBe('alpha\nafter alpha\nbeta\ngamma\ndelta\nafter delta\nepsilon\n');
  });
});

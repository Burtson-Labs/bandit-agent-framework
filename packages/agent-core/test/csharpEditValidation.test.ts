/**
 * C# edits to a file that belongs to a project must not be rejected for what a lone-file
 * compile cannot know.
 *
 * Found by BanditBench (2026-10-05): `native_tools.multi_file_doc_add` failed 0/3 for
 * every model on a machine with a C# compiler. The adapter compiles the one file on its
 * own, so `using Microsoft.AspNetCore.Mvc;` is "error CS0234 … are you missing an assembly
 * reference?" before and after any edit, and every edit was refused with "Validation
 * failed after apply_patch". The before/after comparison that should have let it through
 * never matched: the compiler writes `/tmp/bandit_<pid>.cs(10,35)`, a new file name and
 * position on every call.
 *
 * The compiler output below was captured from csc 3.9.0 (Roslyn, Mono) and mcs on macOS.
 */
import { describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import { CSharpAdapter, LanguageAdapterRegistry, summarizeCSharpDiagnostics } from '../src/tools/language-adapters';
import { applyEditTool, applyPatchTool, replaceRangeTool, writeFileTool } from '../src/tools/core-tools';
import type { ToolExecutionContext } from '../src/tools/tool-types';
import { testCtx } from './_helpers';

const HEALTH_CONTROLLER = [
  'using Microsoft.AspNetCore.Mvc;',
  '',
  'namespace DemoApi.Controllers',
  '{',
  '    [ApiController]',
  '    [Route("api/[controller]")]',
  '    public class HealthController : ControllerBase',
  '    {',
  '        [HttpGet]',
  '        public IActionResult Get()',
  '        {',
  '            return Ok(new { status = "healthy" });',
  '        }',
  '    }',
  '}',
  ''
].join('\n');

/** What csc prints for the file above when it is compiled on its own. */
const cscUnresolved = (tmp: string, shift = 0): string => [
  `${tmp}(1,17): error CS0234: The type or namespace name 'AspNetCore' does not exist in the namespace 'Microsoft' (are you missing an assembly reference?)`,
  `${tmp}(${7 + shift},37): error CS0246: The type or namespace name 'ControllerBase' could not be found (are you missing a using directive or an assembly reference?)`,
  `${tmp}(${5 + shift},6): error CS0246: The type or namespace name 'ApiControllerAttribute' could not be found (are you missing a using directive or an assembly reference?)`,
  `${tmp}(${5 + shift},6): error CS0246: The type or namespace name 'ApiController' could not be found (are you missing a using directive or an assembly reference?)`,
  `${tmp}(${10 + shift},16): error CS0246: The type or namespace name 'IActionResult' could not be found (are you missing a using directive or an assembly reference?)`,
  ''
].join('\n');

/** What mcs prints for the same file. */
const MCS_UNRESOLVED = [
  "/tmp/bandit_811.cs(1,17): error CS0234: The type or namespace name `AspNetCore' does not exist in the namespace `Microsoft'. Are you missing an assembly reference?",
  "/tmp/bandit_811.cs(7,37): error CS0246: The type or namespace name `ControllerBase' could not be found. Are you missing an assembly reference?",
  'Compilation failed: 2 error(s), 0 warnings',
  ''
].join('\n');

/** What csc prints once the text itself is broken: syntax errors only. */
const cscSyntax = (tmp: string): string => [
  `${tmp}(12,50): error CS1002: ; expected`,
  `${tmp}(14,26): error CS1026: ) expected`,
  ''
].join('\n');

describe('summarizeCSharpDiagnostics', () => {
  it('drops unresolved-reference diagnostics from csc and from mcs', () => {
    expect(summarizeCSharpDiagnostics(cscUnresolved('/var/folders/x/T/bandit_65472.cs'), 'HealthController.cs')).toBe('');
    expect(summarizeCSharpDiagnostics(MCS_UNRESOLVED, 'HealthController.cs')).toBe('');
  });

  it('keeps syntax errors and names the real file instead of the temp file', () => {
    expect(summarizeCSharpDiagnostics(cscSyntax('/var/folders/x/T/bandit_65472.cs'), 'HealthController.cs')).toBe(
      'HealthController.cs(12,50): error CS1002: ; expected\nHealthController.cs(14,26): error CS1026: ) expected'
    );
  });

  it('keeps other semantic errors, drops warnings and lines with no source position', () => {
    const output = [
      "/tmp/bandit_7.cs(3,9): error CS0103: The name 'cache' does not exist in the current context",
      "/tmp/bandit_7.cs(4,13): warning CS0168: The variable 'unused' is declared but never used",
      "error CS0016: Could not write to output file '/tmp/bandit_7.cs.dll'",
      "/tmp/bandit_7.cs(1,7): error CS0246: The type or namespace name 'Newtonsoft' could not be found (are you missing a using directive or an assembly reference?)"
    ].join('\n');
    expect(summarizeCSharpDiagnostics(output, 'Cache.cs')).toBe("Cache.cs(3,9): error CS0103: The name 'cache' does not exist in the current context");
  });
});

/**
 * A stand-in for the compiler step: decides from the file text what csc would print, with
 * a different temp file name on every call, as the real adapter script produces.
 */
function fakeCompilerCtx(files: Map<string, string>, compile: (content: string, tmp: string) => string): ToolExecutionContext {
  let pid = 4000;
  return {
    ...testCtx,
    workspaceRoot: '/work',
    async readFile(p: string) { if (!files.has(p)) {throw new Error(`ENOENT ${p}`);} return files.get(p)!; },
    async writeFile(p: string, content: string) { files.set(p, content); },
    async runCommand(_cmd: string, args: string[]) {
      const encoded = /Buffer\.from\('([A-Za-z0-9+/=]*)','base64'\)/.exec(args[1] ?? '');
      const content = Buffer.from(encoded?.[1] ?? '', 'base64').toString();
      const stdout = compile(content, `/var/folders/x/T/bandit_${pid++}.cs`);
      return { stdout, stderr: '', exitCode: stdout ? 1 : 0 };
    },
    languageAdapters: new LanguageAdapterRegistry().register(new CSharpAdapter())
  };
}

/** csc as observed: unresolved references while the text parses, syntax errors once it does not. */
const lonelyFileCompiler = (content: string, tmp: string): string => {
  if (/Ok\([^;]*\)\s*\n/.test(content)) {return cscSyntax(tmp);}
  const shift = content.split('\n').findIndex((line) => line.includes('[ApiController]')) - 4;
  return cscUnresolved(tmp, shift);
};

const FILE = '/work/src/Controllers/HealthController.cs';
const DOC = '    /// <summary>\n    /// Reports whether the service is up.\n    /// </summary>\n';

describe('C# edits in a project that needs package references', () => {
  it('apply_edit: a doc comment is written although the file never compiles on its own', async () => {
    const files = new Map([[FILE, HEALTH_CONTROLLER]]);
    const result = await applyEditTool.execute(
      { path: 'src/Controllers/HealthController.cs', find: '    [ApiController]', replace: `${DOC}    [ApiController]` },
      fakeCompilerCtx(files, lonelyFileCompiler)
    );
    expect(result.isError).toBeFalsy();
    expect(files.get(FILE)).toContain('/// <summary>');
  });

  it('apply_patch, replace_range and write_file accept the same edit', async () => {
    const edited = HEALTH_CONTROLLER.replace('    [ApiController]', `${DOC}    [ApiController]`);

    const patched = new Map([[FILE, HEALTH_CONTROLLER]]);
    const patch = [
      '--- a/src/Controllers/HealthController.cs',
      '+++ b/src/Controllers/HealthController.cs',
      '@@ -4,3 +4,6 @@',
      ' {',
      '+    /// <summary>',
      '+    /// Reports whether the service is up.',
      '+    /// </summary>',
      '     [ApiController]',
      '     [Route("api/[controller]")]',
      ''
    ].join('\n');
    const patchResult = await applyPatchTool.execute({ patch }, fakeCompilerCtx(patched, lonelyFileCompiler));
    expect(patchResult.isError, patchResult.output).toBeFalsy();
    expect(patched.get(FILE)).toBe(edited);

    const ranged = new Map([[FILE, HEALTH_CONTROLLER]]);
    const rangeResult = await replaceRangeTool.execute(
      { path: 'src/Controllers/HealthController.cs', start_line: '5', end_line: '5', content: `${DOC}    [ApiController]` },
      fakeCompilerCtx(ranged, lonelyFileCompiler)
    );
    expect(rangeResult.isError, rangeResult.output).toBeFalsy();
    expect(ranged.get(FILE)).toContain('/// <summary>');

    const written = new Map<string, string>();
    const writeResult = await writeFileTool.execute(
      { path: 'src/Controllers/NewController.cs', content: edited },
      fakeCompilerCtx(written, lonelyFileCompiler)
    );
    expect(writeResult.isError, writeResult.output).toBeFalsy();
    expect(written.get('/work/src/Controllers/NewController.cs')).toBe(edited);
  });

  it('a syntax error introduced by the edit is still rejected and the file is left alone', async () => {
    const files = new Map([[FILE, HEALTH_CONTROLLER]]);
    const result = await applyEditTool.execute(
      { path: 'src/Controllers/HealthController.cs', find: 'return Ok(new { status = "healthy" });', replace: 'return Ok(new { status = "healthy" })' },
      fakeCompilerCtx(files, lonelyFileCompiler)
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Validation failed after apply_edit');
    expect(result.output).toContain('HealthController.cs(12,50): error CS1002: ; expected');
    expect(result.output).not.toContain('bandit_');
    expect(files.get(FILE)).toBe(HEALTH_CONTROLLER);
  });

  it('an error the file already had does not block an unrelated edit, wherever the edit moves it', async () => {
    // CS0103 is not a reference diagnostic, so it is reported; it was there before the edit.
    const preExisting = (content: string, tmp: string): string => {
      const line = content.split('\n').findIndex((l) => l.includes('return Ok')) + 1;
      return `${tmp}(${line},20): error CS0103: The name 'Ok' does not exist in the current context\n`;
    };
    const files = new Map([[FILE, HEALTH_CONTROLLER]]);
    const result = await applyEditTool.execute(
      { path: 'src/Controllers/HealthController.cs', find: '    [ApiController]', replace: `${DOC}    [ApiController]` },
      fakeCompilerCtx(files, preExisting)
    );
    expect(result.isError).toBeFalsy();
    expect(files.get(FILE)).toContain('/// <summary>');
  });

  it('a new error of that kind is still rejected', async () => {
    const semantic = (content: string, tmp: string): string =>
      content.includes('Missing()') ? `${tmp}(12,20): error CS0103: The name 'Missing' does not exist in the current context\n` : '';
    const files = new Map([[FILE, HEALTH_CONTROLLER]]);
    const result = await applyEditTool.execute(
      { path: 'src/Controllers/HealthController.cs', find: 'return Ok(new { status = "healthy" });', replace: 'return Missing();' },
      fakeCompilerCtx(files, semantic)
    );
    expect(result.isError).toBe(true);
    expect(files.get(FILE)).toBe(HEALTH_CONTROLLER);
  });
});

// The same three cases against a real compiler, where one is installed.
const hasCompiler = ['csc', 'mcs'].some((bin) => !spawnSync(bin, ['-help'], { encoding: 'utf8' }).error);
const pexec = promisify(execFile);
const realRunCtx: ToolExecutionContext = {
  ...testCtx,
  async runCommand(cmd: string, args: string[]) {
    try {
      const { stdout, stderr } = await pexec(cmd, args, { cwd: process.cwd() });
      return { stdout, stderr, exitCode: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number };
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.code ?? 1 };
    }
  }
};

describe.skipIf(!hasCompiler)('CSharpAdapter against the installed compiler', () => {
  const adapter = new CSharpAdapter();

  it('accepts a controller that needs a package reference, with and without doc comments', async () => {
    expect(await adapter.validate(FILE, HEALTH_CONTROLLER, realRunCtx)).toEqual({ ok: true });
    const documented = HEALTH_CONTROLLER.replace('    [ApiController]', `${DOC}    [ApiController]`);
    expect(await adapter.validate(FILE, documented, realRunCtx)).toEqual({ ok: true });
  }, 60_000);

  it('rejects a missing semicolon and reports it against the real file name', async () => {
    const broken = HEALTH_CONTROLLER.replace('{ status = "healthy" });', '{ status = "healthy" })');
    const result = await adapter.validate(FILE, broken, realRunCtx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^C# compilation error:\nHealthController\.cs\(\d+,\d+\): error CS\d+/);
  }, 60_000);
});

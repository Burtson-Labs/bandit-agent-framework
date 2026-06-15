/**
 * Language-aware pre-write validation adapters.
 *
 * Each adapter checks file content for syntax errors *before* write_file
 * commits the content to disk. On failure the tool returns an isError result
 * so the model can self-correct without ever writing an invalid file.
 *
 * All subprocess-based adapters (Python, TypeScript, C#) silently pass through
 * (ok: true) when the required runtime / compiler is not found on PATH, so the
 * agent degrades gracefully on systems without those tools installed.
 *
 * Adapter routing is by file extension (without leading dot, e.g. "ts").
 */

import * as path from 'path';
import type { ToolExecutionContext, ILanguageAdapterRegistry, ValidationResult } from './tool-types';

// ── Public interface ──────────────────────────────────────────────────────────

export interface LanguageAdapter {
  /** File extensions this adapter handles, without leading dot (e.g. ['ts', 'tsx']). */
  extensions: string[];
  validate(filePath: string, content: string, ctx: ToolExecutionContext): Promise<ValidationResult>;
}

// ── Registry ─────────────────────────────────────────────────────────────────

export class LanguageAdapterRegistry implements ILanguageAdapterRegistry {
  private readonly adapters: LanguageAdapter[] = [];

  register(adapter: LanguageAdapter): this {
    this.adapters.push(adapter);
    return this;
  }

  async validate(filePath: string, content: string, ctx: ToolExecutionContext): Promise<ValidationResult> {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const adapter = this.adapters.find(a => a.extensions.includes(ext));
    if (!adapter) {
      return { ok: true };
    }
    return adapter.validate(filePath, content, ctx);
  }
}

// ── JSON adapter ──────────────────────────────────────────────────────────────

export class JsonAdapter implements LanguageAdapter {
  readonly extensions = ['json'];

  async validate(_filePath: string, content: string, _ctx: ToolExecutionContext): Promise<ValidationResult> {
    try {
      JSON.parse(content);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `JSON syntax error: ${(err as Error).message}` };
    }
  }
}

// ── Python adapter ────────────────────────────────────────────────────────────

export class PythonAdapter implements LanguageAdapter {
  readonly extensions = ['py'];

  async validate(_filePath: string, content: string, ctx: ToolExecutionContext): Promise<ValidationResult> {
    // Base64-encode to avoid all shell-quoting issues (base64 chars: A-Za-z0-9+/=).
    const b64 = Buffer.from(content).toString('base64');
    const result = await ctx.runCommand(
      'python3',
      ['-c', `import ast, base64; ast.parse(base64.b64decode("${b64}").decode())`]
    );
    // exitCode 127 = command not found (python3 not on PATH) → pass through
    if (result.exitCode === 0 || result.exitCode === 127) {
      return { ok: true };
    }
    const detail = (result.stderr || result.stdout).trim();
    return { ok: false, error: `Python syntax error:\n${detail}` };
  }
}

// ── TypeScript / TSX adapter ──────────────────────────────────────────────────

export class TypeScriptAdapter implements LanguageAdapter {
  readonly extensions = ['ts', 'tsx'];

  async validate(filePath: string, content: string, ctx: ToolExecutionContext): Promise<ValidationResult> {
    // Base64-encode content so it can be safely embedded in the node -e script.
    const b64 = Buffer.from(content).toString('base64');

    // ScriptKind matters: transpileModule defaults to plain .ts, where
    // JSX is a syntax error — `</header>` parses as an unterminated
    // regex and EVERY valid .tsx file fails with "'>' expected /
    // Unterminated regular expression literal". That wall made models
    // conclude "the tool environment cannot write TSX" (real CLI run,
    // 2026-06-12 refactor turn: three write_file rejections on valid
    // JSX). Pass a matching fileName + jsx:Preserve so .tsx parses as
    // TSX; .ts stays strict so `<Foo>bar` type assertions still parse
    // as before.
    const isTsx = /\.tsx$/i.test(filePath);
    const script = [
      'try{',
      "const ts=require('typescript');",
      `const r=ts.transpileModule(Buffer.from('${b64}','base64').toString(),`,
      `{reportDiagnostics:true,fileName:'${isTsx ? 'check.tsx' : 'check.ts'}',compilerOptions:{strict:false,skipLibCheck:true${isTsx ? ',jsx:ts.JsxEmit.Preserve' : ''}}});`,
      'const d=r.diagnostics||[];',
      'if(d.length){',
      "process.stdout.write(d.map(x=>typeof x.messageText==='string'?x.messageText:x.messageText.messageText).join('\\n'));",
      'process.exit(1);}',
      '}catch(e){process.exit(0);}' // TypeScript package not found → skip
    ].join('');

    const result = await ctx.runCommand('node', ['-e', script], ctx.workspaceRoot);
    if (result.exitCode !== 0) {
      const detail = (result.stdout || result.stderr).trim();
      return { ok: false, error: `TypeScript syntax error:\n${detail}` };
    }
    return { ok: true };
  }
}

// ── C# adapter ────────────────────────────────────────────────────────────────

/**
 * Cheap C# sanity check that runs even when no Mono/.NET SDK is installed.
 * Catches the common `apply_edit` corruption mode on
 * S3Api/FileController.cs — the final edit left orphaned method-body
 * fragments *after* the class's closing brace, which csc catches as
 * CS1022/CS1008 but silently passes when csc is absent (the adapter
 * exits 0 on ENOENT as a deliberate skip).
 *
 * Strict bracket balancing only — no parser, no AST. String literals
 * and `//` / `/* ... *\/` comments are skipped so braces inside them
 * don't confuse the count. False positives on weird but legal code are
 * possible but rare; the trade-off is cheap universal coverage vs zero
 * coverage without a toolchain.
 */
function cSharpStructureCheck(content: string): ValidationResult {
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    // Line comment — skip to newline.
    if (ch === '/' && content[i + 1] === '/') {
      while (i < n && content[i] !== '\n') {i++;}
      continue;
    }
    // Block comment — skip to closing */.
    if (ch === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) {i++;}
      i += 2;
      continue;
    }
    // String / char / verbatim-string / interpolated-string — skip to
    // the matching delimiter. Interpolated strings can contain braces
    // that are NOT structural, so we must not count them.
    if (ch === '"' || ch === '\'' || (ch === '@' && content[i + 1] === '"') || (ch === '$' && content[i + 1] === '"')) {
      const verbatim = ch === '@';
      const interpolated = ch === '$';
      const quote = verbatim || interpolated ? '"' : ch;
      i += verbatim || interpolated ? 2 : 1;
      let interpDepth = 0;
      while (i < n) {
        const c = content[i];
        if (!verbatim && c === '\\' && content[i + 1] !== undefined) { i += 2; continue; }
        if (interpolated && c === '{' && content[i + 1] !== '{') { interpDepth++; i++; continue; }
        if (interpolated && c === '}' && interpDepth > 0) { interpDepth--; i++; continue; }
        if (c === quote && interpDepth === 0) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '{') {braces++;}
    else if (ch === '}') {braces--;}
    else if (ch === '(') {parens++;}
    else if (ch === ')') {parens--;}
    else if (ch === '[') {brackets++;}
    else if (ch === ']') {brackets--;}
    // An early negative count means a close-bracket with no matching
    // open — definitive corruption, no need to scan the rest.
    if (braces < 0 || parens < 0 || brackets < 0) {
      return {
        ok: false,
        error: `Unbalanced ${braces < 0 ? 'curly brace' : parens < 0 ? 'parenthesis' : 'square bracket'} — a closing delimiter appears with no matching opener (position ${i}). This usually means the last apply_edit truncated or duplicated code at a boundary. Re-read the file and reapply the intended change against the current file content.`
      };
    }
    i++;
  }
  if (braces !== 0 || parens !== 0 || brackets !== 0) {
    const detail: string[] = [];
    if (braces !== 0) {detail.push(`${braces > 0 ? braces + ' unclosed' : -braces + ' extra'} curly brace${Math.abs(braces) === 1 ? '' : 's'}`);}
    if (parens !== 0) {detail.push(`${parens > 0 ? parens + ' unclosed' : -parens + ' extra'} parenthes${Math.abs(parens) === 1 ? 'is' : 'es'}`);}
    if (brackets !== 0) {detail.push(`${brackets > 0 ? brackets + ' unclosed' : -brackets + ' extra'} square bracket${Math.abs(brackets) === 1 ? '' : 's'}`);}
    return {
      ok: false,
      error: `C# structure check: ${detail.join(', ')}. The file is not syntactically balanced. Re-read the file and reapply the intended change against the current content.`
    };
  }
  return { ok: true };
}

export class CSharpAdapter implements LanguageAdapter {
  readonly extensions = ['cs'];

  async validate(_filePath: string, content: string, ctx: ToolExecutionContext): Promise<ValidationResult> {
    // First: cheap structural check that always runs. Catches the
    // truncated-close-brace / duplicated-fragment corruption mode from
    // broken apply_edit calls even when no compiler is installed.
    const structural = cSharpStructureCheck(content);
    if (!structural.ok) {return structural;}
    // Base64-encode content for safe interpolation into the node -e script.
    const b64 = Buffer.from(content).toString('base64');

    // The script:
    // 1. Writes content to an OS temp file
    // 2. Tries 'csc' (Mono C# compiler), then 'mcs' (older Mono alias)
    // 3. Cleans up the temp file + output DLL regardless of outcome
    // 4. If neither compiler is found (ENOENT), exits 0 → silent skip
    const script = [
      "const fs=require('fs'),os=require('os'),cp=require('child_process');",
      "const tmp=os.tmpdir()+'/bandit_'+process.pid+'.cs';",
      "const out=tmp+'.dll';",
      'try{',
      `  fs.writeFileSync(tmp,Buffer.from('${b64}','base64'));`,
      "  let r=cp.spawnSync('csc',['/nologo','/t:library','/out:'+out,tmp],{encoding:'utf8'});",
      "  if(r.error&&r.error.code==='ENOENT')",
      "    r=cp.spawnSync('mcs',['-nologo','-t:library','-out:'+out,tmp],{encoding:'utf8'});",
      '  try{fs.unlinkSync(tmp);fs.unlinkSync(out);}catch{}',
      "  if(r.error&&r.error.code==='ENOENT')process.exit(0);",
      "  if(r.status!==0){process.stdout.write((r.stdout||'')+(r.stderr||''));process.exit(1);}",
      "}catch(e){try{fs.unlinkSync(tmp);}catch{}process.exit(0);}"
    ].join('\n');

    const result = await ctx.runCommand('node', ['-e', script]);
    if (result.exitCode !== 0) {
      const detail = (result.stdout || result.stderr).trim();
      return { ok: false, error: `C# compilation error:\n${detail}` };
    }
    return { ok: true };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a registry pre-loaded with all built-in language adapters:
 * JSON, Python, TypeScript/TSX, and C#.
 *
 * Each adapter silently passes through when its runtime/compiler is unavailable.
 */
export function createDefaultLanguageAdapters(): LanguageAdapterRegistry {
  return new LanguageAdapterRegistry()
    .register(new JsonAdapter())
    .register(new PythonAdapter())
    .register(new TypeScriptAdapter())
    .register(new CSharpAdapter());
}

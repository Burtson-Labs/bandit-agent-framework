/**
 * Core agent tools: read_file, write_file, apply_edit, replace_range, list_files, search_code, run_command.
 *
 * All tools delegate to the injected ToolExecutionContext — no direct
 * dependency on Node.js APIs, VS Code, or any specific host.
 */

import type { AgentTool, ToolExecutionContext, ToolResult } from './tool-types';
import { runPostEditTypeCheck } from './post-edit-checks';
import { ToolRegistry } from './tool-registry';
import { parseUnifiedPatch, applyParsedPatch } from './unified-patch';

const MAX_FILE_CHARS = 80_000;   // ~20k tokens — hard cap for read_file output
const MAX_SEARCH_CHARS = 16_000; // ~4k tokens — cap search results
const MAX_COMMAND_CHARS = 8_000; // cap command output

/**
 * Cross-platform "is this an absolute path?" check. POSIX-only callers
 * used `startsWith('/')` which silently misclassifies Windows absolute
 * paths (`C:\foo`, `\\server\share`) as relative — they then get
 * concatenated onto `workspaceRoot` and the resulting path looks like
 * `C:\Users\…\workspace/C:\Users\…\target`. Centralizing here so every
 * core tool resolves paths the same way on every platform.
 */
/**
 * Post-write syntactic validation. Runs AFTER write_file / apply_edit / replace_range
 * has already saved the file — the goal is to inject feedback into the
 * agent's next turn ("you wrote invalid JSON, fix it") rather than
 * blocking the write itself. Pre-write semantic validation (TS type
 * errors, etc) lives in language-adapters; this layer is for cheap
 * syntactic gates that have a near-zero false positive rate.
 *
 * Currently covers JSON. Designed as a switchable framework so
 * .yaml / .toml / .js parser hooks can drop in later without changing
 * the call sites in apply_edit / write_file.
 *
 * Returns null on success or when the format isn't validated. Returns
 * a short diagnostic when a violation is detected — appended to the
 * tool result so the agent reads it on the next turn.
 */
function validatePostWrite(absolutePath: string, content: string): string | null {
  // Strip query strings / fragments that can ride along on paths and
  // lower-case the extension before dispatch.
  const cleanPath = absolutePath.split(/[?#]/, 1)[0];
  const ext = (cleanPath.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase();
  switch (ext) {
    case 'json':
    case 'jsonc': {
      // Models routinely emit trailing commas, missing quotes, mis-
      // matched braces. JSON.parse is sub-millisecond so we always
      // run it — there's no perf reason to skip. We tolerate the
      // common BOM + trim leading whitespace because some hosts
      // prepend a UTF-8 BOM to written files.
      const trimmed = content.replace(/^\uFEFF/, '').trimStart();
      if (trimmed.length === 0) {return null;} // empty file is valid JSON-zero
      try {
        JSON.parse(content);
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `⚠️ Post-edit JSON validation failed: ${msg}. The file was saved as-is — fix the JSON shape on your next turn.`;
      }
    }
    default:
      return null;
  }
}

function isAbsolutePath(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('~')) {return true;}
  if (/^[A-Za-z]:[\\/]/.test(p)) {return true;}     // C:\foo or C:/foo
  if (p.startsWith('\\\\')) {return true;}          // UNC \\server\share
  return false;
}

function truncate(text: string, max: number, label: string): string {
  if (text.length <= max) {return text;}
  return `${text.slice(0, max)}\n\n[${label}: truncated — ${text.length - max} chars omitted]`;
}

function stableContentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function splitTextLines(text: string): { lines: string[]; eol: '\r\n' | '\n' } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { lines: text.split(eol), eol };
}

// ── read_file ──────────────────────────────────────────────────────────────────

// File extensions we KNOW are binary/archive. Refuse early with a helpful
// pointer instead of dumping 200 KB of garbled UTF-8 at the model (which
// burns context and leads to hallucination).
const BINARY_EXTENSIONS = new Set([
  '.pdf', '.pages', '.docx', '.xlsx', '.pptx', '.key', '.numbers',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.heic',
  '.mp3', '.mp4', '.mov', '.wav', '.flac', '.ogg',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite'
]);

function binaryRefusalMessage(ext: string, relPath: string): string {
  const baseMsg = `"${relPath}" is a ${ext} file — its bytes are not plain text and cannot be read as UTF-8.`;
  const hints: Record<string, string> = {
    '.pdf': 'Use the `read_pdf` tool to extract the text content (host-provided, uses pdf-parse).',
    '.pages': 'Apple Pages documents are zipped XML bundles. Ask the user to export to PDF or DOCX first.',
    '.docx': 'Microsoft Word documents are zipped XML. Not yet supported for direct text extraction.',
    '.xlsx': 'Microsoft Excel files are zipped XML. Not yet supported for direct text extraction.',
    '.pptx': 'Microsoft PowerPoint files are zipped XML. Not yet supported for direct text extraction.'
  };
  const hint = hints[ext] ?? 'Not a text format — ask the user what they want extracted or converted.';
  return `${baseMsg}\n${hint}`;
}

const readFileTool: AgentTool = {
  name: 'read_file',
  description: 'Read the text content of a file with line numbers and a shown_hash for the displayed range. For files larger than ~600 lines, paginate with `offset` (1-based start line) and `limit` (number of lines). Common pattern: read_file(path) first, then if the result is truncated or oversized, follow up with read_file(path, offset=N, limit=120) for the next chunk. When replacing a large displayed block, pass the shown_hash to replace_range.expected_hash. For PDFs use `read_pdf` instead — this tool cannot decode binary formats.',
  parameters: [
    { name: 'path', description: 'File path. Relative paths resolve against the workspace root (e.g. "src/index.ts"). Absolute paths are also accepted (e.g. "/Users/name/Desktop/notes.md", "/etc/hosts").', required: true },
    { name: 'offset', description: 'Optional 1-based start line. When set, only lines from this position onward are returned. Use for paginating large files (e.g. offset=200 to start at line 200).' },
    { name: 'limit', description: 'Optional max number of lines to return starting at `offset` (or line 1 when offset is omitted). Default is "all remaining lines, capped by the global byte budget".' }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const relPath = params.path?.trim();
    if (!relPath) {return { output: 'Error: path parameter is required', isError: true };}

    // Extension check first so we don't burn bytes decoding a binary blob.
    const lastDot = relPath.lastIndexOf('.');
    const ext = lastDot >= 0 ? relPath.slice(lastDot).toLowerCase() : '';
    if (BINARY_EXTENSIONS.has(ext)) {
      return { output: binaryRefusalMessage(ext, relPath), isError: true };
    }

    // A path starting with "~" is home-relative — let the host's tool context
    // expand it rather than prepending the workspace root (which would produce
    // nonsense like /Users/name/~/Desktop/file.md).
    const absPath = isAbsolutePath(relPath)
      ? relPath
      : `${ctx.workspaceRoot}/${relPath}`;
    try {
      const content = await ctx.readFile(absPath);
      // Heuristic: if the first 4 KB contains a high ratio of non-printable
      // bytes, the file is effectively binary even without a known extension.
      const sample = content.slice(0, 4096);
      // eslint-disable-next-line no-control-regex
      const nonPrintable = (sample.match(/[\u0000-\u0008\u000E-\u001F]/g) ?? []).length;
      if (sample.length > 0 && nonPrintable / sample.length > 0.1) {
        return {
          output: `"${relPath}" appears to be binary (${Math.round((nonPrintable / sample.length) * 100)}% non-printable bytes in the first 4 KB). Skipping the raw byte dump. If this is a known format, there may be a dedicated extraction tool.`,
          isError: true
        };
      }
      const { lines: allLines, eol } = splitTextLines(content);
      // Pagination: 1-based offset, limit = max lines returned. Both
      // optional. NaN / non-positive values fall through to "all".
      const parsedOffset = parseInt(params.offset ?? '', 10);
      const parsedLimit = parseInt(params.limit ?? '', 10);
      const startLine = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 1;
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : allLines.length;
      const startIdx = Math.min(allLines.length, startLine - 1);
      const endIdx = Math.min(allLines.length, startIdx + limit);
      const slice = allLines.slice(startIdx, endIdx);
      const isPaginated = startLine > 1 || endIdx < allLines.length;
      // Preserve real line numbers in the rendered output — the model
      // needs them to call apply_edit / a follow-up read_file with an
      // accurate offset.
      const numbered = slice
        .map((line, i) => `${String(startIdx + i + 1).padStart(4, ' ')} │ ${line}`)
        .join('\n');
      // The `<num> │ ` prefix on each line is for the model's
      // navigation only — it is NOT in the file on disk. Smaller
      // models (4B-class) routinely copy-paste those prefix bytes
      // into apply_edit `find` strings, where they never match the
      // real file content and the edit silently no-ops. Observed
      // 2026-05-01 on a React/TS sandbox with gemma4:e4b: model
      // emitted `Find: " 10 │ <link href=..."` and the loop
      // terminated with no edit landed. The header note + the
      // explicit reminder in apply_edit's `find` parameter
      // description together give models a much better chance of
      // stripping the prefix.
      const shownHash = stableContentHash(slice.join(eol));
      const headerSuffix = ` · shown_hash=${shownHash} · \`<num> │ \` prefix is display-only, not part of the file`;
      const header = isPaginated
        ? `File: ${relPath} (${allLines.length} lines total — showing ${startIdx + 1}-${endIdx}${headerSuffix})`
        : `File: ${relPath} (${allLines.length} lines${headerSuffix})`;
      // Hint the model toward the next chunk when more remains. Cheap
      // nudge that consistently produces a follow-up read_file with a
      // correct offset instead of forcing the model to compute it.
      const moreHint = endIdx < allLines.length
        ? `\n\n[read_file: ${allLines.length - endIdx} more lines remain. Next chunk: read_file(path="${relPath}", offset=${endIdx + 1}, limit=${Math.min(120, allLines.length - endIdx)})]`
        : '';
      const output = `${header}\n\n${numbered}${moreHint}`;
      // Mark the file as read so apply_edit / write_file (overwrite)
      // can verify the model actually inspected it before editing. We
      // mark on ANY successful read — even a partial slice — because
      // reading the relevant chunk counts as inspection.
      // No-op when the host context doesn't implement the tracker.
      ctx.markFileRead?.(absPath);
      return { output: truncate(output, MAX_FILE_CHARS, 'read_file') };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Most common failure mode for small models: passing a directory
      // path to read_file when they wanted to list its contents. The
      // raw EISDIR / "Is a directory" error gives them no recovery
      // path and they tend to ask the user for clarification instead
      // of switching tools. Translate the error into an explicit
      // "use ls instead" hint that names the tool the model should
      // have used in the first place.
      if (/EISDIR|is a directory|illegal operation on a directory/i.test(msg)) {
        return {
          output: `"${relPath}" is a directory, not a file. Use \`ls(path="${relPath}")\` to list its contents, or read a specific file inside it (for project discovery, try \`read_file(path="${relPath === '.' ? 'package.json' : `${relPath}/package.json`}")\` for JS projects, \`Cargo.toml\` for Rust, \`pyproject.toml\` for Python, \`go.mod\` for Go).`,
          isError: true
        };
      }
      return { output: `Error reading file "${relPath}": ${msg}`, isError: true };
    }
  }
};

// ── write_file ─────────────────────────────────────────────────────────────────

const writeFileTool: AgentTool = {
  name: 'write_file',
  description: 'Write content to a file, creating it if it does not exist or overwriting it if it does. Returns a confirmation with a line count.',
  parameters: [
    { name: 'path', description: 'File path relative to the workspace root', required: true },
    { name: 'content', description: 'The complete new content for the file', required: true }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const relPath = params.path?.trim();
    const content = params.content;
    if (!relPath) {return { output: 'Error: path parameter is required', isError: true };}
    if (content === undefined || content === null) {return { output: 'Error: content parameter is required', isError: true };}

    // Same rule as read_file: a "~" path is home-relative, not workspace-
    // relative. Leave the "~" for the host context (CliToolExecutionContext
    // expands it via os.homedir) rather than creating a literal "~" dir.
    const absPath = isAbsolutePath(relPath)
      ? relPath
      : `${ctx.workspaceRoot}/${relPath}`;
    // Read-before-edit guard. If the host tracks reads AND the file
    // already exists AND the model never read it this turn, reject.
    // Eliminates "blind overwrite" — the model fabricating content for
    // a file it never inspected (and clobbering whatever was there).
    // Only enforced for OVERWRITES; creating a new file doesn't need
    // a prior read.
    if (ctx.hasFileBeenRead && !ctx.hasFileBeenRead(absPath)) {
      let exists = false;
      try {
        await ctx.readFile(absPath);
        exists = true;
        // We just read it for the existence check. Mark it so the
        // model can proceed if it retries. Honest: the model still
        // hasn't seen the content, so we DON'T mark and reject below.
      } catch {
        exists = false;
      }
      if (exists) {
        return {
          output: `write_file rejected for "${relPath}": this file already exists but you have not read it in this conversation. Overwriting blind would clobber whatever is there. Call read_file("${relPath}") first to inspect the current contents, then retry the write. (For targeted edits to an existing file, prefer apply_edit for small changes or replace_range for larger line-numbered blocks.)`,
          isError: true
        };
      }
    }
    try {
      // Pre-write language validation — if adapters are configured,
      // validate before touching disk. Same lenient handling as
      // apply_edit: if the file already had errors, only block when
      // THIS write introduced new ones. Pre-existing rot doesn't get
      // to gate every subsequent edit.
      if (ctx.languageAdapters) {
        const validation = await ctx.languageAdapters.validate(absPath, content, ctx);
        if (!validation.ok) {
          let beforeError: string | undefined;
          try {
            const existing = await ctx.readFile(absPath);
            const beforeValidation = await ctx.languageAdapters.validate(absPath, existing, ctx);
            beforeError = beforeValidation.error;
          } catch {
            // File doesn't exist yet — write_file is creating it.
            // No before state to be lenient about.
            beforeError = undefined;
          }
          if (beforeError === undefined || introducedNewErrors(beforeError, validation.error)) {
            return {
              output: `Validation failed for "${relPath}":\n${validation.error}\n\nThe file was NOT written. Fix the errors and retry.`,
              isError: true
            };
          }
        }
      }
      await ctx.writeFile(absPath, content);
      const lineCount = content.split('\n').length;
      // Same "don't restate" footer as apply_edit — same Qwen failure
      // mode applies here when the model overwrites an entire file.
      const baseMessage = `Wrote ${lineCount} lines to ${relPath}. File saved. Do not restate the file contents — the user can see the diff. Move on to the next pending task or reply with a brief summary if the work is complete.`;
      const validationWarning = validatePostWrite(absPath, content);
      const postEditCheck = await runPostEditTypeCheck(absPath, ctx).catch(() => ({ newErrorCount: 0, warning: undefined as string | undefined }));
      const trailers = [validationWarning, postEditCheck.warning].filter(Boolean).join('\n\n');
      return {
        output: trailers ? `${baseMessage}\n\n${trailers}` : baseMessage
      };
    } catch (err) {
      return { output: `Error writing file "${relPath}": ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
};

// ── delete_file ────────────────────────────────────────────────────────────────
//
// Standalone file deletion. Exists because `rm` isn't in the run_command
// allow-list (and shouldn't be — its arg surface is too broad to reason
// about) and the agent reaching for `rm` left it stranded on cleanup
// tasks. `apply_patch` with a `*** Delete File:` block does the same job
// but isn't discoverable by name; this tool is. Routes through the host's
// `ctx.deleteFile` (workspace-contained `fs.unlink` on Node hosts) and
// surfaces the per-call permission gate like any other mutation tool.

const deleteFileTool: AgentTool = {
  name: 'delete_file',
  description: 'Permanently delete a file from the workspace. Use this for cleanup tasks (unused components, orphaned templates, dead scripts) instead of run_command("rm ..."). Path must be inside the workspace; the host rejects deletions outside the workspace root. The per-call permission gate still prompts before the delete fires.',
  parameters: [
    { name: 'path', description: 'File path relative to the workspace root (or absolute, but must be inside the workspace).', required: true }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const relPath = params.path?.trim();
    if (!relPath) {return { output: 'Error: path parameter is required', isError: true };}

    const absPath = isAbsolutePath(relPath)
      ? relPath
      : `${ctx.workspaceRoot}/${relPath}`;

    if (typeof ctx.deleteFile !== 'function') {
      // Older host without deleteFile wiring. Don't fall back to
      // blanking (the apply_patch fallback) — silent 0-byte ghosts
      // are worse than a clear error the model can react to.
      return {
        output: `delete_file is not supported by this host. Use run_command("rm ${relPath.replace(/"/g, '\\"')}") instead, or upgrade the host to expose ctx.deleteFile.`,
        isError: true
      };
    }

    try {
      await ctx.deleteFile(absPath);
    } catch (err) {
      return {
        output: `Error deleting "${relPath}": ${err instanceof Error ? err.message : String(err)}`,
        isError: true
      };
    }

    // Same anti-restate footer pattern as write_file/apply_edit. The
    // model has a tendency to narrate what was deleted; the diff
    // already shows it.
    const baseMessage = `Deleted ${relPath}. Do not restate the deletion — the user can see it in the diff. Move on to the next pending task or reply with a brief summary if the work is complete.`;
    // Post-delete project-level type check. Deleting a TS file can
    // break imports across the codebase — caller can be a dozen files
    // that reach into the deleted module's exports. Mirrors the
    // post-edit check on write_file/apply_edit/apply_patch so the
    // model finds out about the breakage on THIS turn, not on the
    // user's next "the build is broken" report.
    const postEditCheck = await runPostEditTypeCheck(absPath, ctx).catch(() => ({ newErrorCount: 0, warning: undefined as string | undefined }));
    return {
      output: postEditCheck.warning ? `${baseMessage}${postEditCheck.warning}` : baseMessage
    };
  }
};

// ── apply_edit ─────────────────────────────────────────────────────────────────
//
// Targeted find/replace on an existing file. Prefer this over write_file for
// small edits — it prevents the "model was asked for a one-line comment, wrote
// a new file" scope blowup we saw on model-rewritten READMEs. Semantics are
// modelled on Claude Code's Edit tool so the pattern is familiar to users
// coming from there:
//
// - `find` must appear in the file — not found is an error.
// - `find` must be UNIQUE unless `replace_all=true` — ambiguous matches are
// rejected so the model can't silently replace the wrong hit.
// - Multi-line find/replace is supported (the string is matched verbatim).
// - The tool cannot be used to create a new file — direct the model to
// write_file for that case.
//
// The same language-adapter validation write_file runs is applied here too,
// so syntax errors in the edited result are caught pre-write.

const applyEditTool: AgentTool = {
  name: 'apply_edit',
  description: 'Apply a targeted find/replace edit to an existing file. PREFERRED over write_file for small changes (renames, one-line fixes, adding a comment, tweaking a value) — it does not rewrite the rest of the file. For larger line-numbered blocks, prefer replace_range after read_file. Fails if `find` is not found, or if `find` appears multiple times unless `replace_all` is "true". Multi-line find/replace is supported.',
  parameters: [
    { name: 'path', description: 'File path. Relative paths resolve against the workspace root; absolute and ~ paths are also accepted.', required: true },
    { name: 'find', description: 'Exact text to locate in the file. Matched verbatim including whitespace and newlines. Must be unique unless replace_all="true" or near_line is set. IMPORTANT: do NOT include the `<num> │ ` line-number prefix from read_file output — that prefix is display-only and is not part of the file. Pass only the raw line content.', required: true },
    { name: 'replace', description: 'Replacement text. May be empty (to delete the matched text).', required: true },
    { name: 'replace_all', description: 'If "true", replace every occurrence of `find`. Default "false" (require unique match).' },
    { name: 'near_line', description: 'Optional 1-based line number. When `find` matches multiple places, pick the occurrence whose start line is closest to this number. Use this when the multi-match error lists candidate line numbers — pick one of those. Ignored if find is unique or replace_all="true".' }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const relPath = params.path?.trim();
    // Accept common param-name aliases the model reaches for. Canonical:
    // find/replace (what we document). Also accepted: old_text/new_text
    // (some fine-tunes default to this) and old_string/new_string
    // (Claude Code Edit-tool convention). Surfaced by the eval when
    // bandit-core-1 emitted old_text/new_text and our tool rejected it
    // with "find parameter is required" even though the payload had all
    // the data we needed.
    const find = params.find ?? params.old_text ?? params.old_string;
    const replace = params.replace ?? params.new_text ?? params.new_string;
    if (!relPath) {return { output: 'Error: path parameter is required', isError: true };}
    if (find === undefined || find === null) {return { output: 'Error: find parameter is required (also accepts old_text, old_string)', isError: true };}
    if (replace === undefined || replace === null) {return { output: 'Error: replace parameter is required (also accepts new_text, new_string)', isError: true };}
    if (find === '') {return { output: 'Error: find parameter must not be empty — use write_file to create a new file', isError: true };}
    if (find === replace) {return { output: 'Error: find and replace are identical — no edit to apply', isError: true };}

    // Scratchpad-placeholder detector. Small models occasionally dump their
    // own internal reasoning into `replace` as a bracketed "token" where
    // code should go, e.g.
    // [pre-existing-code-to-ensure-match-is-not-needed-...]
    // [... existing code ...]
    // [ORIGINAL_CODE]
    // The bracket balance still looks fine so the structure validator
    // passes, but the model has effectively written prose in place of real
    // code. Catch it here and force a retry. on S3Api
    // DownloadSharedFile (Gemma/Bandit Core wrote the placeholder into a
    // method signature).
    const placeholderPatterns = [
      /\[(?:pre-?existing|existing|original|unchanged|same|keep|placeholder|todo|insert|your)[^\]]{0,200}(?:code|lines?|logic|content|here|unchanged)[^\]]{0,200}\]/i,
      /\[\.\.\.\s*(?:existing|original|unchanged|same)[^\]]{0,100}\.\.\.\]/i,
      /\[<[^>]+>\]/,            // <CODE_GOES_HERE>
      /\[(?:TODO|FIXME|HERE|CODE|LINES?|CONTENT)\]/
    ];
    for (const re of placeholderPatterns) {
      const match = re.exec(replace);
      if (match) {
        return {
          output: `apply_edit rejected: \`replace\` contains a scratchpad placeholder (${JSON.stringify(match[0])}). Placeholders like \`[... existing code ...]\` or \`[pre-existing-code-...]\` are NOT substituted — the literal bracketed text lands in the file and breaks it. Re-read the file, copy the actual lines you want preserved into the \`replace\` string verbatim, and retry.`,
          isError: true
        };
      }
    }

    // Double-escape detector. on HealthController.cs:
    // bandit-logic emitted `replace` containing `\n` as two-char escape
    // sequences (backslash+n) rather than real newlines, so the file ended
    // up with `// comment\n// comment\npublic IActionResult Get()` all
    // crammed onto one line with literal backslash-n text between tokens.
    // Narrow trigger: `find` spans multiple lines (so we KNOW multi-line
    // content is expected) AND `replace` contains `\n` escape sequences
    // AND `replace` contains NO real newlines. Legitimate single-line
    // replacements like `console.log("foo\nbar")` won't trip this because
    // `find` would be single-line.
    const findSpansLines = find.includes('\n');
    const replaceHasLiteralNewlineEscape = /\\n/.test(replace);
    const replaceHasActualNewline = replace.includes('\n');
    if (findSpansLines && replaceHasLiteralNewlineEscape && !replaceHasActualNewline) {
      return {
        output: 'apply_edit rejected: `replace` contains literal `\\n` escape sequences but no actual newlines, while `find` spans multiple lines. The replacement looks double-escaped — the two-character `\\n` would land verbatim in the file, collapsing your multi-line edit onto one line. Emit real newline characters in `replace` (a raw newline in the JSON string value), not the literal `\\n` sequence.',
        isError: true
      };
    }

    const absPath = isAbsolutePath(relPath)
      ? relPath
      : `${ctx.workspaceRoot}/${relPath}`;

    // Read-before-edit guard. apply_edit ALWAYS targets an existing
    // file, so the model MUST have read it this turn. Reject blind
    // edits with a copyable error pointing at read_file. The model
    // can't reconstruct file content from training memory; "find"
    // strings will mismatch whitespace/imports it didn't see.
    if (ctx.hasFileBeenRead && !ctx.hasFileBeenRead(absPath)) {
      return {
        output: `apply_edit rejected for "${relPath}": you have not read this file in this conversation. The \`find\` text must match the file verbatim including whitespace; reconstructing it from memory routinely fails. Call read_file("${relPath}") first, then retry apply_edit with the exact text you saw.`,
        isError: true
      };
    }

    let before: string;
    try {
      before = await ctx.readFile(absPath);
    } catch (err) {
      return { output: `Error reading "${relPath}": ${err instanceof Error ? err.message : String(err)}. apply_edit only works on existing files — use write_file to create a new one.`, isError: true };
    }

    // Count occurrences with a literal (non-regex) scan so metacharacters in
    // `find` don't blow up. split+length-1 is cheap and correct for literals.
    let occurrences = before.split(find).length - 1;
    let usedFuzzyWhitespace = false;
    let fuzzySpan: { start: number; end: number } | null = null;
    if (occurrences === 0) {
      // Whitespace-tolerant fallback. Smaller models routinely emit a
      // `find` whose non-whitespace content is correct but whose
      // indentation is one or two columns off — // when bandit-core fired 9 apply_edits in a row, every one
      // failing because the JSX block it was matching had 12 spaces
      // of indent in the file and 14 in the find. Build a regex
      // from `find` that flexes every whitespace run into `\s+`,
      // run it against the file, and accept the edit only when the
      // fuzzy match is unique. If 0 or 2+ fuzzy hits, fall through
      // to the strict error so we don't paper over real ambiguity.
      const escapedFind = find
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+');
      const fuzzyMatches = [...before.matchAll(new RegExp(escapedFind, 'g'))];
      if (fuzzyMatches.length === 1 && fuzzyMatches[0].index !== undefined) {
        const m = fuzzyMatches[0];
        fuzzySpan = { start: m.index!, end: m.index! + m[0].length };
        occurrences = 1;
        usedFuzzyWhitespace = true;
      } else if (fuzzyMatches.length > 1) {
        // Tell the model fuzzy matching saw it but it's ambiguous —
        // they have to add context. Different from "find not found"
        // and different from "exact-match multiple"; honesty about
        // why we couldn't apply.
        return {
          output: `\`find\` text was not found verbatim in "${relPath}", but a whitespace-tolerant match found ${fuzzyMatches.length} candidates and we won't guess which you meant. Re-read the file, extend \`find\` with a unique surrounding line, and retry.`,
          isError: true
        };
      } else {
        // No exact match AND no fuzzy match. Real miss. Surface the
        // closest line in the file so the model can correct the find
        // text without burning an iteration on a re-read.
        const hint = findIndentationHint(before, find);
        const snippet = nearestMatchSnippet(before, find);
        return {
          output: `\`find\` text was not found in "${relPath}". ${hint}Re-read the file with read_file, copy the exact text verbatim (including leading whitespace), and retry.${snippet}`,
          isError: true
        };
      }
    }

    const replaceAll = params.replace_all === 'true';
    const nearLineRaw = params.near_line;
    const nearLine = nearLineRaw !== undefined && nearLineRaw !== null && nearLineRaw !== ''
      ? parseInt(String(nearLineRaw), 10)
      : NaN;
    let nearLineSpan: { start: number; end: number } | null = null;
    if (occurrences > 1 && !replaceAll) {
      // Build the list of candidate match positions once — used both
      // by the near_line picker (when set) and the multi-match error
      // message (when it isn't).
      const matchPositions: { lineNum: number; charIdx: number }[] = [];
      let scanIdx = 0;
      while (true) {
        const idx = before.indexOf(find, scanIdx);
        if (idx === -1) {break;}
        const lineNum = before.slice(0, idx).split('\n').length;
        matchPositions.push({ lineNum, charIdx: idx });
        scanIdx = idx + find.length;
        if (matchPositions.length >= 32) {break;}
      }
      if (Number.isFinite(nearLine) && matchPositions.length > 0) {
        // Pick the candidate whose start line is closest to near_line.
        // Tie goes to the earlier match. Gives the model a
        // deterministic escape from the multi-match trap when GROW
        // guidance isn't enough — with bandit-core
        // 12B which kept *shrinking* its find string on retries.
        let best = matchPositions[0];
        let bestDist = Math.abs(best.lineNum - nearLine);
        for (let i = 1; i < matchPositions.length; i++) {
          const dist = Math.abs(matchPositions[i].lineNum - nearLine);
          if (dist < bestDist) {
            best = matchPositions[i];
            bestDist = dist;
          }
        }
        nearLineSpan = { start: best.charIdx, end: best.charIdx + find.length };
      } else {
        // Surface the line numbers of each candidate so the model can
        // either GROW its `find` or pass `near_line` on the next
        // attempt. The previous error said "extend with surrounding
        // context" and small models would routinely interpret that as
        // "try a smaller, simpler find" — going from an 8-line block
        // to a single line and making the ambiguity worse on every
        // retry. The error now lists candidate line numbers AND
        // points at the deterministic `near_line` parameter.
        const lineList = matchPositions.length > 0
          ? ` Matches start at line${matchPositions.length === 1 ? '' : 's'} ${matchPositions.map(m => m.lineNum).join(', ')}${occurrences > matchPositions.length ? `, …` : ''}.`
          : '';
        return {
          output: `\`find\` text matches ${occurrences} places in "${relPath}".${lineList} Two ways to disambiguate: (1) re-call with \`near_line: <one of the line numbers above>\` to pick that specific match, or (2) GROW your \`find\` string by including 1-2 lines BEFORE or AFTER the change site so the surrounding context is unique. Do NOT shrink \`find\` to a smaller snippet — that increases ambiguity. Or pass replace_all="true" if you really do want every occurrence replaced.`,
          isError: true
        };
      }
    }

    // Indentation-preserving rewrite of `replace`. Models routinely emit
    // multi-line `replace` strings without the matched line's leading
    // whitespace — substring replacement keeps the first line at the
    // original column (it inherits the position of the match) but every
    // subsequent line lands at column 0. Result on disk:
    // [HttpGet] ← original 8-space indent
    // becomes:
    // /// <summary> ← inherits 8-space indent
    // /// returns the health ← lost indent (col 0)
    // /// </summary> ← lost indent (col 0)
    // [HttpGet] ← lost indent (col 0)
    //
    // Heuristic: when find is a single line that matches at a non-zero
    // column AND replace is multi-line AND the first line of replace
    // does not start with whitespace, prepend the match's leading
    // indent to every additional line. Skipped on `replace_all` (each
    // match could have a different indent) and on edits where the model
    // already supplied absolute indent on the first line.
    const finalReplace = (() => {
      if (replaceAll) {return replace;}
      if (find.includes('\n')) {return replace;}
      if (!replace.includes('\n')) {return replace;}
      if (/^\s/.test(replace)) {return replace;}
      const matchIndex = before.indexOf(find);
      if (matchIndex === -1) {return replace;}
      const lineStart = before.lastIndexOf('\n', matchIndex - 1) + 1;
      const indent = before.slice(lineStart, matchIndex);
      if (indent.length === 0 || !/^[ \t]+$/.test(indent)) {return replace;}
      const lines = replace.split('\n');
      return lines
        .map((line, i) => (i === 0 || line.length === 0 ? line : indent + line))
        .join('\n');
    })();

    // When fuzzy whitespace matched, the model's `find` had different
    // indentation than the file. Its `replace` was almost certainly
    // written at the same (wrong) indent as its `find`, so splicing
    // it verbatim into the matched span would land mis-indented code
    // in the middle of correctly-indented code. Compute the indent
    // delta between the find and the matched text and shift every
    // line of `replace` by that delta so the edit lands at the
    // right column. No-op when find and matched first lines have
    // the same indent (fuzzy fired on inner-line whitespace, not
    // outer indent).
    let spliceReplace = finalReplace;
    if (usedFuzzyWhitespace && fuzzySpan) {
      const matchedText = before.slice(fuzzySpan.start, fuzzySpan.end);
      const findIndent = (find.match(/^[ \t]*/) ?? [''])[0];
      const matchedIndent = (matchedText.match(/^[ \t]*/) ?? [''])[0];
      const delta = matchedIndent.length - findIndent.length;
      if (delta !== 0) {
        spliceReplace = finalReplace
          .split('\n')
          .map((line) => {
            if (line.length === 0) {return line;}
            if (delta > 0) {return ' '.repeat(delta) + line;}
            const leading = (line.match(/^[ \t]*/) ?? [''])[0].length;
            return line.slice(Math.min(-delta, leading));
          })
          .join('\n');
      }
    }

    const after = replaceAll
      ? before.split(find).join(finalReplace)
      : nearLineSpan
        ? before.slice(0, nearLineSpan.start) + finalReplace + before.slice(nearLineSpan.end)
        : usedFuzzyWhitespace && fuzzySpan
          ? before.slice(0, fuzzySpan.start) + spliceReplace + before.slice(fuzzySpan.end)
          : before.replace(find, finalReplace);

    if (after === before) {
      // Defensive — should be impossible given the guards above, but stay honest.
      return { output: 'Edit produced no change to the file.', isError: true };
    }

    if (ctx.languageAdapters) {
      const afterValidation = await ctx.languageAdapters.validate(absPath, after, ctx);
      if (!afterValidation.ok) {
        // Pre-existing errors must not gate this edit. If the file was
        // ALREADY broken before our change AND the post-edit errors
        // aren't worse (no new error lines), let the write through.
        // Without this, the model gets stuck unable to edit any file
        // that has unrelated rot — on a real
        // project where plans.tsx had Grid-deprecation + GlossaryKey
        // type issues unrelated to a one-line CSS fix the user asked
        // for. Every apply_edit returned a 16KB TS-compiler dump and
        // the model gave up after iterating on its find/replace 8x.
        const beforeValidation = await ctx.languageAdapters.validate(absPath, before, ctx);
        if (introducedNewErrors(beforeValidation.error, afterValidation.error)) {
          return {
            output: `Validation failed after apply_edit on "${relPath}":\n${afterValidation.error}\n\nThe file was NOT written. Fix the \`find\`/\`replace\` values and retry.`,
            isError: true
          };
        }
        // Pre-existing errors only — write proceeds. Surface the
        // situation in the result so the model knows the file isn't
        // perfectly clean (and won't be tempted to "fix" the
        // unrelated errors in a follow-up turn unless the user asked).
        // Note appended after the success message below.
      }
    }

    try {
      await ctx.writeFile(absPath, after);
    } catch (err) {
      return { output: `Error writing "${relPath}": ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }

    const lineDelta = after.split('\n').length - before.split('\n').length;
    const charDelta = after.length - before.length;
    // Build a delta label that doesn't read as "no change" when the
    // edit only mutated text WITHIN existing lines. Previous version
    // reported "±0 lines" for any line-internal swap (e.g. replacing
    // a footer string with a slightly longer one), which made users
    // think the edit silently no-op'd. Now we always surface byte
    // delta when lines net to zero, so the agent + user see the real
    // change ("modified, +47 chars" instead of "±0 lines").
    const deltaLabel =
      lineDelta > 0 ? `+${lineDelta} line${lineDelta === 1 ? '' : 's'}` :
      lineDelta < 0 ? `${lineDelta} line${lineDelta === -1 ? '' : 's'}` :
      charDelta === 0 ? '±0 lines (unchanged length)' :
      `±0 lines, ${charDelta > 0 ? '+' : ''}${charDelta} chars`;
    const matches = replaceAll && occurrences > 1 ? `${occurrences} occurrences` : '1 occurrence';
    // Post-write syntactic validation. Surfaces invalid-JSON style
    // problems to the agent on its NEXT turn so it can self-correct
    // without the user having to flag the bad output. Append to the
    // tool result rather than fail the edit — the file is already on
    // disk, the agent needs to see the diagnostic to fix it.
    const validationWarning = validatePostWrite(absPath, after);
    // Completion footer. Qwen 2.5 Coder specifically has a tendency to
    // echo the entire updated file back in prose after apply_edit
    // succeeds ("Here is the updated content of FileController.cs: …"
    // with the full 100+ line body). on S3Api. The
    // bare "Replaced X" result leaves the model guessing at next steps;
    // a terse explicit directive converts ~all cases to either another
    // tool call or a one-sentence summary.
    //
    // Also discourage the common "apply_edit → read_file → apply_edit"
    // pattern: after a successful edit, re-reading the whole file just
    // to do another edit bloats context and slows every subsequent
    // turn. on S3Api: a 9-iteration run with 5
    // apply_edits each followed by a full read_file pushed the LLM
    // call to 38s+ and eventually tripped a 504.
    const baseMessage = `Replaced ${matches} in ${relPath} (${deltaLabel}). File saved. Do not restate the file contents — the user can see the diff. Do not re-read this file just to make another edit — you already have the structure in context. Move on to the next pending task or reply with a brief summary if the work is complete.`;
    const postEditCheck = await runPostEditTypeCheck(absPath, ctx).catch(() => ({ newErrorCount: 0, warning: undefined as string | undefined }));
    const trailers = [validationWarning, postEditCheck.warning].filter(Boolean).join('\n\n');
    return {
      output: trailers ? `${baseMessage}\n\n${trailers}` : baseMessage
    };
  }
};

// ── replace_range ──────────────────────────────────────────────────────────────
//
// Line-number based edit for large files. This is deliberately narrower than
// write_file and less brittle than apply_edit when the model has already read a
// paginated slice and needs to replace a whole method/component block.

const replaceRangeTool: AgentTool = {
  name: 'replace_range',
  description: 'Replace an inclusive 1-based line range in an existing text file. Best for large-file refactors after read_file(path, offset, limit): use the visible line numbers instead of sending a huge exact find string. For insertion before line N, set start_line=N and end_line=N-1. The framework requires you to have read the file at least once this conversation (read-tracking guard); you do NOT need to pass expected_hash for normal edits.',
  parameters: [
    { name: 'path', description: 'File path. Relative paths resolve against the workspace root; absolute and ~ paths are also accepted.', required: true },
    { name: 'start_line', description: '1-based first line to replace. For insertion, this is the line to insert before.', required: true },
    { name: 'end_line', description: '1-based last line to replace, inclusive. Use start_line-1 to insert before start_line. Defaults to start_line for a one-line replacement.' },
    { name: 'content', description: 'Replacement text for the range. Empty string deletes the range. Use real newline characters for multi-line replacements.', required: true },
    { name: 'expected_hash', description: 'Advisory only — when passed, the framework compares it against the current range hash and records a warning in the result if they differ, but the edit still proceeds. The read-tracking guard is the real safety mechanism; you do not need to pass this for normal edits. Kept for backwards compatibility with callers that copy shown_hash from read_file.' },
    { name: 'expected_old', description: 'Optional exact old text for the range. When passed, the edit is rejected if the current content does not match — use for short, surgical replacements where the exact source line is known. Stricter than expected_hash; intentionally NOT advisory.' }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const relPath = params.path?.trim();
    const content = params.content ?? params.replace ?? params.new_text;
    if (!relPath) {return { output: 'Error: path parameter is required', isError: true };}
    if (content === undefined || content === null) {return { output: 'Error: content parameter is required', isError: true };}

    const parsedStart = parseInt(params.start_line ?? params.start ?? params.from_line ?? '', 10);
    const parsedEnd = params.end_line !== undefined && params.end_line !== null && params.end_line !== ''
      ? parseInt(params.end_line, 10)
      : Number.isFinite(parsedStart) ? parsedStart : NaN;
    if (!Number.isFinite(parsedStart) || parsedStart < 1) {
      return { output: 'replace_range rejected: start_line must be a positive 1-based line number.', isError: true };
    }
    if (!Number.isFinite(parsedEnd)) {
      return { output: 'replace_range rejected: end_line must be a 1-based line number, or omit it for a one-line replacement.', isError: true };
    }
    if (parsedEnd < parsedStart - 1) {
      return { output: 'replace_range rejected: end_line can only be less than start_line when inserting, and then it must equal start_line - 1.', isError: true };
    }

    const absPath = isAbsolutePath(relPath)
      ? relPath
      : `${ctx.workspaceRoot}/${relPath}`;

    if (ctx.hasFileBeenRead && !ctx.hasFileBeenRead(absPath)) {
      return {
        output: `replace_range rejected for "${relPath}": you have not read this file in this conversation. Line numbers must come from read_file output, not memory. Call read_file("${relPath}", offset=<near the target>, limit=120) first, then retry replace_range.`,
        isError: true
      };
    }

    let before: string;
    try {
      before = await ctx.readFile(absPath);
    } catch (err) {
      return { output: `Error reading "${relPath}": ${err instanceof Error ? err.message : String(err)}. replace_range only works on existing files — use write_file to create a new one.`, isError: true };
    }

    const { lines, eol } = splitTextLines(before);
    const startLine = parsedStart;
    const endLine = parsedEnd;
    if (startLine > lines.length + 1) {
      return { output: `replace_range rejected for "${relPath}": start_line ${startLine} is beyond the end of the file (${lines.length} lines). Re-read the file with read_file to get current line numbers.`, isError: true };
    }
    if (endLine > lines.length) {
      return { output: `replace_range rejected for "${relPath}": end_line ${endLine} is beyond the end of the file (${lines.length} lines). Re-read the file with read_file to get current line numbers.`, isError: true };
    }

    const startIdx = startLine - 1;
    const endIdx = Math.max(startIdx, endLine);
    const currentRange = lines.slice(startIdx, endIdx).join(eol);
    // Mark 2026-05-26: replace_range used to REJECT on hash mismatch.
    // Combined with the per-read shown_hash mechanic, that turned into
    // a loop trap: model reads lines 40-54, copies that wider hash
    // into a replace_range(43-50) call, hashes diverge (because they
    // cover different bytes), edit rejected, model re-reads, picks
    // up a still-wrong hash from the wider read, retries — repeat
    // indefinitely. Captured 2026-05-26 real CLI session: 3-5
    // iterations spinning on a single 8-line replacement.
    //
    // The hash was always weaker safety than the read-tracking guard
    // (hasFileBeenRead) above. In Bandit's single-process single-turn
    // model the file ONLY changes between read and write if WE wrote
    // it, and apply_edit/write_file/replace_range all go through the
    // same context. The hash mainly caught the case where the model
    // misremembers which range it's editing — which the model now
    // gets a warning about, not a rejection.
    //
    // expected_old (below) STAYS strict — it's a tighter check the
    // model opts into for surgical line-level edits, and it always
    // matched intent rather than incidental hash strings.
    const expectedHash = params.expected_hash ?? params.expected_range_hash ?? params.range_hash;
    let hashWarning: string | undefined;
    if (expectedHash) {
      const actualHash = stableContentHash(currentRange);
      if (actualHash !== expectedHash) {
        hashWarning =
          `Note: expected_hash ${expectedHash} did not match the current range hash ${actualHash} — ` +
          `you likely passed shown_hash from a wider read. The edit proceeded anyway because the read-tracking ` +
          `guard verified you read this file. Drop expected_hash on follow-ups; use expected_old when you need a ` +
          `tight surgical match.`;
      }
    }
    if (params.expected_old !== undefined && params.expected_old !== currentRange) {
      return {
        output: `replace_range rejected for "${relPath}" lines ${startLine}-${endLine}: expected_old did not match current file contents. Re-read the range and retry with current text or expected_hash.`,
        isError: true
      };
    }

    const replacementLines = String(content) === '' ? [] : splitTextLines(String(content)).lines;
    const after = [
      ...lines.slice(0, startIdx),
      ...replacementLines,
      ...lines.slice(endIdx)
    ].join(eol);

    if (after === before) {
      return { output: 'replace_range produced no change to the file.', isError: true };
    }

    if (ctx.languageAdapters) {
      const afterValidation = await ctx.languageAdapters.validate(absPath, after, ctx);
      if (!afterValidation.ok) {
        const beforeValidation = await ctx.languageAdapters.validate(absPath, before, ctx);
        if (introducedNewErrors(beforeValidation.error, afterValidation.error)) {
          return {
            output: `Validation failed after replace_range on "${relPath}":\n${afterValidation.error}\n\nThe file was NOT written. Re-read the surrounding lines and retry with a smaller or corrected replacement.`,
            isError: true
          };
        }
      }
    }

    try {
      await ctx.writeFile(absPath, after);
    } catch (err) {
      return { output: `Error writing "${relPath}": ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }

    const removed = Math.max(0, endLine - startLine + 1);
    const added = replacementLines.length;
    const rangeLabel = endLine < startLine
      ? `Inserted ${added} line${added === 1 ? '' : 's'} before line ${startLine}`
      : `Replaced lines ${startLine}-${endLine} (+${added} -${removed})`;
    const baseMessage = `${rangeLabel} in ${relPath}. File saved. Do not restate the file contents — the user can see the diff. Do not re-read this file just to make another nearby edit; continue with the next range or verify when done.`;
    const validationWarning = validatePostWrite(absPath, after);
    const postEditCheck = await runPostEditTypeCheck(absPath, ctx).catch(() => ({ newErrorCount: 0, warning: undefined as string | undefined }));
    const trailers = [hashWarning, validationWarning, postEditCheck.warning].filter(Boolean).join('\n\n');
    return {
      output: trailers ? `${baseMessage}\n\n${trailers}` : baseMessage
    };
  }
};

// ── apply_patch ────────────────────────────────────────────────────────────────
//
// Multi-file envelope. One tool call → many edits across many files.
// Cheaper than N round-trips of apply_edit when the model is doing a
// rename, refactor, or any batch change. Format follows the Codex/
// OpenCode "*** Begin Patch / *** End Patch" envelope so models trained
// on it (gpt-4/5, qwen 2.5+, claude) can emit it natively.
//
// Supported actions in v1:
// *** Update File: <path>
// @@ <unique context line that exists in the file>
// - removed line
// + added line
// unchanged context line (single space prefix)
// *** Add File: <path>
// + content line 1
// + content line 2
// *** Delete File: <path>
//
// (Move is intentionally out of scope for v1 — implement as Add+Delete.)
//
// Each Update block translates to a find/replace internally:
// find = context lines + removed lines (in their original order)
// replace = context lines + added lines (in their original order)
// The same uniqueness/indentation guards as apply_edit apply per-update.
const applyPatchTool: AgentTool = {
  name: 'apply_patch',
  description: 'Apply a multi-file patch in a single tool call. Use this when you have to change 2+ files (rename, refactor, multi-method comment pass) — much cheaper than calling apply_edit N times. Two accepted formats: (1) **standard unified diff** — what `git diff` produces, with `--- a/path`, `+++ b/path`, `@@` hunks, ` `/`-`/`+` body lines. Most models emit this format natively. Single-file unified diffs accepted; for multi-file, concatenate diffs with their own headers. (2) **Codex envelope** — `*** Begin Patch` / `*** End Patch` wrapping `*** Update File: <path>` / `*** Add File:` / `*** Delete File:` blocks. The tool auto-detects the format from the input.',
  parameters: [
    { name: 'patch', description: 'The full patch — either a unified diff (starts with `--- ` / `+++ ` / `@@`) or a `*** Begin Patch` envelope. For unified diffs the path is read from the `+++ b/<path>` header; for the envelope each `*** Update File:` block names its own path.', required: true },
    { name: 'path', description: 'Optional explicit path. When set with a unified diff, overrides whatever the `+++ b/...` header says — useful when the model emits a diff without proper headers.', required: false }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const raw = (params.patch ?? params.input ?? '').trim();
    if (!raw) {return { output: 'Error: patch parameter is required', isError: true };}

    // Auto-detect format. Unified-diff patches start with one of the
    // standard headers (`---`, `+++`, `diff `, `@@`); the Codex format
    // starts with `*** Begin Patch`. When neither pattern matches we
    // bail with a clear error pointing the model at the two supported
    // shapes — better than letting one of the parsers mis-handle a
    // malformed payload.
    const looksUnified =
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('diff ') ||
      raw.startsWith('@@');
    const looksCodex = raw.startsWith('*** Begin Patch');
    if (looksUnified) {
      return executeUnifiedDiffPatch(raw, params.path, ctx);
    }
    if (!looksCodex || !raw.includes('*** End Patch')) {
      return {
        output: 'apply_patch rejected: input is neither a unified diff nor a Codex envelope. Emit either (1) a unified diff starting with `--- a/<path>` + `+++ b/<path>` + `@@` hunks, or (2) a Codex envelope wrapped in `*** Begin Patch` / `*** End Patch`.',
        isError: true
      };
    }

    // Parse into action blocks. Each block starts with `*** Update File:` /
    // `*** Add File:` / `*** Delete File:` and runs until the next block
    // header or `*** End Patch`.
    const body = raw
      .slice(raw.indexOf('\n') + 1)
      .replace(/\n\*\*\* End Patch\s*$/, '')
      .trim();
    // Each hunk is now an *ordered* list of items so context, removed,
    // and added lines stay in the position the model emitted them.
    // v1 collected context separately and concatenated as
    // `context + added` at execute time — that broke any patch where
    // the changes weren't all at the bottom of the hunk (observed
    // 2026-04-27 on S3Api: gemma4:e4b emitted standard interleaved
    // unified-diff hunks for a multi-method comment pass; the parser
    // collapsed them into one big block whose `find` string didn't
    // appear contiguously in the file, returning "hunk text not found"
    // even though the diff was structurally correct).
    type HunkItem = { kind: 'context' | 'removed' | 'added'; text: string };
    type Action =
      | { kind: 'update'; path: string; hunks: HunkItem[][] }
      | { kind: 'add'; path: string; lines: string[] }
      | { kind: 'delete'; path: string };
    const actions: Action[] = [];
    const lines = body.split('\n');
    let current: Action | null = null;
    let currentHunk: HunkItem[] | null = null;
    for (const line of lines) {
      const updateMatch = /^\*\*\* Update File:\s+(.+?)\s*$/.exec(line);
      const addMatch = /^\*\*\* Add File:\s+(.+?)\s*$/.exec(line);
      const deleteMatch = /^\*\*\* Delete File:\s+(.+?)\s*$/.exec(line);
      if (updateMatch) {
        if (current) {actions.push(current);}
        current = { kind: 'update', path: updateMatch[1], hunks: [] };
        currentHunk = null;
        continue;
      }
      if (addMatch) {
        if (current) {actions.push(current);}
        current = { kind: 'add', path: addMatch[1], lines: [] };
        currentHunk = null;
        continue;
      }
      if (deleteMatch) {
        if (current) {actions.push(current);}
        actions.push({ kind: 'delete', path: deleteMatch[1] });
        current = null;
        currentHunk = null;
        continue;
      }
      if (!current) {continue;}
      if (current.kind === 'add') {
        // Add file: every line should start with `+ ` (or be empty).
        if (line.startsWith('+')) {
          current.lines.push(line.slice(line[1] === ' ' ? 2 : 1));
        }
        continue;
      }
      if (current.kind === 'update') {
        if (line.startsWith('@@')) {
          // Start a new hunk. The text after @@ is purely informational
          // (a hint about location); we don't use it for matching.
          currentHunk = [];
          current.hunks.push(currentHunk);
          continue;
        }
        if (!currentHunk) {
          // Update without a prior @@ header — accept it as a single
          // implicit hunk so the model isn't forced to write @@ for
          // trivial single-line changes.
          currentHunk = [];
          current.hunks.push(currentHunk);
        }
        if (line.startsWith('-')) {
          currentHunk.push({ kind: 'removed', text: line.slice(line[1] === ' ' ? 2 : 1) });
        } else if (line.startsWith('+')) {
          currentHunk.push({ kind: 'added', text: line.slice(line[1] === ' ' ? 2 : 1) });
        } else if (line.startsWith(' ')) {
          // Context line preserved IN ORDER — combined with removed/
          // added at execute time to produce a find/replace that
          // matches the file exactly.
          currentHunk.push({ kind: 'context', text: line.slice(1) });
        }
        continue;
      }
    }
    if (current) {actions.push(current);}

    if (actions.length === 0) {
      return { output: 'apply_patch rejected: envelope contained no action blocks. Use `*** Update File:`, `*** Add File:`, or `*** Delete File:` headers.', isError: true };
    }

    // Execute actions sequentially. Stop on the first error to avoid
    // partial application. Surface what succeeded so the model can
    // recover with a smaller patch.
    const results: string[] = [];
    for (const action of actions) {
      const absPath = isAbsolutePath(action.path)
        ? action.path
        : `${ctx.workspaceRoot}/${action.path}`;
      if (action.kind === 'delete') {
        try {
          // when the host wires `deleteFile`, do a real
          // `fs.unlink` so the file is gone from disk. Hosts on older
          // builds fall back to blanking the file with a clear note
          // so the model knows a hard delete didn't happen and can
          // run `rm` via run_command instead. the only
          // path was the blank, which left 0-byte file ghosts behind
          // — Bandit's own self-eval flagged this as a real footgun.
          if (typeof ctx.deleteFile === 'function') {
            await ctx.deleteFile(absPath);
            results.push(`Deleted: ${action.path}`);
          } else {
            await ctx.writeFile(absPath, '');
            results.push(`Deleted (blanked — host does not support hard delete; run \`rm ${action.path}\` via run_command to remove the empty file): ${action.path}`);
          }
        } catch (err) {
          // v1.7.298 right-way fix: don't bail the whole patch on
          // first failure. Log this action's failure and try the rest
          // — model can re-emit just the failed actions.
          results.push(`FAILED Delete ${action.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      if (action.kind === 'add') {
        try {
          await ctx.writeFile(absPath, action.lines.join('\n') + (action.lines.length > 0 ? '\n' : ''));
          results.push(`Added: ${action.path} (${action.lines.length} lines)`);
        } catch (err) {
          results.push(`FAILED Add ${action.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      // Update: apply each hunk. Read-before-edit guard applies.
      if (ctx.hasFileBeenRead && !ctx.hasFileBeenRead(absPath)) {
        results.push(`FAILED Update ${action.path}: read this file with read_file first — apply_patch's "find" strings must match verbatim, which fails on unread files.`);
        continue;
      }
      let before: string;
      try {
        before = await ctx.readFile(absPath);
      } catch (err) {
        results.push(`FAILED Update ${action.path}: cannot read (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      // Process each hunk independently with per-hunk pass/fail.
      // v1.7.298 right-way fix: prior behavior aborted the ENTIRE
      // action (often a 5-file patch) on first hunk failure, even
      // when later hunks would have applied cleanly. The model then
      // had to regenerate the whole patch. Now: try each hunk, apply
      // those that match cleanly, report the rest with enough detail
      // (preview + fuzzy-match attempt notes) for the model to fix
      // just the failed hunks on retry. Per-hunk also adds a
      // whitespace-tolerant fallback: when exact match misses, retry
      // after collapsing whitespace runs in BOTH the file and the
      // find string — if that produces a unique match, use the
      // matched-region positions to splice in the replacement.
      let after = before;
      let hunksApplied = 0;
      let hunksFailed = 0;
      const hunkFailureNotes: string[] = [];
      for (let hi = 0; hi < action.hunks.length; hi++) {
        const hunk = action.hunks[hi];
        const findLines: string[] = [];
        const replaceLines: string[] = [];
        let contextCount = 0;
        for (const item of hunk) {
          if (item.kind === 'context') {
            findLines.push(item.text);
            replaceLines.push(item.text);
            contextCount++;
          } else if (item.kind === 'removed') {
            findLines.push(item.text);
          } else if (item.kind === 'added') {
            replaceLines.push(item.text);
          }
        }
        const find = findLines.join('\n');
        const replace = replaceLines.join('\n');
        if (!find) {
          hunksFailed++;
          hunkFailureNotes.push(`hunk #${hi + 1}: empty (no removed lines and no context)`);
          continue;
        }
        const occurrences = after.split(find).length - 1;
        if (occurrences === 1) {
          after = after.replace(find, replace);
          hunksApplied++;
          continue;
        }
        if (occurrences > 1) {
          hunksFailed++;
          hunkFailureNotes.push(
            `hunk #${hi + 1}: matches ${occurrences} places — add more context to make it unique`
          );
          continue;
        }
        // occurrences === 0: try whitespace-tolerant fallback. Collapse
        // every run of whitespace within a line to a single space (but
        // keep newlines as line separators) on BOTH sides, search,
        // and if there's a unique match recover the original byte range
        // in the file and splice. This catches indentation drift /
        // trailing-whitespace differences without compromising the
        // multi-match safety.
        const normalize = (s: string): string =>
          s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n');
        const normalizedFile = normalize(after);
        const normalizedFind = normalize(find);
        const normalOccurrences = normalizedFile.split(normalizedFind).length - 1;
        if (normalOccurrences === 1) {
          // Map the normalized match back to a real range in `after`.
          // The simplest correct approach: walk `after` line-by-line,
          // accumulating normalized text, and find the line index
          // where the normalized window matches. Then slice the
          // original bytes at that line range and replace with `replace`.
          const afterLines = after.split('\n');
          const findLineCount = find.split('\n').length;
          let matchedStart = -1;
          for (let i = 0; i + findLineCount <= afterLines.length; i++) {
            const window = afterLines.slice(i, i + findLineCount).join('\n');
            if (normalize(window) === normalizedFind) {
              matchedStart = i;
              break;
            }
          }
          if (matchedStart >= 0) {
            const replaceLineCount = replace.split('\n').length;
            const replacedLines = [
              ...afterLines.slice(0, matchedStart),
              ...replace.split('\n'),
              ...afterLines.slice(matchedStart + findLineCount)
            ];
            after = replacedLines.join('\n');
            hunksApplied++;
            void replaceLineCount;
            continue;
          }
        }
        hunksFailed++;
        const preview = find.length > 160 ? find.slice(0, 160) + '…' : find;
        hunkFailureNotes.push(
          `hunk #${hi + 1}: text not found (${contextCount} context line${contextCount === 1 ? '' : 's'} provided). ` +
          `Tried to find:\n${preview.split('\n').map((l) => `      ${l}`).join('\n')}`
        );
      }
      // Write the file IFF we applied at least one hunk. If every
      // hunk failed we leave the file untouched — better to surface
      // the failure than to write a stale snapshot.
      if (hunksApplied > 0) {
        try {
          await ctx.writeFile(absPath, after);
          const lineDelta = after.split('\n').length - before.split('\n').length;
          const tail = hunksFailed > 0
            ? ` — ${hunksApplied}/${action.hunks.length} hunks applied, ${hunksFailed} skipped:\n  ${hunkFailureNotes.join('\n  ')}`
            : ` (${action.hunks.length} hunk${action.hunks.length === 1 ? '' : 's'}, ${lineDelta >= 0 ? '+' : ''}${lineDelta} lines)`;
          results.push(`${hunksFailed > 0 ? 'Partially updated' : 'Updated'}: ${action.path}${tail}`);
        } catch (err) {
          results.push(`FAILED Update ${action.path}: write failed (${err instanceof Error ? err.message : String(err)})`);
        }
      } else {
        results.push(
          `FAILED Update ${action.path}: 0/${action.hunks.length} hunks applied — file left untouched.\n  ${hunkFailureNotes.join('\n  ')}`
        );
      }
    }

    // Aggregate success/failure. The whole call is an error iff
    // EVERY action ended in a hunk-level FAILED line. Partial success
    // is reported with isError:false so the model can build on what
    // landed instead of retrying the whole patch.
    const totalFailures = results.filter((r) => r.startsWith('FAILED ')).length;
    const allFailed = totalFailures === results.length;
    const summary = allFailed
      ? `apply_patch could not land any changes. Inspect the per-action notes below, then either re-emit only the failing hunks with more context (verify whitespace matches read_file output exactly) or fall back to apply_edit for individual lines.`
      : totalFailures > 0
        ? `apply_patch partially applied (${actions.length - totalFailures}/${actions.length} actions changed the file). Failed actions list specific hunks; retry just those.`
        : `Patch applied successfully (${actions.length} action${actions.length === 1 ? '' : 's'}). Do not restate the changes — the user can see the diff. Move on to the next pending task or summarize briefly if done.`;
    return {
      output: `${summary}\n\n${results.join('\n')}`,
      isError: allFailed
    };
  }
};

/**
 * Compare a language-adapter's validation errors before and after an
 * edit and decide whether the edit *introduced* anything new. Returns
 * true when the edit added errors the file didn't already have —
 * those should still block the write. Returns false when the post-edit
 * errors are a subset of the pre-edit errors (the file was already
 * broken in the same ways).
 *
 * We compare by extracting the unique LINES from each error string
 * and asking "are all after-lines also in before-lines?" This is
 * coarse — line numbers shift, error indices change — but in practice
 * TypeScript / ESLint / etc. emit one error per line and the line
 * content (path + diagnostic + message) is stable enough that exact
 * match catches the common case. Errors only hashable by exact line
 * content count toward the introduced-new heuristic.
 */
/**
 * Normalise the `args` value for run_command / watch_command. Handles
 * the case where the model emits a JSON array of strings (common when
 * the model is trained on OpenAI function-calling schemas — they ship
 * `args` as `string[]` natively, and the model inlines that as a JSON
 * literal in the params blob). Returns either a parsed string[] or
 * null when the input doesn't look like a JSON array; callers fall
 * back to space-separated tokenisation in the null case.
 *
 * with gemma4:e4b trying `gh pr create`: model
 * emitted `args: "[\"pr\",\"create\",\"--title\",\"x\",\"--body\",\"y\"]"`,
 * shellTokenize saw the whole JSON string as one token, and `gh`
 * received `"[pr,create,--title,x,--body,y]"` as a single argv. Every
 * invocation failed with `unknown command "[pr,create,…]"`.
 */
function maybeParseJsonArrayArgs(argsString: string): string[] | null {
  const trimmed = argsString.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {return null;}
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed as string[];
    }
  } catch {
    /* not JSON — fall through */
  }
  return null;
}

function introducedNewErrors(before: string | undefined, after: string | undefined): boolean {
  const afterText = after ?? '';
  if (!afterText.trim()) {return false;}
  const beforeText = before ?? '';
  if (!beforeText.trim()) {return true;} // before was clean, after isn't — definitely introduced.
  // Strip position-bearing tokens that change with file content shifts
  // even when the underlying error is unchanged. Without this, renaming
  // "foo" → "foo-renamed" in a file that already had a JSON parse error
  // 30 chars away registered as a NEW error because the message reads
  // "at position 51" before vs "at position 57" after — the user-visible
  // bug was: editing a non-broken part of an already-broken file got
  // gated. in language-adapter regression tests.
  const stripPositions = (line: string): string =>
    line
      .replace(/\bat position \d+/gi, 'at position N')
      .replace(/\b(line|ln) \d+(?: column| col)?(?: \d+)?/gi, 'line N')
      .replace(/:\s*\d+:\d+/g, ':N:N')   // file:line:col → file:N:N
      .replace(/\bcharacter \d+/gi, 'character N')
      .replace(/\boffset \d+/gi, 'offset N');
  const normalize = (s: string): Set<string> => {
    return new Set(
      s.split('\n')
        .map((line) => stripPositions(line.trim()))
        .filter((line) => line.length > 0)
    );
  };
  const beforeSet = normalize(beforeText);
  const afterSet = normalize(afterText);
  for (const line of afterSet) {
    if (!beforeSet.has(line)) {return true;}
  }
  return false;
}

/**
 * Apply a single-file unified-diff payload. Path is read from the
 * `+++ b/<path>` header unless the caller passed an explicit `path`
 * param. We deliberately reuse the same read-before-edit guard,
 * language-adapter validation, and markFileWrite hooks as apply_edit
 * — apply_patch is a different INPUT format, not a different write
 * pipeline.
 */
async function executeUnifiedDiffPatch(
  patchText: string,
  pathOverride: string | undefined,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const parsed = parseUnifiedPatch(patchText);
  if (!parsed) {
    return {
      output: 'apply_patch rejected: input looked like a unified diff but contains no `@@` hunks. Emit at least one hunk header with the form `@@ -<old_start>,<old_count> +<new_start>,<new_count> @@`.',
      isError: true
    };
  }
  // Resolve path: explicit param wins, then `+++ b/<path>` header,
  // then `--- a/<path>`. Strip the `a/` and `b/` prefixes git adds.
  const headerPath = parsed.newPath ?? parsed.oldPath;
  const stripped = headerPath?.replace(/^[ab]\/+/, '');
  const relPath = (pathOverride ?? stripped ?? '').trim();
  if (!relPath) {
    return {
      output: 'apply_patch rejected: no path. The unified diff has no `+++ b/<path>` header AND no explicit `path` param was provided. Either include the headers or pass `path` alongside the patch.',
      isError: true
    };
  }
  const absPath = isAbsolutePath(relPath) ? relPath : `${ctx.workspaceRoot}/${relPath}`;
  // read-then-patch is allowed for apply_patch. The hunk
  // context lines (3+ surrounding lines + @@ line numbers) self-validate
  // memory: if the model is patching from stale memory, applyParsedPatch
  // below catches it with a "hunk context didn't match" error. Removing
  // the upfront read-required rejection lets multi-file patches succeed
  // when SOME of the bundled files were already in conversation context
  // — from a real bandit-cli linter-fix run where
  // the agent tried one apply_patch covering 6 files, got rejected on
  // the first unread file, and burned an iteration re-reading. The
  // hint about "did you read this first?" still fires below when the
  // patch fails AND the file hasn't been read.
  let before: string;
  try {
    before = await ctx.readFile(absPath);
  } catch (err) {
    return { output: `Error reading "${relPath}": ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
  const result = applyParsedPatch(before, parsed);
  if (!result.ok) {
    const haveRead = !ctx.hasFileBeenRead || ctx.hasFileBeenRead(absPath);
    const readHint = haveRead
      ? ''
      : `\n\nYou have not called read_file on "${relPath}" in this conversation. If your hunk context was reconstructed from memory, that's almost certainly why the match failed — call read_file first, then retry with the verbatim text.`;
    const ctxLine = result.contextSnippet ? `\n\nFile content near the expected position:\n${result.contextSnippet}` : '';
    return {
      output: `apply_patch failed: ${result.reason}${readHint}${ctxLine}`,
      isError: true
    };
  }
  if (result.next === before) {
    return { output: 'apply_patch produced no change. Either the patch is empty or it duplicates content already in the file.', isError: true };
  }
  if (ctx.languageAdapters) {
    const afterValidation = await ctx.languageAdapters.validate(absPath, result.next, ctx);
    if (!afterValidation.ok) {
      // Pre-existing-error guard — same as apply_edit. Don't block a
      // patch that targets the comparison-grid bug just because the
      // file ALSO had unrelated TypeScript rot the user hasn't gotten
      // to. See introducedNewErrors() above for the rationale.
      const beforeValidation = await ctx.languageAdapters.validate(absPath, before, ctx);
      if (introducedNewErrors(beforeValidation.error, afterValidation.error)) {
        return {
          output: `Validation failed after apply_patch on "${relPath}":\n${afterValidation.error}\n\nThe file was NOT written. Fix the patch and retry.`,
          isError: true
        };
      }
    }
  }
  try {
    await ctx.writeFile(absPath, result.next);
  } catch (err) {
    return { output: `Error writing "${relPath}": ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
  const lineCount = result.next.split('\n').length;
  const hunkCount = parsed.hunks.length;
  return {
    output: `Applied ${hunkCount} hunk${hunkCount === 1 ? '' : 's'} to "${relPath}" (${lineCount} lines after).`,
    isError: false
  };
}

/**
 * When a `find` string doesn't match, a common cause is whitespace drift —
 * the model reconstructed the target line from memory and got the indent
 * wrong. If we can find a close-but-not-exact version of the first line,
 * surface that so the model sees what it should copy verbatim next time.
 */
function findIndentationHint(source: string, find: string): string {
  const firstLine = find.split('\n', 1)[0].trim();
  if (firstLine.length < 4) {return '';}
  const candidateLine = source.split('\n').find(line => line.trim() === firstLine);
  if (!candidateLine || candidateLine === firstLine) {return '';}
  const indent = candidateLine.match(/^\s*/)?.[0] ?? '';
  if (!indent) {return '';}
  return `Hint: the target line exists in the file but begins with "${indent.replace(/\t/g, '\\t')}" whitespace — your \`find\` is missing that indent. `;
}

/**
 * When apply_edit's `find` doesn't match anywhere in the file, surface a
 * snippet of what the file ACTUALLY contains around the closest fuzzy
 * match. Saves the model a re-read round-trip and prevents the failure
 * mode where it retries the same wrong `find` 3+ times before giving up
 * (observed when the model assumed `<title>Vite + React</title>` still
 * existed when the file already had `<title>my-app</title>` from a prior
 * edit — three iterations wasted before re-reading).
 *
 * Strategy: tokenize the first non-empty line of `find`, score every line
 * in the source by token-overlap, return ±3 lines of context around the
 * best-scoring line if the overlap is high enough to be meaningful. Bail
 * silently when the signal is too weak — better no hint than a misleading
 * one.
 */
function nearestMatchSnippet(source: string, find: string): string {
  const findFirstLine = find.split('\n').find(l => l.trim().length > 0)?.trim();
  if (!findFirstLine || findFirstLine.length < 8) {return '';}
  const findTokens = new Set(
    findFirstLine.split(/[^\w]+/).filter(t => t.length >= 3)
  );
  if (findTokens.size < 2) {return '';}

  const lines = source.split('\n');
  let bestLine = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineTokens = lines[i].split(/[^\w]+/).filter(t => t.length >= 3);
    if (lineTokens.length === 0) {continue;}
    let hits = 0;
    for (const t of lineTokens) {if (findTokens.has(t)) {hits++;}}
    // Normalize by max so a long line with a couple matches doesn't beat
    // a short line where everything matches. Tie-broken by earlier line.
    const score = hits / Math.max(findTokens.size, lineTokens.length);
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }
  // 0.4 token-overlap threshold is the empirical "this is probably the
  // line you meant" cutoff. Lower than that and the snippet is noise.
  if (bestLine < 0 || bestScore < 0.4) {return '';}

  const start = Math.max(0, bestLine - 3);
  const end = Math.min(lines.length, bestLine + 4);
  const widest = String(end).length;
  const snippet = lines
    .slice(start, end)
    .map((line, i) => {
      const lineNum = start + i + 1;
      const marker = (start + i) === bestLine ? '►' : ' ';
      return `${marker} ${String(lineNum).padStart(widest, ' ')} │ ${line}`;
    })
    .join('\n');
  return `\n\nClosest match in the file (line ${bestLine + 1}):\n\n${snippet}\n\nIf the marked line is what you meant to edit, copy its exact text into \`find\` (verbatim, including whitespace) and retry.`;
}

// ── list_files ─────────────────────────────────────────────────────────────────

const listFilesTool: AgentTool = {
  name: 'list_files',
  description: 'List files matching a glob pattern. Searches the workspace root by default; pass an absolute `cwd` to list anywhere else on disk (user home, /tmp, etc). Returns a newline-separated list of file paths. NOTE: glob is matched relative to `cwd`. To find a repo or directory anywhere on the user\'s machine when you don\'t know the path, prefer `run_command` with `find ~ -type d -name "<name>" 2>/dev/null` — list_files alone won\'t walk the whole home tree.',
  parameters: [
    { name: 'pattern', description: 'Glob pattern (e.g. "*.json", "src/**/*.ts", "**/*.md"). Use "*" to match everything in the target directory. Use "**/X" to recursively find X under cwd.', required: true },
    { name: 'cwd', description: 'Directory to search in. Defaults to the workspace root. Accepts absolute paths like "/Users/name/Desktop" or "~" for the user home (optional)' }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const pattern = params.pattern?.trim();
    if (!pattern) {return { output: 'Error: pattern parameter is required', isError: true };}

    const cwd = params.cwd
      ? (isAbsolutePath(params.cwd) ? params.cwd : `${ctx.workspaceRoot}/${params.cwd}`)
      : ctx.workspaceRoot;

    try {
      const files = await ctx.listFiles(pattern, cwd);
      if (!files.length) {return { output: `No files matched pattern "${pattern}"` };}
      const list = files.slice(0, 200).join('\n');
      const suffix = files.length > 200 ? `\n\n[list_files: showing first 200 of ${files.length} files]` : '';
      return { output: `${files.length} file(s) matched "${pattern}":\n\n${list}${suffix}` };
    } catch (err) {
      return { output: `Error listing files: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
};

// ── ls ─────────────────────────────────────────────────────────────────────────
// Dead-simple directory listing. Exists alongside list_files because small
// models (<= 7B) reliably skip the glob+cwd combo but handle single-path
// tools correctly. If the user asks "what's in ~/Desktop" the model can just
// call ls(path="~/Desktop") instead of figuring out the right cwd argument.

const lsTool: AgentTool = {
  name: 'ls',
  description: 'List immediate files and folders inside a directory. Non-recursive. Use this for "what is in folder X" style questions — especially for directories outside the workspace like "~/Desktop", "~/Downloads", "/tmp". For recursive globs use list_files instead.',
  parameters: [
    { name: 'path', description: 'Directory path. Absolute ("/Users/name/Desktop"), tilde-prefixed ("~/Desktop"), or relative to the workspace root (".", "src").', required: true }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const raw = params.path?.trim();
    if (!raw) {return { output: 'Error: path parameter is required', isError: true };}
    // Resolve relative paths against the workspace root. Hosts handle
    // ~ expansion themselves.
    const resolved = isAbsolutePath(raw)
      ? raw
      : `${ctx.workspaceRoot}/${raw}`;
    try {
      // Prefer listDirectoryEntries when the host implements it — the
      // glob-based listFiles fallback walks recursively and only emits
      // `isFile()` entries, so it silently misses every subdirectory.
      // user's "client engament drafts" folder on
      // ~/Desktop was invisible to the agent because listFiles returned
      // only the files directly in Desktop, never the folder itself.
      if (ctx.listDirectoryEntries) {
        const names = await ctx.listDirectoryEntries(resolved);
        if (!names.length) {return { output: `(empty or not found: ${raw})` };}
        return { output: `${names.length} entr${names.length === 1 ? 'y' : 'ies'} in ${raw}:\n${names.join('\n')}` };
      }
      // Fallback path for hosts that predate listDirectoryEntries —
      // files-only, but better than nothing.
      const files = await ctx.listFiles('*', resolved);
      if (!files.length) {return { output: `(empty or not found: ${raw})` };}
      const prefix = resolved.endsWith('/') ? resolved : resolved + '/';
      const names = files.map(f => f.startsWith(prefix) ? f.slice(prefix.length) : f).sort();
      return { output: `${names.length} entr${names.length === 1 ? 'y' : 'ies'} in ${raw} (files only — host does not support directory listing):\n${names.join('\n')}` };
    } catch (err) {
      return { output: `Error listing ${raw}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
};

// ── find_directory ─────────────────────────────────────────────────────────────
// Cross-repo discovery. When the user asks the agent to do work in a repo
// that lives outside the current workspace ("switch to the auth-api repo",
// "edit the stt-api Dockerfile") the model used to fall back to asking
// "where is that repo?" — frustrating because the user already told us the
// name. This tool sweeps the standard clone locations (~/Documents/GitHub,
// ~/Projects, ~/code, ~/dev, ~/repos, ~/work, ~/src) plus the parent of
// the active workspace and returns matching folder names.

/**
 * Tokenise a name for fuzzy matching. Splits on:
 * - Whitespace
 * - Path separators (`/`, `\`)
 * - Hyphens, underscores, dots
 * - camelCase / PascalCase boundaries (so `AuthApi` → `Auth Api`)
 * Then lowercases. Lets a query of "auth api" find a repo named
 * `AuthApi`, `auth-api`, `auth_api`, or `authApi`.
 */
function repoTokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_./\\\s]+/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter(Boolean);
}

/**
 * Score how well a folder name matches a query. Higher is better. 0
 * means no match. Ranks: exact name > exact-token-set > all-tokens-
 * present > substring > nothing.
 */
function repoMatchScore(name: string, query: string): number {
  const lowerName = name.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerName === lowerQuery) {return 1000;}
  const queryTokens = repoTokenize(query);
  const nameTokens = repoTokenize(name);
  if (queryTokens.length === 0) {return 0;}
  // Every query token must appear as a substring of some name token.
  let matched = 0;
  for (const qt of queryTokens) {
    if (nameTokens.some((nt) => nt.includes(qt))) {matched++;}
  }
  if (matched === queryTokens.length) {
    // All tokens accounted for. Bonus when the token sets are equal
    // size (cleaner match than "auth" matching "auth-api-v2").
    const setEquality = nameTokens.length === queryTokens.length ? 100 : 0;
    return 500 + setEquality;
  }
  // Fall back to plain substring on the joined string so partial
  // queries still surface candidates.
  if (lowerName.includes(lowerQuery)) {return 100;}
  return 0;
}

const findDirectoryTool: AgentTool = {
  name: 'find_directory',
  description: 'Locate a repo or folder on the user\'s machine when it is NOT in the current workspace. Searches the user\'s configured `repos.roots` PLUS common clone parents (~/Documents/GitHub, ~/Projects, ~/code, ~/dev, ~/repos, ~/work, ~/src) PLUS the parent of the current workspace, one level deep. Token-based fuzzy match — "auth api" finds AuthApi, auth-api, or auth_api. Call this BEFORE asking the user where a repo lives. Returns absolute (or tilde-prefixed) paths the agent can pass to read_file, list_files, run_command, etc.',
  parameters: [
    { name: 'name', description: 'Folder/repo name to find. Spaces, hyphens, underscores, and camelCase boundaries are all treated as token separators — "auth api" matches AuthApi, "stt api" matches stt-api or sttApi, etc.', required: true }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const query = params.name?.trim();
    if (!query) {return { output: 'Error: name parameter is required', isError: true };}
    if (!ctx.listDirectoryEntries) {
      return { output: 'Error: this host does not support directory enumeration. Fall back to `run_command find ~ -maxdepth 4 -type d -iname "*<name>*"`.', isError: true };
    }

    // Strip the last path segment from workspaceRoot to get its parent —
    // sibling repos sit there in monorepo + multi-repo workflows. User-
    // configured roots come FIRST so the user's stated locations are
    // searched before the built-in defaults.
    const workspaceParent = ctx.workspaceRoot.replace(/[\\/][^\\/]+[\\/]?$/, '') || ctx.workspaceRoot;
    const parents = [
      ...(ctx.customRepoRoots ?? []),
      workspaceParent,
      '~/Documents/GitHub',
      '~/GitHub',
      '~/Projects',
      '~/code',
      '~/dev',
      '~/repos',
      '~/work',
      '~/src',
      '~'
    ];

    interface Hit { path: string; name: string; score: number }
    const seen = new Set<string>();
    const hits: Hit[] = [];

    for (const parent of parents) {
      try {
        const entries = await ctx.listDirectoryEntries(parent);
        for (const entry of entries) {
          if (!entry.endsWith('/')) {continue;}
          const name = entry.slice(0, -1);
          const lower = name.toLowerCase();
          // Dedup by lowercased basename — tilde paths and the workspace
          // parent often resolve to overlapping directories; reporting the
          // same hit twice is noise.
          if (seen.has(lower)) {continue;}
          const score = repoMatchScore(name, query);
          if (score > 0) {
            seen.add(lower);
            hits.push({ path: `${parent}/${name}`, name, score });
          }
        }
      } catch {
        // Parent dir doesn't exist on this machine — normal, skip silently.
      }
    }

    if (hits.length === 0) {
      return { output: `No directories matched "${query}" in:\n${parents.map((p) => `  - ${p}`).join('\n')}\n\nIf the user keeps repos elsewhere, ask for the absolute path or have them run \`/repos add <path>\` to teach Bandit about a new clone parent.` };
    }

    // Sort by score descending; tie-break by shorter name (more
    // specific matches surface first).
    hits.sort((a, b) => (b.score - a.score) || (a.name.length - b.name.length));

    const MAX = 20;
    const top = hits.slice(0, MAX);
    const omitted = hits.length - top.length;

    // Group by score class for friendlier output.
    const exact = top.filter((h) => h.score >= 1000);
    const tokenMatch = top.filter((h) => h.score >= 500 && h.score < 1000);
    const substring = top.filter((h) => h.score < 500);

    const lines: string[] = [];
    if (exact.length) {
      lines.push(`Exact match${exact.length === 1 ? '' : 'es'} for "${query}":`);
      for (const h of exact) {lines.push(h.path);}
    }
    if (tokenMatch.length) {
      if (lines.length) {lines.push('');}
      lines.push(`Token match${tokenMatch.length === 1 ? '' : 'es'} for "${query}":`);
      for (const h of tokenMatch) {lines.push(h.path);}
    }
    if (substring.length) {
      if (lines.length) {lines.push('');}
      lines.push(`Substring match${substring.length === 1 ? '' : 'es'} for "${query}":`);
      for (const h of substring) {lines.push(h.path);}
    }
    if (omitted > 0) {lines.push(`\n[find_directory: showing first ${MAX} of ${hits.length} matches — narrow the query to see the rest]`);}
    return { output: lines.join('\n') };
  }
};

// ── search_code ────────────────────────────────────────────────────────────────

const searchCodeTool: AgentTool = {
  name: 'search_code',
  description: 'Search for a pattern in file contents using regex. Returns matching lines with file paths and line numbers.',
  parameters: [
    { name: 'pattern', description: 'Regex or literal string to search for (e.g. "function login", "TODO:", "interface User")', required: true },
    { name: 'file_glob', description: 'Optional glob to restrict which files are searched (e.g. "*.ts", "src/**/*.tsx")' },
    { name: 'cwd', description: 'Directory to search in. Defaults to the workspace root. Accepts absolute paths for searching outside the workspace (optional)' }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const pattern = params.pattern?.trim();
    if (!pattern) {return { output: 'Error: pattern parameter is required', isError: true };}

    const cwd = params.cwd
      ? (isAbsolutePath(params.cwd) ? params.cwd : `${ctx.workspaceRoot}/${params.cwd}`)
      : ctx.workspaceRoot;

    try {
      const results = await ctx.searchCode(pattern, cwd, params.file_glob);
      if (!results.trim()) {return { output: `No matches found for "${pattern}"` };}
      return { output: truncate(results, MAX_SEARCH_CHARS, 'search_code') };
    } catch (err) {
      return { output: `Error searching code: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
};

// ── run_command ────────────────────────────────────────────────────────────────

/** Commands the agent is allowed to run. Blocks anything destructive.
 * Grouped by ecosystem so additions are obvious. Curation rules:
 * - Build/test/inspect tools: allow.
 * - Shell interpreters (bash/sh/zsh/pwsh): reject — too broad a
 * blast radius for a single command-as-skill style execution.
 * - HTTP clients (curl/wget): allow. Skills that fetch remote data
 * (status checks, webhooks, REST diagnostics) need them. The
 * per-primary permission gate still prompts the user and the
 * web_fetch tool remains the preferred path for content
 * retrieval, but blocking curl outright was forcing skill
 * authors to shell out via subprocess hacks anyway.
 * - Destructive-by-default tools (terraform apply, kubectl delete,
 * aws, gcloud): reject. Users who need them should run in a
 * dedicated shell, not through the agent.
 */
const ALLOWED_COMMANDS = new Set([
  // Node / JS ecosystem
  'npm', 'pnpm', 'yarn', 'npx', 'node', 'ts-node', 'tsx',
  'tsc', 'eslint', 'prettier',
  'jest', 'vitest', 'mocha', 'playwright',
  // Python
  'python', 'python3', 'pip', 'pip3', 'poetry', 'uv', 'pytest', 'ruff', 'mypy', 'black',
  // Git + version control. `gh` is the GitHub CLI — used for PR / issue
  // / release operations. Same blast-radius profile as git itself; the
  // agent already does git_commit / git_push via dedicated tools, so
  // gh is just the remote-side counterpart (gh pr create, gh issue
  // list, etc). Without it the agent can stage + commit but can't
  // ship the PR, which makes "make a PR for me" tasks dead-end at
  // the local commit.
  'git', 'gh',
  // Rust
  'cargo', 'rustc', 'rustup',
  // Go
  'go', 'gofmt',
  // .NET (Mac/Linux: SDK ships dotnet CLI that covers build/test/run)
  'dotnet', 'nuget',
  // Java / JVM
  'mvn', 'gradle', 'gradlew', './gradlew', 'java', 'javac', 'kotlin', 'kotlinc',
  // Ruby
  'ruby', 'bundle', 'bundler', 'rake', 'rspec', 'gem',
  // PHP
  'php', 'composer', 'phpunit',
  // Swift / iOS / macOS
  'swift', 'xcodebuild', 'pod',
  // macOS automation — osascript runs AppleScript/JXA and is gated further
  // by TCC (Automation/Full Disk Access) at the OS level, so a malicious
  // script can't actually reach protected resources without the user
  // having already granted the terminal per-app permission.
  'osascript',
  // C / C++ / generic build
  'make', 'cmake', 'ninja', 'gcc', 'clang', 'g++', 'clang++',
  // Docker (build/inspect only — destructive flags are up to user policy
  // via BLOCKED_PATTERNS if they want to narrow further)
  'docker', 'docker-compose', 'podman',
  // File inspection / diagnostics — read-only
  'ls', 'cat', 'echo', 'pwd', 'head', 'tail', 'wc', 'file', 'stat', 'which',
  'grep', 'rg', 'find', 'tree',
  // Filesystem mutation — needed for project scaffolding ("create a folder
  // on Desktop and run create-react-app there"). Without these the agent
  // can write files via write_file but can't create directories,
  // move/rename, or duplicate. BLOCKED_PATTERNS still catches `rm -rf`,
  // `mkfs`, `dd if=`, etc. `rm` itself isn't on the list — the dedicated
  // delete_file tool covers single-file deletes through the user's gate.
  'mkdir', 'mv', 'cp', 'touch', 'ln', 'chmod',
  // JSON / YAML transform utilities
  'jq', 'yq',
  // Text processing — stream editors and pipeline staples. sed/awk let the
  // agent do small transforms without round-tripping through apply_edit.
  'sed', 'awk', 'diff', 'sort', 'uniq', 'cut', 'tr', 'xargs',
  // System / env diagnostics — read-only.
  'date', 'env', 'printenv', 'base64', 'df', 'du', 'ps', 'top',
  'id', 'whoami', 'hostname', 'uname', 'time',
  // Process management — needed for "kill the dev server then restart on
  // a different port" workflows. pkill/kill exit cleanly when no match,
  // BLOCKED_PATTERNS catches the catastrophic shapes, and the per-call
  // approval gate still prompts before each invocation.
  'pkill', 'kill', 'lsof',
  // Database CLIs — read/write tools the agent reaches for during data
  // tasks ("show me the users table", "run this migration"). Each is
  // gated by per-call approval; nothing here is more dangerous than
  // what the agent could already do via raw SQL inside an app process.
  'psql', 'mysql', 'sqlite3', 'redis-cli', 'mongosh', 'mongo',
  // Cloud provider CLIs — common when scaffolding infra or inspecting
  // deployed resources. The destructive subcommands (terminate, delete,
  // destroy) still get per-call approval.
  'aws', 'gcloud', 'az',
  // Network diagnostics — read-only host/port/dns checks. Frequently
  // needed when debugging "why can't I reach this service" issues.
  'ping', 'dig', 'nslookup', 'traceroute', 'host', 'nc',
  // Modern JS runtimes — bun and deno parallel node/npx in many repos.
  // Without them the agent has to fall back to "tell the user to run it
  // themselves" for any bun-script.ts / deno run target.
  'bun', 'deno', 'bunx',
  // GitLab CLI — same blast-radius profile as gh. The fewer "I can do
  // this on GitHub but not GitLab" asymmetries the better.
  'glab',
  // Infra-as-code — terraform/ansible/pulumi. Plan/apply/destroy all
  // run through the per-call approval gate, and BLOCKED_PATTERNS still
  // catches catastrophic shapes (rm -rf state files, etc).
  'terraform', 'ansible', 'ansible-playbook', 'pulumi',
  // Archive utilities — used by builds and release flows.
  'tar', 'zip', 'unzip', 'gzip', 'gunzip',
  // macOS convenience — clipboard + Finder/default-app open.
  'pbcopy', 'pbpaste', 'open',
  // Package managers / ops CLIs — explicitly requested by the user.
  // brew installs are slow and destructive-by-default; kubectl/helm can
  // take prod-facing actions. Left allow-listed because the workflow
  // needs them; BLOCKED_PATTERNS still blocks `rm -rf` and similar, and
  // the user's permissionStore still gates per-primary approval.
  'brew', 'kubectl', 'helm',
  // HTTP clients — needed by skills that hit REST APIs, webhooks,
  // status endpoints, etc. The web_fetch tool covers most content
  // retrieval but skills using -H custom headers, -X POST bodies,
  // or -d form data need the real curl/wget. Per-primary permission
  // gate still prompts before each unique invocation.
  'curl', 'wget'
]);

const BLOCKED_PATTERNS = [/rm\s+-rf/, /rmdir/, /format/, /mkfs/, /dd\s+if=/];

/**
 * Map of well-known CLIs the agent might be asked to install but that
 * aren't on the allow-list themselves (terraform, kubectl when not yet
 * installed, ripgrep, jq, etc). When the agent calls `run_command` with
 * one of these, instead of dumping the entire 200-entry allow-list as
 * an error, we point it at the install path so the next tool call has
 * a chance of being correct: "you can install <name> via `brew install
 * <name>` then re-run the original command".
 */
const INSTALL_HINTS: Record<string, string> = {
  terraform: 'brew install terraform',
  ripgrep: 'brew install ripgrep',
  fzf: 'brew install fzf',
  bat: 'brew install bat',
  eza: 'brew install eza',
  exa: 'brew install eza',
  fd: 'brew install fd',
  tldr: 'brew install tldr',
  httpie: 'brew install httpie',
  http: 'brew install httpie',
  ngrok: 'brew install ngrok',
  rclone: 'brew install rclone',
  ffmpeg: 'brew install ffmpeg',
  imagemagick: 'brew install imagemagick',
  yt: 'pipx install yt-dlp',
  'yt-dlp': 'pipx install yt-dlp',
  vercel: 'npm install -g vercel',
  netlify: 'npm install -g netlify-cli',
  wrangler: 'npm install -g wrangler',
  pnpm: 'npm install -g pnpm',
  yarn: 'npm install -g yarn',
  bun: 'brew install oven-sh/bun/bun',
  deno: 'brew install deno',
  poetry: 'pipx install poetry',
  pipx: 'brew install pipx',
  uv: 'pipx install uv',
  rye: 'curl -sSf https://rye-up.com/get | bash',
  awscli: 'brew install awscli',
  aws: 'brew install awscli',
  azd: 'brew install azd',
  doctl: 'brew install doctl',
  flyctl: 'brew install flyctl',
  fly: 'brew install flyctl',
  helm: 'brew install helm',
  kubectx: 'brew install kubectx',
  k9s: 'brew install k9s',
  stern: 'brew install stern',
  argocd: 'brew install argocd'
};

/**
 * Map of well-known commands the agent might reach for that have a
 * dedicated tool elsewhere in the registry. When the model hits
 * `run_command` with one of these, point it at the proper tool
 * instead of the !-prefix escape hatch — the agent should use the
 * dedicated tool, not ask the user to type a shell command.
 */
const DEDICATED_TOOL_HINTS: Record<string, string> = {
  rm: 'delete_file({ path: "<file>" })',
  unlink: 'delete_file({ path: "<file>" })'
};

function rejectionMessage(baseCmd: string): string {
  // Keep the message short. A previous version dumped all ~80 entries of
  // ALLOWED_COMMANDS into the error string, which read as a wall-of-text
  // HTTP-style failure to small models — they'd interpret it as a fatal
  // "500" and bail out of the turn instead of recovering. Three lines is
  // enough: what failed, the install/dedicated-tool path (if known),
  // and the !-prefix escape hatch as a last resort. The model can ask
  // for the full allow-list if it needs one — it never does in practice.
  const lower = baseCmd.toLowerCase();
  // Shell interpreters are blocked by design. Steer the MODEL (not the user)
  // to call the binary directly — gemma-family models reach for
  // `bash -c "diff …"` and, on rejection, retry the same wrapper instead of
  // adapting. Give them the concrete shape + the dedicated-tool alternatives.
  if (['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'pwsh', 'powershell'].includes(lower)) {
    return `"${baseCmd}" (a shell interpreter) is blocked. Do NOT wrap commands in \`${baseCmd} -c "…"\` — call the program directly: put the binary in cmd and the rest in args (e.g. cmd="diff", args="-rq dirA dirB"). For pipes or globs, run the steps separately or use the dedicated tools (\`search_code\` for grep, \`list_files\` for find).`;
  }
  const dedicated = DEDICATED_TOOL_HINTS[lower];
  if (dedicated) {
    // Cleanup tasks need a dedicated tool, not a shell-escape ask. The
    // !-prefix hint here would push the user, not the agent, to act —
    // wrong direction for a tool the agent should call itself.
    return `"${baseCmd}" is not in the run_command allow-list. Use the dedicated tool: ${dedicated}.`;
  }
  const hint = INSTALL_HINTS[lower];
  const installLine = hint
    ? `Install it first: run_command("${hint}"), then retry.`
    : `If it ships via a package manager already on the allow-list (brew, npm, pip, cargo, gem, go), install it first.`;
  return `"${baseCmd}" is not in the run_command allow-list. ${installLine} Or tell the user to type \`!${baseCmd} <args>\` in the composer — the \`!\`-prefix runs directly in their shell and bypasses the gate.`;
}

/**
 * Shell-aware argv tokenizer. Replaces the naive `split(/\s+/)` that
 * previously destroyed quoted arguments — breaking
 * every osascript -e '...' invocation from the email-manager skill
 * because the single-quoted AppleScript body was split on its internal
 * spaces (error -2740: "A unknown token can't go here").
 *
 * Rules:
 * - Whitespace splits tokens unless inside a quote.
 * - Single quotes preserve EVERYTHING verbatim (no escapes) — this is
 * what AppleScript `-e '...'` relies on.
 * - Double quotes allow backslash escapes on `\"`, `\\`, `\$`, `` \` ``;
 * everything else is literal (matches POSIX sh semantics closely
 * enough for our purposes).
 * - Backslash outside quotes escapes the next character.
 * - Single and double quotes are STRIPPED from the output (they're
 * delimiters, not content).
 */
function shellTokenize(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;
  const push = () => {
    if (hasToken || current.length > 0) {out.push(current);}
    current = '';
    hasToken = false;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inSingle) {
      if (ch === '\'') { inSingle = false; hasToken = true; continue; }
      current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') { inDouble = false; hasToken = true; continue; }
      if (ch === '\\' && i + 1 < input.length && /["\\$`]/.test(input[i + 1])) {
        current += input[i + 1];
        i++;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '\'') { inSingle = true; hasToken = true; continue; }
    if (ch === '"') { inDouble = true; hasToken = true; continue; }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1];
      i++;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0 || hasToken) {push();}
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (current.length > 0 || hasToken) {push();}
  return out;
}

const runCommandTool: AgentTool = {
  name: 'run_command',
  description: 'Run a shell command in the workspace and return the output. Allowed commands span common dev stacks: node/pnpm/npm/npx, python/pip/pytest, git, cargo, go, dotnet, mvn/gradle/java, ruby/bundle, php/composer, swift/xcodebuild, make/cmake, docker, package managers (brew, npm install -g, pip install, pipx, cargo install, gem install, go install), and read-only inspection tools (ls, cat, head, tail, grep, find, jq, yq). When the user asks you to install a CLI or package, run the install via the right package manager — the host\'s permission gate prompts the user before each invocation, so attempting an install is the correct behavior, not refusal. Only fall back to "ask the user to run it in their shell" when the command is genuinely outside the allow-list AND no package-manager equivalent exists. Call the binary directly via cmd/args (cmd="git", args="status") — NEVER wrap it in `bash -c` / `sh -c` / `zsh -c`; shell interpreters are blocked and the runner already spawns the program for you. For pipes or globs, use `search_code` (grep) or `list_files` (find), or run the steps separately.',
  parameters: [
    { name: 'cmd', description: 'The command to run (e.g. "npm", "tsc", "git")', required: true },
    { name: 'args', description: 'Space-separated arguments (e.g. "run build", "status", "--noEmit")' },
    { name: 'cwd', description: 'Working directory relative to workspace root (optional)' }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const rawCmd = params.cmd?.trim();
    if (!rawCmd) {return { output: 'Error: cmd parameter is required', isError: true };}

    // Some models squish the entire command line into `cmd` ("npx create
    // @angular/cli mqtt-app") instead of splitting it across `cmd` /
    // `args` per the schema. Normalize before the allow-list check —
    // otherwise the lookup is `ALLOWED_COMMANDS.has("npx create ...")`
    // which always misses, and the user sees the model loop on a
    // command they already approved ( model
    // approved ng / npx / npm three times in a row, every invocation
    // 500'd with "command not in the allowed list" because the entire
    // command line was being treated as a single executable name).
    let cmd = rawCmd;
    let argsString = params.args ?? '';
    const preparsedArgs = maybeParseJsonArrayArgs(argsString);
    const firstSpace = rawCmd.search(/\s/);
    if (firstSpace > 0 && !preparsedArgs) {
      cmd = rawCmd.slice(0, firstSpace);
      const inlineArgs = rawCmd.slice(firstSpace + 1).trim();
      argsString = argsString ? `${inlineArgs} ${argsString}` : inlineArgs;
    }

    const baseCmd = cmd.split('/').pop() ?? cmd;
    if (!ALLOWED_COMMANDS.has(baseCmd)) {
      return { output: rejectionMessage(baseCmd), isError: true };
    }

    const fullCommand = preparsedArgs
      ? `${cmd} ${preparsedArgs.join(' ')}`.trim()
      : `${cmd} ${argsString}`.trim();
    for (const blocked of BLOCKED_PATTERNS) {
      if (blocked.test(fullCommand)) {
        return { output: `Error: command contains a blocked pattern (${blocked.source})`, isError: true };
      }
    }

    const args = preparsedArgs ?? (argsString ? shellTokenize(argsString) : []);

    // un-escape `<` / `>` in `git commit` messages.
    // from a real Bandit commit: the
    // `Co-authored-by: Bandit <bandit@burtson.ai>` trailer was emitted
    // as `Co-authored-by: Bandit <bandit@burtson.ai>`. The
    // model JSON-escapes angle brackets defensively, but GitHub's
    // trailer parser needs literal `<...>` to resolve the email to
    // the bandit-stealth user record and render the avatar on the
    // commit. Scoped to `git commit` so legitimate `<` searches
    // in other commands (e.g. grep for that exact escape in source)
    // aren't touched. Applied to every arg since the message can be
    // in `-m <msg>` (two tokens) or `-m=<msg>` (one token).
    const isGitCommit =
      (cmd === 'git' || cmd.endsWith('/git')) && args[0] === 'commit';
    if (isGitCommit) {
      for (let i = 0; i < args.length; i++) {
        if (args[i].includes('\\u003c') || args[i].includes('\\u003e')) {
          args[i] = args[i].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>');
        }
      }
    }

    const cwd = params.cwd
      ? (isAbsolutePath(params.cwd) ? params.cwd : `${ctx.workspaceRoot}/${params.cwd}`)
      : ctx.workspaceRoot;

    try {
      const { stdout, stderr, exitCode } = await ctx.runCommand(cmd, args, cwd);
      const combined = [
        stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
        stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
        `exit code: ${exitCode}`
      ].filter(Boolean).join('\n\n');
      const output = truncate(combined, MAX_COMMAND_CHARS, 'run_command');
      return { output, isError: exitCode !== 0 };
    } catch (err) {
      return { output: `Error running command "${cmd}": ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
};

// ── watch_command ──────────────────────────────────────────────────────────────
//
// Run a long-lived process for a bounded window and return what came out.
// Useful for "start the dev server, watch for the error, decide what to fix"
// flows that run_command can't model — run_command expects the process to
// exit on its own and gives up at 30s. watch_command knows the process
// might run forever, captures output for a bounded window, and SIGTERMs it
// at the end so the agent can act on what came out.
//
// Same allow-list + blocked-pattern gating as run_command. Duration capped
// at 60 seconds — anything longer is a sign the agent should refactor the
// approach (e.g. write a separate test command that exits) rather than
// hold the loop hostage. Output capped at MAX_COMMAND_CHARS.

const WATCH_COMMAND_DEFAULT_SECONDS = 10;
const WATCH_COMMAND_MAX_SECONDS = 60;

const watchCommandTool: AgentTool = {
  name: 'watch_command',
  description: 'Run a long-lived shell command and capture its stdout/stderr for a bounded duration. Use this for processes that don\'t exit on their own — dev servers (`npm run dev`), --watch test runners, log tailers. The command is killed at the end of the window so the agent can react to what was emitted. For one-shot commands that exit on their own, prefer run_command. Allowed commands: same set as run_command.',
  parameters: [
    { name: 'cmd', description: 'The command to run (e.g. "npm", "node", "python")', required: true },
    { name: 'args', description: 'Space-separated arguments (e.g. "run dev", "test --watch")' },
    { name: 'cwd', description: 'Working directory relative to workspace root (optional)' },
    { name: 'duration_seconds', description: `How long to watch the process before killing it. Default ${WATCH_COMMAND_DEFAULT_SECONDS}s, max ${WATCH_COMMAND_MAX_SECONDS}s.` }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const rawCmd = params.cmd?.trim();
    if (!rawCmd) {return { output: 'Error: cmd parameter is required', isError: true };}

    // Mirror the run_command normalization — accept both
    // cmd="npm" args="run dev" AND cmd="npm run dev" args="" shapes.
    let cmd = rawCmd;
    let argsString = params.args ?? '';
    const preparsedArgs = maybeParseJsonArrayArgs(argsString);
    const firstSpace = rawCmd.search(/\s/);
    if (firstSpace > 0 && !preparsedArgs) {
      cmd = rawCmd.slice(0, firstSpace);
      const inlineArgs = rawCmd.slice(firstSpace + 1).trim();
      argsString = argsString ? `${inlineArgs} ${argsString}` : inlineArgs;
    }

    const baseCmd = cmd.split('/').pop() ?? cmd;
    if (!ALLOWED_COMMANDS.has(baseCmd)) {
      return { output: rejectionMessage(baseCmd), isError: true };
    }

    const fullCommand = preparsedArgs
      ? `${cmd} ${preparsedArgs.join(' ')}`.trim()
      : `${cmd} ${argsString}`.trim();
    for (const blocked of BLOCKED_PATTERNS) {
      if (blocked.test(fullCommand)) {
        return { output: `Error: command contains a blocked pattern (${blocked.source})`, isError: true };
      }
    }

    const args = preparsedArgs ?? (argsString ? shellTokenize(argsString) : []);
    const cwd = params.cwd
      ? (isAbsolutePath(params.cwd) ? params.cwd : `${ctx.workspaceRoot}/${params.cwd}`)
      : ctx.workspaceRoot;

    const requestedSeconds = parseInt(params.duration_seconds ?? '', 10);
    const durationSeconds = Number.isFinite(requestedSeconds) && requestedSeconds > 0
      ? Math.min(requestedSeconds, WATCH_COMMAND_MAX_SECONDS)
      : WATCH_COMMAND_DEFAULT_SECONDS;
    const durationMs = durationSeconds * 1000;

    try {
      // Hosts that don't implement watchCommand fall back to runCommand
      // with a note. runCommand has its own timeout (30s on the CLI),
      // so the agent still gets bounded-time output — just without the
      // "kill on schedule" semantics.
      if (!ctx.watchCommand) {
        const fallback = await ctx.runCommand(cmd, args, cwd);
        const combined = [
          fallback.stdout.trim() ? `stdout:\n${fallback.stdout.trim()}` : '',
          fallback.stderr.trim() ? `stderr:\n${fallback.stderr.trim()}` : '',
          `exit code: ${fallback.exitCode}`,
          `note: this host does not implement watch_command directly — fell back to run_command. Output reflects only what the process printed before it exited or the runCommand timeout fired.`
        ].filter(Boolean).join('\n\n');
        return { output: truncate(combined, MAX_COMMAND_CHARS, 'watch_command'), isError: fallback.exitCode !== 0 };
      }

      const result = await ctx.watchCommand(cmd, args, cwd, durationMs);
      const status = result.endedEarly
        ? `process exited on its own with code ${result.exitCode ?? 'unknown'} before the ${durationSeconds}s window`
        : `process was still running after ${durationSeconds}s — sent SIGTERM`;
      const combined = [
        `watched "${fullCommand}" for ${durationSeconds}s in ${cwd}`,
        result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : '',
        result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : '',
        status
      ].filter(Boolean).join('\n\n');
      const output = truncate(combined, MAX_COMMAND_CHARS, 'watch_command');
      // Only flag isError when the process exited early with a non-zero
      // code. Being killed by SIGTERM is the expected end state.
      const isError = result.endedEarly && typeof result.exitCode === 'number' && result.exitCode !== 0;
      return { output, isError };
    } catch (err) {
      return { output: `Error watching command "${cmd}": ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
};

/**
 * Returns a ToolRegistry pre-loaded with all core tools.
 * Pass the result to ToolUseLoop or use it standalone.
 * Git tools are registered separately via createGitToolRegistry() and
 * can be merged with registry.registerAll([...gitRegistry.getAll()]).
 */
export function createCoreToolRegistry(): ToolRegistry {
  return new ToolRegistry().registerAll([
    readFileTool,
    writeFileTool,
    deleteFileTool,
    applyEditTool,
    replaceRangeTool,
    applyPatchTool,
    listFilesTool,
    lsTool,
    findDirectoryTool,
    searchCodeTool,
    runCommandTool,
    watchCommandTool
  ]);
}

export {
  readFileTool,
  writeFileTool,
  deleteFileTool,
  applyEditTool,
  replaceRangeTool,
  applyPatchTool,
  listFilesTool,
  lsTool,
  findDirectoryTool,
  searchCodeTool,
  runCommandTool,
  watchCommandTool
};

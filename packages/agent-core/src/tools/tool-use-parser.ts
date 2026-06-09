/**
 * XML-based tool call parser for text-based tool use.
 *
 * Used with models that don't support native function calling
 * (gemma3, bandit-core, qwen2.5, and similar open models).
 *
 * Protocol:
 * Model emits: <tool_call>{"name": "read_file", "params": {"path": "src/x.ts"}}</tool_call>
 * Host injects: <tool_result name="read_file">\n...output...\n</tool_result>
 */

import { redactSecretsString } from '../security/secretPatterns';

export interface ParsedToolCall {
  name: string;
  params: Record<string, string>;
  /** Raw matched string, for replacement/debugging. */
  raw: string;
}

// Accepted formats:
// <tool_call>{"name":"foo","params":{...}}</tool_call> (canonical)
// ```tool_call\n{"name":"foo","params":{...}}\n``` (fenced, common)
//
// The previous non-greedy regex failed whenever a tool-call payload itself
// contained the string `</tool_call>` (e.g. when todo_write's items value was
// a string describing another tool call). We now use brace-matching so we
// walk the real JSON boundaries instead of pattern-guessing.

/**
 * Find the end index of a JSON object starting at `start` (which should
 * point at the `{`). Returns the index of the matching `}` or -1.
 * String-aware: brackets inside strings don't count. Handles escapes.
 */
function findJsonEnd(text: string, start: number): number {
  // Skip whitespace until the opening brace.
  while (start < text.length && /\s/.test(text[start])) {start++;}
  if (text[start] !== '{') {return -1;}
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') {inString = false;}
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') {depth++;}
    else if (c === '}') {
      depth--;
      if (depth === 0) {return i;}
    }
  }
  return -1;
}

/** Locate every `<tool_call>…</tool_call>` block using brace-balanced JSON. */
function findXmlBlocks(text: string): { raw: string; inner: string }[] {
  const out: { raw: string; inner: string }[] = [];
  const opener = '<tool_call>';
  const closer = '</tool_call>';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf(opener, i);
    if (open === -1) {break;}
    const jsonStart = open + opener.length;
    const end = findJsonEnd(text, jsonStart);
    if (end === -1) { i = jsonStart; continue; }
    // Require `</tool_call>` at (or near) the JSON end — tolerate whitespace.
    let closeIdx = end + 1;
    while (closeIdx < text.length && /\s/.test(text[closeIdx])) {closeIdx++;}
    if (text.slice(closeIdx, closeIdx + closer.length) !== closer) {
      i = end + 1; continue;
    }
    const inner = text.slice(jsonStart, end + 1);
    const raw = text.slice(open, closeIdx + closer.length);
    out.push({ raw, inner });
    i = closeIdx + closer.length;
  }
  return out;
}

/** Locate every fenced ```tool_call … ``` block using brace-balanced JSON. */
function findFenceBlocks(text: string): { raw: string; inner: string }[] {
  const out: { raw: string; inner: string }[] = [];
  const fenceStartRe = /```\s*tool_call\s*\n?/g;
  let m: RegExpExecArray | null;
  while ((m = fenceStartRe.exec(text)) !== null) {
    const jsonStart = m.index + m[0].length;
    const end = findJsonEnd(text, jsonStart);
    if (end === -1) {continue;}
    let closeIdx = end + 1;
    while (closeIdx < text.length && /\s/.test(text[closeIdx])) {closeIdx++;}
    if (text.slice(closeIdx, closeIdx + 3) !== '```') {continue;}
    out.push({ raw: text.slice(m.index, closeIdx + 3), inner: text.slice(jsonStart, end + 1) });
    fenceStartRe.lastIndex = closeIdx + 3;
  }
  return out;
}

/**
 * Extract all tool call blocks from a model response. Accepts both the
 * canonical <tool_call>…</tool_call> form and the markdown-fenced
 * ```tool_call …``` variant. Returns an empty array if none found.
 */
/**
 * Blank out fenced code blocks (```…``` / ~~~…~~~) so the WEAK tool-call
 * fallbacks (bare-JSON, pythonic) don't misread a code EXAMPLE the model is
 * demonstrating — e.g. a Python `print("…")` or a JSON snippet — as a tool
 * call. Real tool calls use `<tool_call>` or ```tool_call, both consumed
 * before the fallbacks run, so masking every other fence here is safe. The
 * canonical/XML finders still see the original text.
 */
function stripFencedCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '');
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  const seen = new Set<string>();

  const consume = (block: { raw: string; inner: string }): void => {
    if (seen.has(block.raw)) {return;}
    seen.add(block.raw);
    try {
      // Three things a model can do when emitting a tool_call, in order
      // of frequency we've actually observed in the wild:
      //
      // (1) Wrapped under `params` — the shape we document. Works.
      // (2) Wrapped under `arguments` — OpenAI / Anthropic convention.
      // Open-source instruct-tuned models (including bandit-core-1)
      // default to this because they were trained on thousands of
      // function-calling examples using this name.
      // (3) Wrapped under `parameters` — conflation of the schema word
      // with the call-site word.
      // (4) FLAT: {name, path, content, ...} with no wrapper at all.
      // Also common with instruct-tuned models — they skip the
      // wrapper entirely because the one-level structure is
      // simpler. bandit-core-1 hits this case on every
      // write_file call in the skills.create_markdown fixture.
      //
      // Before flat-key support, the parser returned an empty params
      // object for case (4) and the tool immediately errored with
      // "X parameter is required". The eval fixture caught it.
      const parsed = JSON.parse(block.inner) as {
        name?: string;
        params?: Record<string, unknown>;
        arguments?: Record<string, unknown>;
        parameters?: Record<string, unknown>;
        [key: string]: unknown;
      };
      if (typeof parsed.name !== 'string' || !parsed.name) {return;}

      let paramsLike: Record<string, unknown>;
      if (parsed.params && typeof parsed.params === 'object') {paramsLike = parsed.params;}
      else if (parsed.arguments && typeof parsed.arguments === 'object') {paramsLike = parsed.arguments;}
      else if (parsed.parameters && typeof parsed.parameters === 'object') {paramsLike = parsed.parameters;}
      else {
        // Flat-key fallback: treat every top-level field other than `name`
        // (and the already-tried wrapper keys, in case the model emitted
        // both a wrapper AND flat keys) as a tool parameter.
        const { name: _n, params: _p, arguments: _a, parameters: _pa, ...rest } = parsed;
        paramsLike = rest;
      }

      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(paramsLike)) {
        params[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      results.push({ name: parsed.name, params, raw: block.raw });
    } catch {
      // Malformed JSON — skip.
    }
  };

  for (const b of findXmlBlocks(text)) {consume(b);}
  for (const b of findFenceBlocks(text)) {consume(b);}
  // Bare-JSON fallback — with Qwen 2.5 Coder 32B via
  // Ollama: model emits `{"name":"foo","arguments":{...}}` as its entire
  // content field (Ollama's tag-based extractor only promotes tagged
  // blocks to tool_calls, so bare JSON passes through as prose and our
  // XML/fence finders miss it). Only fire when we haven't already
  // consumed something — bare-JSON is the weakest signal.
  // Weak fallbacks run against a fence-masked copy so a fenced code EXAMPLE
  // (```python\nprint("x")\n```, a ```json snippet, etc.) isn't mistaken for
  // a tool call. The canonical XML/```tool_call finders above used the raw text.
  const masked = stripFencedCode(text);
  if (results.length === 0) {
    for (const b of findBareJsonBlocks(masked)) {consume(b);}
  }
  // Pythonic fallback — Qwen sometimes emits `toolname(args)` / `toolname
  // path="x" content="y"` as prose. Less-structured still but recoverable
  // if we see a tool name on a line by itself. Only fires as a last resort,
  // and never inside a code fence (masked above) so a `print(...)` in a
  // Python example doesn't become a phantom `print` tool call.
  if (results.length === 0) {
    for (const b of findPythonicBlocks(masked)) {consume(b);}
  }
  return results;
}

/**
 * Find bare-JSON tool-call objects in text: `{"name":"X","arguments":{...}}`
 * with no wrapping tags. Must be a top-level JSON object that contains
 * at least a `name` string — we rely on `consume()` to validate the
 * full shape.
 */
function findBareJsonBlocks(text: string): { raw: string; inner: string }[] {
  const out: { raw: string; inner: string }[] = [];
  let i = 0;
  while (i < text.length) {
    const brace = text.indexOf('{', i);
    if (brace < 0) {break;}
    const end = findJsonEnd(text, brace);
    if (end < 0) { i = brace + 1; continue; }
    const inner = text.slice(brace, end + 1);
    // Cheap pre-check so we don't try JSON.parse on every `{}` in prose.
    if (/"name"\s*:\s*"/.test(inner) && /"(?:arguments|params|parameters)"\s*:/.test(inner)) {
      out.push({ raw: inner, inner });
    }
    i = end + 1;
  }
  return out;
}

/**
 * Find Python-function-call-style emissions: `toolname(args)` on a line
 * by itself OR `toolname key="value" key2="value2"` as bare prose.
 * Converts to a synthetic `{"name":..., "params":{...}}` block. Narrow
 * on purpose — we only match lines that START with an identifier and
 * are followed by either `(` or a key= pair.
 */
function findPythonicBlocks(text: string): { raw: string; inner: string }[] {
  const out: { raw: string; inner: string }[] = [];
  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {continue;}
    // `toolname(<json-ish>)` — e.g. `todo_write(["a","b"])` or `run_command({...})`.
    const fnMatch = /^([a-z_][a-z0-9_]*)\s*\(([\s\S]+)\)\s*$/i.exec(line);
    if (fnMatch) {
      const [, name, body] = fnMatch;
      // Try JSON-parse the body; if it parses as an array, attach as
      // the canonical `items` param (matches todo_write's API). Object
      // goes under `arguments`.
      try {
        const parsedBody = JSON.parse(body);
        const inner = Array.isArray(parsedBody)
          ? JSON.stringify({ name, params: { items: JSON.stringify(parsedBody) } })
          : JSON.stringify({ name, arguments: parsedBody });
        out.push({ raw: rawLine, inner });
        continue;
      } catch {
        // Not valid JSON body; fall through to key-value path.
      }
    }
    // `toolname key="value" key2="value with spaces"` — prose key=value pairs.
    const kvMatch = /^([a-z_][a-z0-9_]*)\s+((?:[a-z_][a-z0-9_]*=(?:"[^"]*"|\S+)\s*)+)$/i.exec(line);
    if (kvMatch) {
      const [, name, rest] = kvMatch;
      const params: Record<string, string> = {};
      const pairRe = /([a-z_][a-z0-9_]*)=(?:"([^"]*)"|(\S+))/gi;
      let match: RegExpExecArray | null;
      while ((match = pairRe.exec(rest)) !== null) {
        const [, key, quoted, bare] = match;
        params[key] = quoted ?? bare ?? '';
      }
      if (Object.keys(params).length > 0) {
        out.push({ raw: rawLine, inner: JSON.stringify({ name, params }) });
      }
    }
  }
  return out;
}

/** Returns true if the text contains at least one tool call (XML, fenced, bare JSON, or pythonic). */
export function hasToolCalls(text: string): boolean {
  if (findXmlBlocks(text).length > 0) {return true;}
  if (findFenceBlocks(text).length > 0) {return true;}
  // Only run the weaker fallbacks when the stronger ones missed — and against
  // fence-masked text so a code example isn't read as a tool call (mirrors
  // parseToolCalls so the two never disagree).
  const masked = stripFencedCode(text);
  if (findBareJsonBlocks(masked).length > 0) {return true;}
  if (findPythonicBlocks(masked).length > 0) {return true;}
  return false;
}

/**
 * Does the text LOOK like it's trying to be a tool call even if none parse?
 * Used to distinguish "model wrote prose" from "model tried a tool call but
 * botched the JSON escaping" (common failure mode with long content strings).
 */
export function looksLikeAttemptedToolCall(text: string): boolean {
  return /<tool_call\b|```\s*tool_call\b/i.test(text);
}

/**
 * True when the text contains a `<tool_result>` envelope the model
 * should never have emitted — those tags are our injection format for
 * feeding tool output BACK to the model in the next user message. When
 * a model emits one in its own response, it has hallucinated a result
 * (often after aggressive compaction strips its memory and it falls
 * back to imitating the format it saw earlier).  * after a 43k → 4.5k compaction, bandit-logic produced a final response
 * containing `<tool_result name="read_file">` with fabricated file
 * contents — the user-visible chat showed what looked like a real read.
 */
export function hasFabricatedToolResult(text: string): boolean {
  return /<tool_result\b/i.test(text);
}

/** Remove all tool_call AND tool_result markup from a string. tool_call
 * markup is malformed-block leakage; tool_result markup is hallucinated
 * (the model is fabricating tool output it never received). Both must
 * be scrubbed before the response reaches the user-visible final answer
 * so the chat doesn't show fake "I read this file" panels. */
export function stripToolCallMarkup(text: string): string {
  let out = text;
  // Drop well-formed XML blocks (covers <tool_call>...</tool_call>).
  for (const b of findXmlBlocks(text)) {out = out.replace(b.raw, '');}
  // Drop well-formed fenced blocks (```tool_call ... ```).
  for (const b of findFenceBlocks(text)) {out = out.replace(b.raw, '');}
  // Aggressively remove any leftover malformed tool_call markup. These
  // regexes fire ONLY if a structured block wasn't already removed —
  // after structured stripping, anything remaining is by definition not
  // a valid block, so we can clear markup tags without hurting prose.
  out = out.replace(/<\/?tool_call>/gi, '');
  out = out.replace(/```\s*tool_call\s*/gi, '```');
  // Hallucinated tool_result blocks. Match the well-formed envelope
  // first (greedy-but-bounded by the closing tag) — the typical pattern
  // is `<tool_result name="read_file">…fake content…</tool_result>`.
  // After that, drop any orphaned opening/closing tags that survived a
  // truncated or unterminated emission.
  out = out.replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/gi, '');
  out = out.replace(/<\/?tool_result\b[^>]*>/gi, '');
  return out;
}

/**
 * Format a tool result for injection back into the conversation.
 * The model sees this in the next user message.
 *
 * every output string is run through the secret redactor
 * before the model sees it. This is the canonical chokepoint: any
 * tool call (read_file, run_command, search_code, …) that ends up
 * piping output back to the model goes through this function, so
 * redacting here covers every path with a single edit. The redactor
 * preserves the variable name on env-style secrets (`GITHUB_TOKEN=`
 * stays, the value becomes `<REDACTED:env-secret>`) and replaces
 * full-token matches with `<REDACTED:{kind}>` placeholders that
 * still let the model reason about what KIND of thing was hidden.
 *
 * Opt-out: set BANDIT_NO_SECRET_REDACTION=1 in the host process env.
 * The slash command `/secrets off` flips this at runtime. Off-switch
 * exists for debugging the redactor itself; default-on is the right
 * behavior for everyday use.
 */
export function formatToolResult(name: string, output: string, isError?: boolean): string {
  const tag = isError ? `<tool_result name="${name}" status="error">` : `<tool_result name="${name}">`;
  const safeOutput = applySecretRedactionIfEnabled(output);
  return `${tag}\n${safeOutput}\n</tool_result>`;
}

/**
 * Build a user message that contains multiple tool results.
 * Used when the model made multiple tool calls in one response.
 */
export function buildToolResultsMessage(
  results: Array<{ name: string; output: string; isError?: boolean }>
): string {
  return results.map(r => formatToolResult(r.name, r.output, r.isError)).join('\n\n');
}

// ─── Secret redaction wiring ───────────────────────────────────────
// Hot path: formatToolResult fires for every tool result the model
// will see. The redactor is the single source of truth for "what
// looks like a secret" — see ../security/secretPatterns.ts.
//
// Opt-out: BANDIT_NO_SECRET_REDACTION=1 env. The slash command
// `/secrets off` flips this at runtime. Off-switch exists for
// debugging the redactor itself; default-on is the right behavior.
export function applySecretRedactionIfEnabled(text: string): string {
  if (/^(1|true)$/i.test(process.env.BANDIT_NO_SECRET_REDACTION ?? '')) {
    return text;
  }
  if (!text || text.length === 0) {return text;}
  return redactSecretsString(text);
}

/**
 * Strip all tool_call and tool_result markup (XML or fenced) from a string.
 * Useful when extracting the model's "thinking" text around tool calls.
 */
export function stripToolMarkup(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/```\s*tool_call\s*\n?[\s\S]*?\n?```/gi, '')
    .replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/gi, '')
    .trim();
}

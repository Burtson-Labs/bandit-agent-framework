/**
 * Lightweight, dependency-free terminal syntax highlighter for diff cards.
 *
 * Single-pass tokenizer, applied per LINE: line/block comments, strings,
 * numbers, keywords, types, constants, and function-call identifiers. It's
 * best-effort and stateless across lines — diffs show non-contiguous lines
 * (collapsed unchanged runs), so threading block-comment / multi-line-string
 * state between rows would mislead more than it helps. Multi-line block
 * comments and template literals are highlighted only within the single line
 * they appear on.
 *
 * Colors are FOREGROUND-only (VS Code Dark+ palette) so they layer cleanly
 * over the green/red diff band BACKGROUNDS. Each colored token restores to a
 * caller-supplied `baseFg`, so untoken'd text (identifiers, punctuation,
 * whitespace) keeps the band's add/remove tint. This module never probes the
 * TTY — diff.ts only calls `highlightCode` when the terminal advertises
 * 24-bit color (where the dark-tint bands render), so callers own the gating.
 */

const fg = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`;

// VS Code Dark+ inspired. Chosen to read on BOTH the dark-green add band
// (rgb 18,48,28) and the dark-red delete band (rgb 58,26,30).
const TOK = {
  keyword: fg(197, 134, 192), // #c586c0 purple — control + declaration keywords
  type: fg(78, 201, 176), //     #4ec9b0 teal   — primitive/builtin types
  string: fg(206, 145, 120), //  #ce9178 tan    — string + template literals
  number: fg(181, 206, 168), //  #b5cea8 green   — numeric literals
  comment: fg(106, 153, 85), //  #6a9955 green  — comments
  func: fg(220, 220, 170), //    #dcdcaa yellow — function-call identifiers
  constant: fg(86, 156, 214) //  #569cd6 blue   — true/false/null/this/self/…
};

export interface LangSpec {
  keywords: Set<string>;
  types?: Set<string>;
  constants?: Set<string>;
  lineComment?: string;
  blockComment?: [string, string];
  /** Single-character string delimiters, e.g. ['"', "'", '`']. */
  strings: string[];
  /** SQL et al. are case-insensitive — keyword sets are stored lowercase. */
  caseInsensitive?: boolean;
}

const s = (...words: string[]): Set<string> => new Set(words);

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';
const isIdentStart = (ch: string): boolean =>
  (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
const isIdentPart = (ch: string): boolean => isIdentStart(ch) || isDigit(ch);

function has(set: Set<string> | undefined, word: string, ci: boolean | undefined): boolean {
  if (!set) return false;
  return ci ? set.has(word.toLowerCase()) : set.has(word);
}

/**
 * Highlight a single line of `code` for the given language. `baseFg` is the
 * SGR sequence the caller wants restored after each colored token (the diff
 * band's add/remove tint). Returns the line with foreground color escapes
 * woven in; the caller still owns the surrounding background + final reset.
 */
export function highlightCode(code: string, lang: LangSpec, baseFg: string): string {
  let out = '';
  const n = code.length;
  let i = 0;
  const ci = lang.caseInsensitive;
  const emit = (color: string, text: string): void => {
    out += color + text + baseFg;
  };

  while (i < n) {
    const ch = code[i];

    // Line comment — colors the rest of the line and stops.
    if (lang.lineComment && code.startsWith(lang.lineComment, i)) {
      emit(TOK.comment, code.slice(i));
      break;
    }

    // Block comment — single-line best-effort (runs to the close or EOL).
    if (lang.blockComment && code.startsWith(lang.blockComment[0], i)) {
      const [open, close] = lang.blockComment;
      const end = code.indexOf(close, i + open.length);
      const stop = end === -1 ? n : end + close.length;
      emit(TOK.comment, code.slice(i, stop));
      i = stop;
      continue;
    }

    // String / template literal — walks to the matching delimiter, honoring
    // backslash escapes. Unterminated (the closing quote on a later line)
    // runs to EOL.
    if (lang.strings.includes(ch)) {
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === ch) {
          j++;
          break;
        }
        j++;
      }
      emit(TOK.string, code.slice(i, j));
      i = j;
      continue;
    }

    // Number — decimal, hex/oct/bin, floats, separators.
    if (isDigit(ch) || (ch === '.' && isDigit(code[i + 1]))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObB._]/.test(code[j])) j++;
      emit(TOK.number, code.slice(i, j));
      i = j;
      continue;
    }

    // Identifier — keyword / type / constant lookup, else function-call
    // detection (word immediately followed by `(`), else plain.
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(code[j])) j++;
      const word = code.slice(i, j);
      if (has(lang.constants, word, ci)) emit(TOK.constant, word);
      else if (has(lang.keywords, word, ci)) emit(TOK.keyword, word);
      else if (has(lang.types, word, ci)) emit(TOK.type, word);
      else {
        let k = j;
        while (k < n && code[k] === ' ') k++;
        if (code[k] === '(') emit(TOK.func, word);
        else out += word;
      }
      i = j;
      continue;
    }

    // Operators, punctuation, whitespace — keep the band's base color.
    out += ch;
    i++;
  }

  return out;
}

// ── Language specs ────────────────────────────────────────────────────────
// Keyword sets are deliberately pragmatic, not grammar-complete: enough to
// make a diff read like an IDE, not a full parser. Add languages as needed.

const JS_TS: LangSpec = {
  keywords: s(
    'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
    'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof',
    'interface', 'is', 'keyof', 'let', 'namespace', 'new', 'of', 'override', 'private',
    'protected', 'public', 'readonly', 'return', 'satisfies', 'set', 'static', 'switch', 'throw',
    'try', 'type', 'typeof', 'var', 'while', 'with', 'yield'
  ),
  types: s('string', 'number', 'boolean', 'any', 'unknown', 'never', 'object', 'symbol', 'bigint', 'void'),
  constants: s('true', 'false', 'null', 'undefined', 'this', 'super', 'NaN', 'Infinity'),
  lineComment: '//',
  blockComment: ['/*', '*/'],
  strings: ['"', "'", '`']
};

const PYTHON: LangSpec = {
  keywords: s(
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
    'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
    'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case'
  ),
  types: s('int', 'float', 'str', 'bool', 'bytes', 'list', 'dict', 'set', 'tuple'),
  constants: s('True', 'False', 'None', 'self', 'cls', 'Ellipsis', 'NotImplemented'),
  lineComment: '#',
  strings: ['"', "'"]
};

const CSHARP: LangSpec = {
  keywords: s(
    'abstract', 'as', 'async', 'await', 'base', 'break', 'case', 'catch', 'class', 'const',
    'continue', 'default', 'delegate', 'do', 'else', 'enum', 'event', 'explicit', 'extern',
    'finally', 'for', 'foreach', 'get', 'goto', 'if', 'implicit', 'in', 'interface', 'internal',
    'is', 'lock', 'namespace', 'new', 'operator', 'out', 'override', 'params', 'partial',
    'private', 'protected', 'public', 'readonly', 'record', 'ref', 'return', 'sealed', 'set',
    'sizeof', 'static', 'struct', 'switch', 'this', 'throw', 'try', 'typeof', 'using', 'var',
    'virtual', 'void', 'volatile', 'where', 'while', 'yield'
  ),
  types: s(
    'bool', 'byte', 'char', 'decimal', 'double', 'float', 'int', 'long', 'object', 'sbyte',
    'short', 'string', 'uint', 'ulong', 'ushort', 'Task', 'Dictionary', 'List'
  ),
  constants: s('true', 'false', 'null'),
  lineComment: '//',
  blockComment: ['/*', '*/'],
  strings: ['"', "'"]
};

const GO: LangSpec = {
  keywords: s(
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough',
    'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return',
    'select', 'struct', 'switch', 'type', 'var'
  ),
  types: s(
    'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int', 'int8',
    'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64',
    'uintptr', 'any'
  ),
  constants: s('true', 'false', 'nil', 'iota'),
  lineComment: '//',
  blockComment: ['/*', '*/'],
  strings: ['"', '`']
};

const RUST: LangSpec = {
  keywords: s(
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern',
    'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref',
    'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'type', 'unsafe', 'use',
    'where', 'while'
  ),
  types: s(
    'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
    'f32', 'f64', 'bool', 'char', 'str', 'String', 'Vec', 'Option', 'Result', 'Box'
  ),
  constants: s('true', 'false', 'None', 'Some', 'Ok', 'Err'),
  lineComment: '//',
  blockComment: ['/*', '*/'],
  strings: ['"']
};

const JAVA: LangSpec = {
  keywords: s(
    'abstract', 'assert', 'break', 'case', 'catch', 'class', 'continue', 'default', 'do', 'else',
    'enum', 'extends', 'final', 'finally', 'for', 'if', 'implements', 'import', 'instanceof',
    'interface', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'static',
    'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try',
    'volatile', 'while', 'var', 'record', 'sealed', 'yield'
  ),
  types: s('boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short', 'void', 'String'),
  constants: s('true', 'false', 'null'),
  lineComment: '//',
  blockComment: ['/*', '*/'],
  strings: ['"', "'"]
};

const CFAMILY: LangSpec = {
  keywords: s(
    'auto', 'break', 'case', 'class', 'const', 'constexpr', 'continue', 'default', 'delete', 'do',
    'else', 'enum', 'explicit', 'extern', 'for', 'friend', 'goto', 'if', 'inline', 'namespace',
    'new', 'operator', 'override', 'private', 'protected', 'public', 'register', 'return',
    'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'try', 'typedef',
    'typename', 'union', 'using', 'virtual', 'volatile', 'while'
  ),
  types: s(
    'bool', 'char', 'double', 'float', 'int', 'long', 'short', 'signed', 'size_t', 'unsigned',
    'void', 'wchar_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint32_t', 'uint64_t'
  ),
  constants: s('true', 'false', 'nullptr', 'NULL'),
  lineComment: '//',
  blockComment: ['/*', '*/'],
  strings: ['"', "'"]
};

const RUBY: LangSpec = {
  keywords: s(
    'alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'do', 'else', 'elsif', 'end',
    'ensure', 'for', 'if', 'in', 'module', 'next', 'not', 'or', 'redo', 'rescue', 'retry',
    'return', 'then', 'unless', 'until', 'when', 'while', 'yield', 'require', 'require_relative',
    'include', 'extend', 'attr_accessor', 'attr_reader', 'attr_writer', 'lambda', 'proc'
  ),
  constants: s('true', 'false', 'nil', 'self', '__FILE__', '__LINE__'),
  lineComment: '#',
  strings: ['"', "'"]
};

const SHELL: LangSpec = {
  keywords: s(
    'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
    'function', 'in', 'select', 'return', 'export', 'local', 'readonly', 'declare', 'source',
    'set', 'unset', 'alias', 'trap'
  ),
  constants: s('true', 'false'),
  lineComment: '#',
  strings: ['"', "'"]
};

const JSON_SPEC: LangSpec = {
  keywords: s(),
  constants: s('true', 'false', 'null'),
  lineComment: '//', // jsonc / json5 tolerate comments; plain JSON simply won't contain them
  strings: ['"']
};

const YAML: LangSpec = {
  keywords: s(),
  constants: s('true', 'false', 'null', 'yes', 'no', 'on', 'off', 'True', 'False', 'Null'),
  lineComment: '#',
  strings: ['"', "'"]
};

const CSS: LangSpec = {
  keywords: s('important', 'media', 'import', 'include', 'mixin', 'if', 'else', 'for', 'each', 'function'),
  constants: s(),
  lineComment: '//', // SCSS/LESS; plain CSS has none
  blockComment: ['/*', '*/'],
  strings: ['"', "'"]
};

const SQL: LangSpec = {
  keywords: s(
    'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create',
    'alter', 'drop', 'table', 'view', 'index', 'join', 'inner', 'left', 'right', 'outer', 'full',
    'on', 'group', 'by', 'order', 'having', 'limit', 'offset', 'union', 'all', 'distinct', 'as',
    'and', 'or', 'not', 'in', 'is', 'between', 'like', 'exists', 'case', 'when', 'then', 'else',
    'end', 'primary', 'key', 'foreign', 'references', 'default', 'constraint', 'unique', 'with'
  ),
  types: s('int', 'integer', 'varchar', 'text', 'boolean', 'bool', 'date', 'timestamp', 'decimal', 'numeric', 'float', 'serial', 'uuid', 'json', 'jsonb'),
  constants: s('null', 'true', 'false'),
  lineComment: '--',
  blockComment: ['/*', '*/'],
  strings: ["'", '"'],
  caseInsensitive: true
};

const BY_EXT: Record<string, LangSpec> = {
  ts: JS_TS, tsx: JS_TS, mts: JS_TS, cts: JS_TS,
  js: JS_TS, jsx: JS_TS, mjs: JS_TS, cjs: JS_TS,
  py: PYTHON, pyi: PYTHON,
  cs: CSHARP,
  go: GO,
  rs: RUST,
  java: JAVA,
  c: CFAMILY, h: CFAMILY, cpp: CFAMILY, cxx: CFAMILY, cc: CFAMILY, hpp: CFAMILY, hxx: CFAMILY, hh: CFAMILY,
  rb: RUBY,
  sh: SHELL, bash: SHELL, zsh: SHELL,
  json: JSON_SPEC, jsonc: JSON_SPEC, json5: JSON_SPEC,
  yml: YAML, yaml: YAML,
  css: CSS, scss: CSS, less: CSS,
  sql: SQL
};

/** Resolve a language spec from a file path's extension, or null if unknown. */
export function detectLang(relPath: string): LangSpec | null {
  const dot = relPath.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = relPath.slice(dot + 1).toLowerCase();
  return BY_EXT[ext] ?? null;
}

// Markdown code-fence info strings use language NAMES (```csharp, ```ts,
// ```bash) rather than file extensions. Map the common spoken aliases onto
// the extension keys above.
const NAME_ALIASES: Record<string, string> = {
  'c#': 'cs', csharp: 'cs', cs: 'cs', dotnet: 'cs',
  ts: 'ts', typescript: 'ts', tsx: 'tsx',
  js: 'js', javascript: 'js', jsx: 'jsx', node: 'js', mjs: 'mjs', cjs: 'cjs',
  py: 'py', python: 'py', python3: 'py',
  go: 'go', golang: 'go',
  rs: 'rs', rust: 'rs',
  java: 'java',
  c: 'c', 'c++': 'cpp', cpp: 'cpp', cxx: 'cpp', cc: 'cc', h: 'h', hpp: 'hpp',
  rb: 'rb', ruby: 'rb',
  sh: 'sh', bash: 'sh', shell: 'sh', shellscript: 'sh', zsh: 'zsh', console: 'sh',
  json: 'json', jsonc: 'jsonc', json5: 'json5',
  yml: 'yml', yaml: 'yaml',
  css: 'css', scss: 'scss', less: 'less',
  sql: 'sql'
};

/** Resolve a language spec from a markdown fence info string or a filename —
 *  accepts spoken names ("csharp", "bash"), bare extensions ("ts"), or a path
 *  ("src/foo.ts"). Returns null when the language is unknown or unspecified. */
export function resolveLang(hint: string): LangSpec | null {
  const h = hint.trim().toLowerCase();
  if (!h) return null;
  if (h.includes('.')) {
    const byPath = detectLang(h);
    if (byPath) return byPath;
  }
  const ext = NAME_ALIASES[h] ?? h;
  return BY_EXT[ext] ?? null;
}

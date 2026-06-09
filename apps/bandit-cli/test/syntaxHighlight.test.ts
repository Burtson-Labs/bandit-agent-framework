import { describe, it, expect } from 'vitest';
import { detectLang, highlightCode, resolveLang } from '../src/syntaxHighlight';

// A readable sentinel stands in for the diff band's "restore base color"
// sequence so assertions can show where each token resets.
const R = '<reset>';

const KW = '\x1b[38;2;197;134;192m'; // keyword (purple)
const TYPE = '\x1b[38;2;78;201;176m'; // type (teal)
const STR = '\x1b[38;2;206;145;120m'; // string (tan)
const NUM = '\x1b[38;2;181;206;168m'; // number (green)
const COM = '\x1b[38;2;106;153;85m'; // comment (green)
const FN = '\x1b[38;2;220;220;170m'; // function (yellow)
const CONST = '\x1b[38;2;86;156;214m'; // constant (blue)

function ts() {
  const lang = detectLang('x.ts');
  if (!lang) throw new Error('expected a TS lang spec');
  return lang;
}

describe('detectLang', () => {
  it('resolves common extensions', () => {
    expect(detectLang('src/a.ts')).not.toBeNull();
    expect(detectLang('a.py')).not.toBeNull();
    expect(detectLang('Main.cs')).not.toBeNull();
    expect(detectLang('q.SQL')).not.toBeNull(); // case-insensitive extension match
  });

  it('returns null for unknown or extensionless paths', () => {
    expect(detectLang('Makefile')).toBeNull();
    expect(detectLang('a.unknownext')).toBeNull();
  });
});

describe('resolveLang (markdown fence info strings)', () => {
  it('resolves spoken language names and aliases', () => {
    expect(resolveLang('csharp')).not.toBeNull();
    expect(resolveLang('c#')).not.toBeNull();
    expect(resolveLang('typescript')).not.toBeNull();
    expect(resolveLang('bash')).not.toBeNull();
    expect(resolveLang('python')).not.toBeNull();
  });

  it('also accepts bare extensions and filenames', () => {
    expect(resolveLang('ts')).not.toBeNull();
    expect(resolveLang('src/foo.go')).not.toBeNull();
  });

  it('returns null for empty or unknown fence info', () => {
    expect(resolveLang('')).toBeNull();
    expect(resolveLang('brainfuck')).toBeNull();
  });
});

describe('highlightCode', () => {
  it('colors keywords and restores the base color after each token', () => {
    const out = highlightCode('const x = 1', ts(), R);
    expect(out).toContain(`${KW}const${R}`);
    expect(out).toContain(`${NUM}1${R}`);
  });

  it('colors string and template literals whole', () => {
    expect(highlightCode('const s = "hi there"', ts(), R)).toContain(`${STR}"hi there"${R}`);
    expect(highlightCode('const s = `tpl ${x}`', ts(), R)).toContain(`${STR}\`tpl \${x}\`${R}`);
  });

  it('colors a line comment through to end of line', () => {
    const out = highlightCode('x = 1 // trailing note', ts(), R);
    expect(out).toContain(`${COM}// trailing note${R}`);
  });

  it('colors a single-line block comment', () => {
    const out = highlightCode('a /* note */ b', ts(), R);
    expect(out).toContain(`${COM}/* note */${R}`);
  });

  it('colors function-call identifiers but leaves plain identifiers alone', () => {
    const out = highlightCode('foo(myVar)', ts(), R);
    expect(out).toContain(`${FN}foo${R}`);
    expect(out).toContain('myVar'); // no color escape woven around a bare identifier
    expect(out).not.toContain(`${FN}myVar`);
  });

  it('colors built-in constants and types distinctly from keywords', () => {
    const out = highlightCode('const ok: boolean = true', ts(), R);
    expect(out).toContain(`${TYPE}boolean${R}`);
    expect(out).toContain(`${CONST}true${R}`);
  });

  it('highlights keywords across the common languages', () => {
    const cases: Array<[string, string, string]> = [
      ['Main.cs', 'public class Foo', 'class'],
      ['app.py', 'def main():', 'def'],
      ['main.go', 'func main() {', 'func'],
      ['lib.rs', 'fn run() {', 'fn'],
      ['A.java', 'public class A {', 'class'],
      ['m.c', 'return 0;', 'return'],
      ['s.rb', 'def go; end', 'def'],
      ['run.sh', 'if true; then', 'if']
    ];
    for (const [path, code, kw] of cases) {
      const lang = detectLang(path);
      if (!lang) throw new Error(`no lang spec for ${path}`);
      expect(highlightCode(code, lang, R)).toContain(`${KW}${kw}${R}`);
    }
  });

  it('treats SQL keywords case-insensitively', () => {
    const sql = detectLang('q.sql');
    if (!sql) throw new Error('expected a SQL lang spec');
    const out = highlightCode('SELECT * FROM users', sql, R);
    expect(out).toContain(`${KW}SELECT${R}`);
    expect(out).toContain(`${KW}FROM${R}`);
  });

  it('leaves a line with no tokens of interest untouched', () => {
    expect(highlightCode('  })', ts(), R)).toBe('  })');
  });
});

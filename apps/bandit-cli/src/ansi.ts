/**
 * Minimal, dependency-free ANSI helpers. Colors are automatically disabled when
 * stdout is not a TTY or NO_COLOR / BANDIT_NO_COLOR is set.
 */

const supportsColor = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.BANDIT_NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
})();

function wrap(open: number, close: number) {
  return (s: string): string => (supportsColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

// Theme registry. Each theme remaps the SGR codes that c.accent / c.green
// / c.red etc. emit, so a single setActiveTheme(name) call recolors the
// entire CLI without touching call sites. Codes are standard ANSI:
//   30-37  basic foreground (black, red, green, yellow, blue, magenta, cyan, white)
//   90-97  bright foreground (same order)
// Picking from these two ranges keeps everything 8/16-color-safe — the
// "ANSI-only" theme literally is the same palette but mapped to non-bright
// codes for terminals that don't render bright variants distinctly.
//
// Colorblind variants swap red/green semantics for blue/yellow because
// red-green is the most common form (deuteranopia/protanopia) and that
// pair is exactly what success/failure status uses everywhere.
export interface ThemePalette {
  accent: number;
  green: number;
  red: number;
  yellow: number;
  blue: number;
  magenta: number;
  cyan: number;
}
const THEMES: Record<string, ThemePalette> = {
  // Default — sky-cyan accent on a dark terminal. Bright variants for pop.
  'dark': { accent: 96, green: 32, red: 31, yellow: 33, blue: 34, magenta: 35, cyan: 36 },
  // Light terminals — drop the brights so text isn't washed out on white.
  'light': { accent: 36, green: 32, red: 31, yellow: 33, blue: 34, magenta: 35, cyan: 36 },
  // Dark colorblind-friendly — swap red/green for blue/yellow on status.
  // accent stays cyan (high contrast on dark + colorblind-safe).
  'dark-cb': { accent: 96, green: 33, red: 94, yellow: 33, blue: 94, magenta: 35, cyan: 36 },
  // Light colorblind — same swap, dimmed for white backgrounds.
  'light-cb': { accent: 34, green: 33, red: 34, yellow: 33, blue: 34, magenta: 35, cyan: 36 },
  // ANSI-only — no bright codes; safe for older SSH / CI logs / screenreaders.
  'dark-ansi': { accent: 36, green: 32, red: 31, yellow: 33, blue: 34, magenta: 35, cyan: 36 },
  'light-ansi': { accent: 34, green: 32, red: 31, yellow: 33, blue: 34, magenta: 35, cyan: 36 }
};
export const THEME_NAMES = Object.keys(THEMES) as Array<keyof typeof THEMES>;
let active: ThemePalette = THEMES['dark'];
export function setActiveTheme(name: string): void {
  if (name in THEMES) active = THEMES[name];
}

// OSC-8 hyperlink support — the `\x1b]8;;<URL>\x1b\\<text>\x1b]8;;\x1b\\`
// escape sequence makes a span clickable in terminals that support it
// (iTerm2, Terminal.app 10.15+, kitty, alacritty, WezTerm, gnome-terminal,
// VS Code integrated terminal, Windows Terminal). Terminals that don't
// support it just ignore the escape and display the visible text — no
// breakage. Suppressed under NO_COLOR / BANDIT_NO_COLOR / non-TTY for
// the same reason colors are: machine-readable output should be plain.
//
// Use: `c.link('docs', 'https://burtson.ai')` renders `docs` as a
// clickable label. For bare URLs (no separate label), pass the URL as
// both arguments: `c.link('https://github.com/foo/pr/1', 'https://...')`.
function osc8(label: string, url: string): string {
  if (!supportsColor) {
    // Terminals (and pipe-to-file consumers) that don't get the OSC-8
    // wrapper still need the URL to be visible. When label === url
    // (the bare-URL idiom from linkify / applyInlineMarkdown), the
    // label already IS the URL — emitting once is enough. Otherwise
    // surface the URL inline as `label (url)` so a `[docs](https://x)`
    // markdown link doesn't lose its href in NO_COLOR output.
    return label === url ? label : `${label} (${url})`;
  }
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}

/**
 * Auto-linkify bare URLs in a string. Wraps each `http(s)://…` span in
 * OSC-8 + cyan-underline so it's clickable in supported terminals.
 * Use for framework-emitted text that contains URLs (slash command
 * output, help banners, error messages) — anything that DOESN'T pass
 * through the streaming markdown renderer (which already linkifies on
 * its own).
 *
 * Skips URLs that already carry an OSC-8 wrapper so calling this on
 * already-linkified text is idempotent. Trailing punctuation
 * (`.,;:!?)]`) is left outside the link span so a sentence-ending
 * period after a URL doesn't get clobbered.
 */
export function linkify(text: string): string {
  if (!supportsColor) return text;
  return text.replace(
    /(?<!\x1b\]8;;)(https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`).,;:!?\]])/g,
    (url) => osc8(`\x1b[4m\x1b[${active.cyan}m${url}\x1b[39m\x1b[24m`, url)
  );
}

export const c = {
  reset: (s: string) => (supportsColor ? `\x1b[0m${s}` : s),
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),

  // Theme-driven colors — re-read `active` on every call so a runtime
  // theme switch via setActiveTheme(...) takes effect immediately.
  red: (s: string) => (supportsColor ? `\x1b[${active.red}m${s}\x1b[39m` : s),
  green: (s: string) => (supportsColor ? `\x1b[${active.green}m${s}\x1b[39m` : s),
  yellow: (s: string) => (supportsColor ? `\x1b[${active.yellow}m${s}\x1b[39m` : s),
  blue: (s: string) => (supportsColor ? `\x1b[${active.blue}m${s}\x1b[39m` : s),
  magenta: (s: string) => (supportsColor ? `\x1b[${active.magenta}m${s}\x1b[39m` : s),
  cyan: (s: string) => (supportsColor ? `\x1b[${active.cyan}m${s}\x1b[39m` : s),
  gray: wrap(90, 39),
  white: wrap(97, 39),

  bgRed: wrap(41, 49),
  bgGreen: wrap(42, 49),

  /** Bandit accent — theme-driven, defaults to bright cyan on dark. */
  accent: (s: string) => (supportsColor ? `\x1b[${active.accent}m${s}\x1b[39m` : s),

  /** Wrap text with OSC-8 hyperlink escape sequences so the label is
   *  clickable in supported terminals. Falls back to plain text when
   *  colors are disabled. Pair with c.cyan / c.underline for the
   *  visual affordance — most terminals don't underline OSC-8 links
   *  automatically, so callers should style the label themselves. */
  link: (label: string, url: string): string => osc8(label, url)
};

/** Glyph set that falls back to ASCII when forced. */
export const glyph = {
  bullet: '●',
  arrow: '→',
  check: '✓',
  cross: '✗',
  info: 'ℹ',
  warn: '⚠',
  spark: '✦',
  prompt: '›',
  divider: '─'
};

/** Print a horizontal divider the width of the terminal (or 60 cols fallback). */
export function divider(char = glyph.divider): string {
  const width = Math.min(process.stdout.columns || 60, 80);
  return c.dim(char.repeat(width));
}

/** Box-drawn header. Top line + title + bottom line, accent-colored. */
export function banner(title: string, subtitle?: string): string {
  const lines: string[] = [];
  lines.push(c.accent('╭── ' + c.bold(title) + ' ' + c.dim('─'.repeat(Math.max(1, 40 - title.length)))));
  if (subtitle) {
    lines.push(c.accent('│  ') + c.dim(subtitle));
  }
  lines.push(c.accent('╰' + c.dim('─'.repeat(44))));
  return lines.join('\n');
}

/**
 * Launch banner — truecolor block-art of the Bandit Stealth logo on the
 * left with a stack of product text on the right. Shown once at REPL
 * start. Degrades to an ASCII variant when NO_COLOR is set or the
 * terminal doesn't advertise truecolor.
 *
 * The block-art is pre-rendered at build time from apps/bandit-stealth/
 * media/bandit-stealth.png by scripts/gen-logo.mjs — imported as a JSON
 * string constant so the CLI ships with zero image-rendering dep.
 * Regenerate via `node scripts/gen-logo.mjs` after editing the PNG.
 */
import logoData from './logo.json';

/**
 * Capable-TTY check: is this a real terminal we should send color + block
 * art to at all? Trusts the environment (doesn't gate on COLORTERM, which
 * VS Code / tmux / SSH routinely omit) — opts out only for NO_COLOR, dumb/
 * linux TERM, and non-TTY. This is what the LAUNCH BANNER uses: the
 * truecolor block-art ninja renders fine even where 24-bit isn't supported
 * (the unsupported escapes degrade to default-color blocks — a gray ninja —
 * without bleeding, because the block-art resets cleanly per pixel).
 */
export function supportsBlockArt(): boolean {
  if (process.env.NO_COLOR && process.env.NO_COLOR !== '0') return false;
  const t = (process.env.TERM ?? '').toLowerCase();
  if (t === 'dumb' || t === 'linux') return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

export function supportsTrueColor(): boolean {
  if (!supportsBlockArt()) return false;
  // macOS Terminal.app does NOT support 24-bit truecolor — it parses
  // `\x1b[38;2;R;G;Bm` as a SEQUENCE of separate SGR codes. That's mostly
  // harmless for the STATIC block-art banner (it resets per pixel), but
  // the ANIMATED spinner glow's R component sweeps through 43–47 (which
  // are BACKGROUND color codes, e.g. 45 = magenta bg) and its fg-only
  // `\x1b[39m` reset leaves that stray background to bleed across the
  // whole turn — the distracting magenta shimmer. So gate the truecolor
  // GLOW + diff bands (this fn) off for Apple Terminal while the banner
  // (supportsBlockArt) still shows the ninja. iTerm2 (iTerm.app) and VS
  // Code (vscode) advertise real truecolor and keep it.
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') return false;
  return true;
}

export function launchBanner(version: string): string {
  // Block-art ninja whenever it's a capable TTY — including Apple Terminal,
  // where the static block-art degrades to a clean gray ninja (no bleed).
  // Only NO_COLOR / dumb / non-TTY fall back to the ASCII wordmark.
  return supportsBlockArt() ? launchBannerBlockArt(version) : launchBannerAscii(version);
}

/**
 * Truecolor variant: block-art logo on the left, product text block on
 * the right. The text block vertically centers against the 12-line logo
 * so the version + tagline sit at the logo's midline.
 */
/** Map a 24-bit RGB triple to the nearest xterm-256 palette index
 *  (grayscale ramp for neutrals, the 6×6×6 color cube otherwise). */
function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const idx = (v: number): number => Math.round((v / 255) * 5);
  return 16 + 36 * idx(r) + 6 * idx(g) + idx(b);
}

/** Rewrite truecolor SGR escapes (`38;2;r;g;b` / `48;2;…`) to their
 *  nearest 256-color equivalent (`38;5;n` / `48;5;n`). Used for the launch
 *  banner on terminals that render block art + 256 colors but NOT 24-bit
 *  (macOS Terminal.app) — so the ninja keeps its blue gradient instead of
 *  degrading to gray. */
export function downsampleTruecolorTo256(s: string): string {
  return s
    .replace(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g, (_m, r, g, b) => `\x1b[38;5;${rgbTo256(+r, +g, +b)}m`)
    .replace(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g, (_m, r, g, b) => `\x1b[48;5;${rgbTo256(+r, +g, +b)}m`);
}

function launchBannerBlockArt(version: string): string {
  // Truecolor terminals get the logo as-is; 256-color-only terminals
  // (Apple Terminal) get a downsampled-but-still-blue gradient.
  const logoArt = supportsTrueColor() ? logoData.blockArt : downsampleTruecolorTo256(logoData.blockArt);
  const logo = logoArt.split('\n');
  const textLines = buildTextBlock(version);

  // Vertically center the text block against the logo. The text block
  // is shorter than the logo so we pad the top/bottom with blanks.
  const verticalPad = Math.max(0, Math.floor((logo.length - textLines.length) / 2));
  const paddedText: string[] = [
    ...Array(verticalPad).fill(''),
    ...textLines,
    ...Array(Math.max(0, logo.length - textLines.length - verticalPad)).fill('')
  ];

  const combined = logo.map((logoLine, i) => {
    const text = paddedText[i] ?? '';
    return `${logoLine}   ${text}`;
  });

  return combined.join('\n');
}

/**
 * Text block for the right side of the banner. Kept simple so it works
 * both in block-art and ASCII fallback without restructuring.
 */
function buildTextBlock(version: string): string[] {
  return [
    c.bold('Bandit') + c.dim('  v' + version),
    '',
    c.dim('local-first coding agent'),
    c.dim('built by ') + c.accent('Burtson Labs')
  ];
}

/**
 * ASCII fallback — the original BANDIT wordmark with a compact test
 * tube motif. Used when truecolor isn't available (NO_COLOR, dumb
 * terminals, basic SSH clients). Intentionally styled-down: no color
 * beyond the accent tone on the wordmark so it renders correctly on
 * monochrome displays.
 */
function launchBannerAscii(version: string): string {
  const tube: string[] = [
    '╺┳━━┳╸',
    ' ┃◉ ┃ ',
    ' ┃ ◉┃ ',
    ' ┃◉ ┃ ',
    ' ┃ ◉┃ ',
    ' ╰──╯ '
  ];

  const wordmark: string[] = [
    '██████╗  █████╗ ███╗   ██╗██████╗ ██╗████████╗',
    '██╔══██╗██╔══██╗████╗  ██║██╔══██╗██║╚══██╔══╝',
    '██████╔╝███████║██╔██╗ ██║██║  ██║██║   ██║   ',
    '██╔══██╗██╔══██║██║╚██╗██║██║  ██║██║   ██║   ',
    '██████╔╝██║  ██║██║ ╚████║██████╔╝██║   ██║   ',
    '╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚═╝   ╚═╝   '
  ];

  const lines = tube.map((t, i) => c.accent(t) + ' ' + c.accent(wordmark[i] ?? ''));
  const footer = [
    '  ' + c.bold('v' + version) + '   ' + c.dim('local-first coding agent'),
    '         ' + c.dim('built by ') + c.accent('Burtson Labs')
  ];

  return [...lines, '', ...footer].join('\n');
}

/** Render a lightweight status line (dim gray). */
export function status(text: string): string {
  return c.dim(`${glyph.bullet} ${text}`);
}

/** Render a tool-execution line with a skill accent when provided. */
export function toolLine(toolName: string, primary?: string): string {
  const friendly: Record<string, string> = {
    read_file: 'read',
    write_file: 'write',
    apply_edit: 'edit',
    replace_range: 'range edit',
    apply_patch: 'patch',
    search_code: 'search',
    list_files: 'list',
    run_command: 'shell',
    watch_command: 'watch',
    test_run: 'test',
    run_tests: 'test',
    git_status: 'git status',
    git_diff: 'git diff',
    git_log: 'git log',
    git_commit: 'git commit',
    task: 'subagent',
    web_fetch: 'web fetch',
    web_search: 'web search',
    remember: 'remember'
  };
  const label = friendly[toolName] ?? toolName;
  const name = c.cyan(label) + (label === toolName ? '' : c.dim(` (${toolName})`));
  const arg = primary ? c.dim(' ' + primary) : '';
  return `  ${c.gray(glyph.arrow)} ${name}${arg}`;
}

/** Render a skill-activation marker. */
export function skillLine(skillName: string): string {
  return c.magenta(`${glyph.spark} using skill: ${c.bold(skillName)}`);
}

/** Render an error line. */
export function errorLine(toolName: string, message: string): string {
  return `  ${c.red(glyph.cross)} ${c.cyan(toolName)}: ${c.red(message)}`;
}

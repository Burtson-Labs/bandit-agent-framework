/**
 * Terminal share-link niceties: copy a URL to the clipboard, open it in the
 * browser, and render it as an OSC 8 clickable link. Used when we hand the user
 * a shareable artifact URL so they can click it (open) or grab it (copy)
 * without hunting through scrollback.
 *
 * Best-effort + cross-platform, shelling out to the built-in clipboard/opener
 * tools (same approach as clipboardImage.ts) rather than adding a dependency.
 */
import * as cp from 'child_process';
import { c, glyph, linkify } from './ansi';

/** Copy text to the OS clipboard. Best-effort — returns true on success. */
export function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === 'darwin') {
      return cp.spawnSync('pbcopy', [], { input: text }).status === 0;
    }
    if (process.platform === 'win32') {
      return cp.spawnSync('clip', [], { input: text, shell: true }).status === 0;
    }
    // Linux: Wayland first, then X11.
    if (cp.spawnSync('wl-copy', [], { input: text }).status === 0) return true;
    return cp.spawnSync('xclip', ['-selection', 'clipboard'], { input: text }).status === 0;
  } catch {
    return false;
  }
}

/** Open a URL in the default browser (best-effort, detached so it never blocks). */
export function openInBrowser(url: string): void {
  try {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    cp.spawn(opener, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
  } catch {
    /* opener missing — the printed link is still clickable */
  }
}

/**
 * Render a "published" block: a clickable (OSC 8) link, copy the URL to the
 * clipboard, and optionally open the browser — with a dim hint noting what
 * happened. Returns the string to print.
 */
export function renderPublishedLink(url: string, opts: { label?: string; open?: boolean } = {}): string {
  const copied = copyToClipboard(url);
  if (opts.open) openInBrowser(url);
  const label = opts.label ?? 'shareable link';
  const hint = [copied ? 'copied' : null, 'click to open', opts.open ? 'opening in browser' : null]
    .filter(Boolean)
    .join(' · ');
  return c.green(`${glyph.check} ${label}:\n`) + '  ' + linkify(url) + c.dim(`\n  (${hint})`);
}

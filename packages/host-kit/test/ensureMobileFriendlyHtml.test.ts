import { describe, expect, it } from 'vitest';
import { ensureMobileFriendlyHtml } from '../src/artifacts';

describe('ensureMobileFriendlyHtml', () => {
  it('adds viewport + containment styles into an existing head', () => {
    const out = ensureMobileFriendlyHtml('<html><head><title>x</title></head><body><table></table></body></html>');
    expect(out).toContain('name="viewport"');
    expect(out).toContain('bandit-mobile-baseline');
    expect(out.indexOf('<head>')).toBeLessThan(out.indexOf('viewport'));
  });
  it('respects an existing viewport but still adds containment', () => {
    const src = '<head><meta name="viewport" content="width=device-width"></head><body/>';
    const out = ensureMobileFriendlyHtml(src);
    expect(out.match(/name=["']viewport/g)?.length).toBe(1);
    expect(out).toContain('bandit-mobile-baseline');
  });
  it('is idempotent across republish', () => {
    const once = ensureMobileFriendlyHtml('<html><body>hi</body></html>');
    expect(ensureMobileFriendlyHtml(once)).toBe(once);
  });
  it('prepends for headless fragments', () => {
    const out = ensureMobileFriendlyHtml('<h1>hello</h1>');
    expect(out.startsWith('<meta name="viewport"')).toBe(true);
    expect(out).toContain('<h1>hello</h1>');
  });
});

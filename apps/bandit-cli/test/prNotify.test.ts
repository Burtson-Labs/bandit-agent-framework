/**
 * Self-improve PR notification. The properties that matter: the PR URL is
 * always present and clickable (it is the entire point of the email), proposal
 * detail is summarized when available and degrades quietly when it is not, and
 * untrusted proposal text cannot break out of the HTML.
 */
import { describe, it, expect } from 'vitest';
import { parsePrNotifyArgs, renderPrHtml } from '../src/__ops__/prNotify';

const PR = 'https://github.com/Burtson-Labs/bandit-agent-framework/pull/7';

describe('parsePrNotifyArgs', () => {
  it('defaults the recipient rather than silently emailing nobody', () => {
    const args = parsePrNotifyArgs(['--pr', PR]);
    expect(args.to).toEqual(['mark@burtson.ai']);
    expect(args.pr).toBe(PR);
  });

  it('accepts repeated --to', () => {
    const args = parsePrNotifyArgs(['--pr', PR, '--to', 'a@b.com', '--to', 'c@d.com']);
    expect(args.to).toEqual(['a@b.com', 'c@d.com']);
  });

  it('leaves pr empty when not supplied, so main can refuse to send', () => {
    expect(parsePrNotifyArgs([]).pr).toBe('');
  });
});

describe('renderPrHtml', () => {
  it('links the PR — the one thing the email exists to deliver', () => {
    const html = renderPrHtml(PR, []);
    expect(html).toContain(`href="${PR}"`);
    expect(html).toContain(PR);
  });

  it('summarizes proposals with their titles and touched files', () => {
    const html = renderPrHtml(PR, [
      { kind: 'prompt-tier', title: 'Steer 3 failing fixtures', rationale: 'because X', files: [{ path: '.bandit/lessons.md' }] }
    ]);
    expect(html).toContain('Steer 3 failing fixtures');
    expect(html).toContain('.bandit/lessons.md');
    expect(html).toContain('because X');
    expect(html).toContain('1 proposal(s)');
  });

  it('still sends something useful when proposal detail is missing', () => {
    const html = renderPrHtml(PR, []);
    expect(html).toContain('No proposal detail');
    expect(html).toContain(PR);
  });

  it('escapes proposal text so generated content cannot inject markup', () => {
    const html = renderPrHtml(PR, [
      { title: '<script>alert(1)</script>', rationale: 'a & b < c', files: [] }
    ]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b &lt; c');
  });
});

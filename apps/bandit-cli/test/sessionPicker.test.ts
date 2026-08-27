import { describe, it, expect } from 'vitest';
import { relativeTime, formatSessionRow } from '../src/sessionPicker';
import type { SessionSummary } from '../src/session';

const NOW = 1_700_000_000_000;

describe('relativeTime', () => {
  it('renders humane buckets from seconds to years', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now'); // <60s
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
    expect(relativeTime(NOW - 45 * 86_400_000, NOW)).toBe('2mo ago');
    expect(relativeTime(NOW - 400 * 86_400_000, NOW)).toBe('1y ago');
  });

  it('handles a missing mtime', () => {
    expect(relativeTime(0, NOW)).toBe('unknown');
  });
});

describe('formatSessionRow', () => {
  const s = (over: Partial<SessionSummary>): SessionSummary => ({
    id: 'x', mtime: NOW - 60_000, preview: 'hello world', messageCount: 4, ...over,
  });

  it('shows age, turn count, and preview', () => {
    const row = formatSessionRow(s({}), NOW, 80);
    expect(row).toContain('1m ago');
    expect(row).toContain('2 turns'); // 4 lines / 2
    expect(row).toContain('hello world');
  });

  it('truncates a long preview to fit the width', () => {
    const row = formatSessionRow(s({ preview: 'x'.repeat(200) }), NOW, 60);
    expect(row.length).toBeLessThanOrEqual(60);
    expect(row).toContain('…');
  });

  it('has a placeholder when there is no prompt', () => {
    expect(formatSessionRow(s({ preview: '' }), NOW, 80)).toContain('(no prompt yet)');
  });
});

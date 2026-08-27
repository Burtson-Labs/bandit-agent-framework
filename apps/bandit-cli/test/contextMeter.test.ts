import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateConversationTokens,
  formatContextMeter,
} from '../src/contextMeter';

describe('token estimation', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('sums across message contents, ignoring non-string content', () => {
    const tokens = estimateConversationTokens([
      { content: 'a'.repeat(400) },
      { content: 'b'.repeat(400) },
      { content: undefined },
      {} as { content?: string },
    ]);
    expect(tokens).toBe(200);
  });
});

describe('formatContextMeter', () => {
  it('formats used/window with a percentage', () => {
    const m = formatContextMeter(18_000, 128_000);
    expect(m?.label).toBe('ctx 18K/128K 14%');
    expect(m?.pressure).toBe('ok');
  });

  it('bands pressure at 75% and 90%', () => {
    expect(formatContextMeter(50, 100)?.pressure).toBe('ok');
    expect(formatContextMeter(75, 100)?.pressure).toBe('warn');
    expect(formatContextMeter(90, 100)?.pressure).toBe('high');
    expect(formatContextMeter(200, 100)?.fraction).toBe(1); // clamped
  });

  it('returns null when the window is unknown, rather than dividing by a guess', () => {
    expect(formatContextMeter(1000, 0)).toBeNull();
    expect(formatContextMeter(1000, -1)).toBeNull();
  });

  it('keeps small counts readable and rounds large ones', () => {
    expect(formatContextMeter(500, 8000)?.label).toBe('ctx 500/8K 6%');
    expect(formatContextMeter(262_000, 262_144)?.label).toContain('262K/262K');
  });
});

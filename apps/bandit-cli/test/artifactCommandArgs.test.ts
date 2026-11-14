/**
 * `bandit artifact` argument parsing. Properties: a value flag's value is never
 * mistaken for the file/url positional, and flagValue reads both `--x v` and
 * `--x=v`, returning '' for an explicit empty value (meta clears with it).
 */
import { describe, it, expect } from 'vitest';
import { flagValue, positionalArgs } from '../src/artifactCommand';

describe('bandit artifact args', () => {
  it('skips the values of --title/--description/--expires/--message', () => {
    expect(positionalArgs(['--title', 'Q3 review', 'report.html', '--team'])).toEqual(['report.html']);
    expect(positionalArgs(['share', '--expires', '7d', 'owner/a.html'])).toEqual(['share', 'owner/a.html']);
    expect(positionalArgs(['email', 'k', 'a@b.c', '-m', 'hello there'])).toEqual(['email', 'k', 'a@b.c']);
    expect(positionalArgs(['meta', 'k', '--description', 'One line.'])).toEqual(['meta', 'k']);
  });

  it('reads flag values in both spellings', () => {
    expect(flagValue(['--title', 'A B'], '--title')).toBe('A B');
    expect(flagValue(['--title=A B'], '--title')).toBe('A B');
    expect(flagValue(['--title', ''], '--title')).toBe('');
    expect(flagValue(['x'], '--title')).toBeUndefined();
  });
});

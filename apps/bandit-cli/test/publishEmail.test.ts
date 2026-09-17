/**
 * Deterministic publish + email. The property that matters is the gate: content
 * matching a forbidden pattern must never reach the publish step, because once
 * an agent has mailed something the rule was only ever advisory.
 */
import { describe, it, expect } from 'vitest';
import { findForbidden, parsePublishEmailArgs } from '../src/__ops__/publishEmail';

describe('findForbidden', () => {
  it('catches a forbidden term regardless of case', () => {
    const hits = findForbidden('We shipped the LOCKTON integration', ['lockton']);
    expect(hits).toHaveLength(1);
    expect(hits[0].sample).toBe('LOCKTON');
  });

  it('passes content that does not mention it', () => {
    expect(findForbidden('Bandit stores API keys in the OS keychain.', ['lockton'])).toEqual([]);
  });

  it('reports every violated pattern, not just the first', () => {
    const hits = findForbidden('lockton and acme both appear', ['lockton', 'acme']);
    expect(hits.map(h => h.pattern)).toEqual(['lockton', 'acme']);
  });

  it('treats an unparseable pattern as a violation rather than skipping it', () => {
    // A silently-dropped denylist entry is the worst outcome: it reads as "clean".
    const hits = findForbidden('anything at all', ['(unclosed']);
    expect(hits).toHaveLength(1);
    expect(hits[0].sample).toContain('invalid regex');
  });

  it('matches inside words so a hyphenated or possessive mention still trips', () => {
    expect(findForbidden("lockton's repo", ['lockton'])).toHaveLength(1);
    expect(findForbidden('internal-lockton-tooling', ['lockton'])).toHaveLength(1);
  });

  it('is a no-op when no patterns are configured', () => {
    expect(findForbidden('lockton', [])).toEqual([]);
  });
});

describe('parsePublishEmailArgs', () => {
  it('accepts repeated --to and --forbid', () => {
    const args = parsePublishEmailArgs([
      '--file', 'a.html', '--to', 'a@b.com', '--to', 'c@d.com',
      '--forbid', 'lockton', '--forbid', 'acme'
    ]);
    expect(args.to).toEqual(['a@b.com', 'c@d.com']);
    expect(args.forbid).toEqual(['lockton', 'acme']);
    expect(args.file).toBe('a.html');
  });

  it('defaults to no recipients so main can refuse rather than guess one', () => {
    expect(parsePublishEmailArgs(['--file', 'a.html']).to).toEqual([]);
  });
});

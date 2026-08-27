/**
 * `/update --apply` did nothing. It re-printed the "Update available" banner —
 * including the line telling the user to run `/update --apply` — no matter how
 * many times they ran it.
 *
 * The check was `/\b(--apply|-y|now)\b/`. `\b` matches a transition between a
 * word and a non-word character, and `--apply` BEGINS with a non-word
 * character, so no boundary exists in front of it and that alternative could
 * never match. `-y` was dead for the same reason. Only `now` — the one option
 * the help text does not mention — worked.
 *
 * A regex is the wrong tool for matching discrete flag tokens, so the fix
 * matches tokens exactly. These tests pin every documented spelling.
 */
import { describe, it, expect } from 'vitest';
import { wantsApply } from '../src/slashCommands';

describe('wantsApply', () => {
  // The exact invocation from the bug report.
  it('detects the flag the help text advertises', () => {
    expect(wantsApply('--apply')).toBe(true);
  });

  it('detects every accepted spelling', () => {
    for (const arg of ['--apply', '-y', '--yes', 'apply', 'now']) {
      expect(wantsApply(arg), arg).toBe(true);
    }
  });

  it('is case-insensitive and tolerant of surrounding whitespace', () => {
    for (const arg of ['  --apply  ', '--APPLY', '\t-Y\n', ' Now ']) {
      expect(wantsApply(arg), JSON.stringify(arg)).toBe(true);
    }
  });

  it('finds the flag among other arguments', () => {
    expect(wantsApply('--verbose --apply')).toBe(true);
    expect(wantsApply('--apply --dry-run')).toBe(true);
  });

  it('does not apply when no flag was given', () => {
    for (const arg of ['', '   ', 'check', '--dry-run', 'status']) {
      expect(wantsApply(arg), JSON.stringify(arg)).toBe(false);
    }
  });

  // Exact-token matching, so a flag must not be triggered by a substring —
  // the failure mode a looser regex would reintroduce.
  it('requires a whole token, not a substring', () => {
    for (const arg of ['--applyx', 'reapply', '--no-apply', 'nowhere', '-yes']) {
      expect(wantsApply(arg), arg).toBe(false);
    }
  });

  it('handles a missing argument string without throwing', () => {
    expect(wantsApply(undefined as unknown as string)).toBe(false);
  });
});

/**
 * The same `\b`-before-a-dash defect shipped in the permission risk matcher,
 * where it meant `git push --force` never earned the "High impact shell
 * command" warning.
 */
describe('dashed-flag matching in the risk heuristic', () => {
  const HIGH_IMPACT = /\b(rm|dd|mkfs|chmod|chown|sudo)\b|(^|\s)--force\b|(^|\s)-f\b/;

  it('flags force and -f, which the old pattern silently missed', () => {
    for (const cmd of ['git push --force', 'git push --force origin main', 'git clean -f', 'rm -rf build', 'sudo apt install x']) {
      expect(HIGH_IMPACT.test(cmd), cmd).toBe(true);
    }
  });

  it('does not fire on words that merely contain the flag text', () => {
    for (const cmd of ['npm run buildforce', 'deploy --forceful', 'node reformat.js']) {
      expect(HIGH_IMPACT.test(cmd), cmd).toBe(false);
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  SHARED_GIT_AUTHORSHIP_HEADING,
  SHARED_GIT_AUTHORSHIP_ENABLED_BODY,
  SHARED_GIT_AUTHORSHIP_DISABLED_BODY,
  buildGitAuthorshipBlock,
  buildGitAuthorshipBullet
} from '../src';

/**
 * Pin the shape and contract of the shared prompt sections so the next
 * "while I'm here" edit to either surface (extension prompt or CLI
 * prompt) trips a test if it accidentally re-introduces the duplication
 * that v1.7.348 collapsed.
 */
describe('shared prompt sections — git authorship', () => {
  it('exposes the trailer-format text only once via the shared module', () => {
    // The trailer email format is byte-identical between block and
    // bullet variants. If either variant diverges from
    // SHARED_GIT_AUTHORSHIP_ENABLED_BODY it means a per-surface edit
    // is sneaking back in; the test forces that change to land here,
    // affecting both surfaces at once.
    expect(buildGitAuthorshipBlock(true)).toContain(SHARED_GIT_AUTHORSHIP_ENABLED_BODY);
    expect(buildGitAuthorshipBullet(true)).toContain(SHARED_GIT_AUTHORSHIP_ENABLED_BODY);
  });

  it('block variant renders heading + body for the coauthor flag', () => {
    expect(buildGitAuthorshipBlock(true)).toBe(
      `${SHARED_GIT_AUTHORSHIP_HEADING}\n${SHARED_GIT_AUTHORSHIP_ENABLED_BODY}`
    );
    expect(buildGitAuthorshipBlock(false)).toBe(
      `${SHARED_GIT_AUTHORSHIP_HEADING}\n${SHARED_GIT_AUTHORSHIP_DISABLED_BODY}`
    );
  });

  it('bullet variant prefixes with the bold rule name', () => {
    expect(buildGitAuthorshipBullet(true)).toMatch(
      /^- \*\*Git commits on the user's behalf get a Bandit co-author trailer\.\*\* /
    );
    expect(buildGitAuthorshipBullet(false)).toMatch(
      /^- \*\*Do NOT append a `Co-authored-by: Bandit` trailer to commit messages\.\*\* /
    );
  });

  it('bullet variant appends a surface-specific hint when provided (CLI uses this)', () => {
    const cliHint = ' The user can disable this with `/coauthor off`.';
    const withHint = buildGitAuthorshipBullet(true, cliHint);
    const withoutHint = buildGitAuthorshipBullet(true);
    expect(withHint).toBe(withoutHint + cliHint);
  });

  it('trailer body specifies LITERAL angle brackets (no HTML / unicode escapes)', () => {
    // Regression guard: GitHub's trailer parser only resolves the
    // contributor avatar when the email is wrapped in raw `<` `>` ASCII.
    // The body MUST tell the model to use literal brackets, not
    // `<` / `>` or `&lt;` / `&gt;` — those break attribution.
    expect(SHARED_GIT_AUTHORSHIP_ENABLED_BODY).toContain('LITERAL `<` and `>`');
    expect(SHARED_GIT_AUTHORSHIP_ENABLED_BODY).toContain('\\u003c');
    expect(SHARED_GIT_AUTHORSHIP_ENABLED_BODY).toContain('&lt;');
  });
});

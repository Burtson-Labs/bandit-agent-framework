/**
 * Shared prompt sections — the truly-byte-identical content used by BOTH
 * the VS Code extension prompt builder (`extensionSystemPrompt.ts`) and
 * the CLI prompt builder (`apps/bandit-cli/src/systemPrompt.ts`).
 *
 * Why this exists: pre-v1.7.348, both surfaces inlined the same
 * `## Git Authorship` block verbatim. Drift between them was a question
 * of WHEN, not IF — one surface gets an edit, the other doesn't, and
 * the next time someone tries to add an authorship rule (e.g. a new
 * trailer or a per-repo override) the diff diverges silently.
 *
 * What lives here: ONLY sections that are byte-identical between the two
 * surfaces today. Sections that have intentionally drifted
 * (`WORKING_STYLE` — CLI runs small/medium Ollama models locally and
 * needs more compensation bullets than the extension; `SKILL_AUTHORING`
 * — CLI has a verbose GitHub example, extension uses a tighter Karpathy
 * shape; identity strings — different surfaces, different framing) stay
 * in their per-surface files until a deliberate reconciliation pass
 * brings them together with proper behavior tests on each side.
 *
 * If you add a new shared section here, also:
 *   1. Add an export below.
 *   2. Re-export from `./index.ts` so both builders can import it.
 *   3. Update both builders to use the shared constant instead of
 *      duplicating the text.
 *   4. Add a brief drift-detection assertion in
 *      `test/sharedPromptSections.test.ts` so the next "while I'm here"
 *      edit to either surface trips the gate.
 */

// ─── Git authorship ─────────────────────────────────────────────────────────
//
// Trailer text is byte-identical between the extension and CLI builders.
// Pre-v1.7.348 each surface declared its own copy; v1.7.348 collapsed them
// to a single source of truth.
//
// Why the trailer matters: GitHub resolves the contributor avatar from the
// trailer email when the angle brackets are unescaped ASCII. The dedicated
// `bandit-stealth` GitHub user owns `bandit@burtson.ai`; even before that
// account exists the trailer is harmless — GitHub backfills the avatar
// retroactively once the user is created.

export const SHARED_GIT_AUTHORSHIP_HEADING = '## Git Authorship';

export const SHARED_GIT_AUTHORSHIP_ENABLED_BODY =
  'When you issue `git commit` (or `git_commit`) on the user\'s behalf, append a ' +
  '`Co-authored-by: Bandit <bandit@burtson.ai>` trailer to the commit message. ' +
  'Place it after one blank line at the end of the message body, exactly as GitHub ' +
  'expects. **Use LITERAL `<` and `>` characters around the email — NEVER escape ' +
  'them as `\\u003c` / `\\u003e` or `&lt;` / `&gt;`. GitHub\'s trailer parser only ' +
  'resolves the avatar when the angle brackets are unescaped ASCII.** Single trailer ' +
  'per commit — do not duplicate it across multiple lines or add extra Bandit ' +
  'attributions in the subject. If the commit message already contains a ' +
  '`Co-authored-by: Bandit` trailer (e.g. from amending a prior Bandit commit), ' +
  'leave it alone — do NOT add a second one.';

export const SHARED_GIT_AUTHORSHIP_DISABLED_BODY =
  'Do NOT append a `Co-authored-by: Bandit` trailer to commit messages. The user ' +
  'has explicitly opted out of Bandit co-author attribution.';

/**
 * Composed extension-style block:
 *
 *   ## Git Authorship
 *   <body>
 *
 * Used by the extension prompt builder where each section is a complete
 * mini-document. The CLI uses the body alone in a bulleted list and
 * builds its own heading-less variant via the helper below.
 */
export function buildGitAuthorshipBlock(coauthor: boolean): string {
  const body = coauthor
    ? SHARED_GIT_AUTHORSHIP_ENABLED_BODY
    : SHARED_GIT_AUTHORSHIP_DISABLED_BODY;
  return `${SHARED_GIT_AUTHORSHIP_HEADING}\n${body}`;
}

/**
 * Bulleted variant for the CLI's `## How to work` list, where each rule
 * is rendered as a single bullet. The CLI uses a bold-prefix convention
 * (`- **Git commits on the user's behalf get a Bandit co-author trailer.**
 * <body>`) rather than the extension's heading-per-rule layout, so we
 * synthesize that here rather than re-stating the body in each surface.
 *
 * `surfaceHint` is an optional CLI-specific suffix — the CLI passes
 * `' The user can disable this with \`/coauthor off\` or \`BANDIT_NO_COAUTHOR=1\`.'`
 * to keep the disable-discovery line that the extension doesn't need
 * (the extension has its own /coauthor command surface). When omitted
 * the bullet matches what the extension would produce verbatim.
 */
export function buildGitAuthorshipBullet(coauthor: boolean, surfaceHint = ''): string {
  if (coauthor) {
    return `- **Git commits on the user's behalf get a Bandit co-author trailer.** ${SHARED_GIT_AUTHORSHIP_ENABLED_BODY}${surfaceHint}`;
  }
  return `- **Do NOT append a \`Co-authored-by: Bandit\` trailer to commit messages.** The user has explicitly opted out via \`/coauthor off\` or \`BANDIT_NO_COAUTHOR=1\`.`;
}

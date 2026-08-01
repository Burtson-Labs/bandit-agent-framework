/**
 * Grant scope — what a permission choice actually authorizes.
 *
 * The bug this module exists to kill: the card and the stored rule disagreed.
 * Picking "always" on
 *
 *     npx create-vite my-app --template react
 *
 * showed that command on the card and then persisted `run_command:npx` to
 * `.bandit/settings.json` — every future `npx <anything>`, forever. And "allow
 * session" called `store.grant(toolName)` with no argument at all, so
 * approving `git status` authorized `rm -rf /` for the rest of the session.
 *
 * Both hosts now compute the rule HERE, render it on the card, and store
 * exactly the string they rendered. If the two ever drift again, they drift
 * together and one test catches it.
 *
 * Scope model:
 *
 *  - `once`    Nothing stored.
 *  - `turn`    Nothing stored; the host remembers it for the current turn only.
 *              Covers the "model emitted six edits in one iteration" case
 *              without buying anything beyond it.
 *  - `session` A deliberately broader rule, held in memory until the session
 *              ends. Broad enough to stop prompt-spam mid-task.
 *  - `always`  The same rule, written to `.bandit/settings.json`.
 *
 * `session` and `always` share one rule so the user learns a single mental
 * model and the only difference is how long it lasts.
 */
import type { PermissionPolicy } from './permissions';

export type GrantScope = 'once' | 'turn' | 'session' | 'always';

export interface GrantRule {
  /** The policy pattern to store, or null when the scope stores nothing. */
  rule: string | null;
  /** One-line plain-English blast radius, rendered under the option. */
  describes: string;
}

const EDIT_TOOLS = new Set(['apply_edit', 'replace_range', 'write_file', 'apply_patch']);

/**
 * Tokens that make a command line specific to one run rather than to a kind of
 * work — paths, filenames, URLs, versions, flags with values. A grant should
 * generalize over these, not pin to them, or "always allow `npm test`" fails to
 * match `npm test -- --watch` and the user gets prompted again immediately.
 */
function isVariableToken(token: string): boolean {
  return token.startsWith('-')
    || token.includes('/')
    || token.includes('.')
    || token.includes('=')
    || token.includes('@')
    || /^\d/.test(token)
    || /^https?:/i.test(token);
}

/**
 * Subcommands that don't do anything themselves — they dispatch to whatever the
 * NEXT token names. `npm run` is not an operation; `npm run build` is. Granting
 * at `npm run` would authorize every script in package.json, which is the same
 * class of over-grant this module exists to prevent, so these get one extra
 * token of specificity.
 */
const DISPATCHER_SUBCOMMANDS = new Set(['run', 'exec', 'compose', 'global']);

/**
 * Reduce a command line to the part worth granting on: the binary plus the
 * subcommand that says what kind of operation it is.
 *
 *   git status                              → git status
 *   git push origin main                    → git push
 *   npx create-vite my-app --template react → npx create-vite
 *   npm test -- --watch                     → npm test
 *   npm run build                           → npm run build   (dispatcher)
 *   tsc --noEmit                            → tsc
 *
 * Two tokens by default. A third only after a dispatcher, because otherwise
 * ordinary arguments creep in: `git push origin main` would sign as `git push
 * origin`, which is both too narrow to be useful (a different remote re-prompts)
 * and misleading about what it covers. Remote names, branch names, and script
 * names are plain words — there is no lexical way to tell them from
 * subcommands, so the rule is positional rather than clever.
 */
export function commandSignature(full: string): string {
  const argv = full.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) return '';
  const out = [argv[0].split('/').pop() ?? argv[0]];
  if (argv.length > 1 && !isVariableToken(argv[1])) {
    out.push(argv[1]);
    if (DISPATCHER_SUBCOMMANDS.has(argv[1]) && argv.length > 2 && !isVariableToken(argv[2])) {
      out.push(argv[2]);
    }
  }
  return out.join(' ');
}

export interface GrantScopeInput {
  toolName: string;
  params: Record<string, string>;
  /** The narrow primary the host already computes (path / cmd / url / query). */
  primary: string;
  /** For run_command, the full `cmd + args` line shown on the card. */
  primaryFull?: string;
}

/**
 * Compute the rule a given scope would store. The host renders `describes` on
 * the option and stores `rule` verbatim if the user picks it.
 */
export function grantRuleFor(input: GrantScopeInput, scope: GrantScope): GrantRule {
  const { toolName, primary, primaryFull } = input;

  if (scope === 'once') {
    return { rule: null, describes: 'this call only' };
  }
  if (scope === 'turn') {
    return { rule: null, describes: 'every call like this until the agent finishes this turn' };
  }

  const persisted = scope === 'always';
  const lifetime = persisted ? 'saved to .bandit/settings.json' : 'until this session ends';

  if (toolName === 'run_command' || toolName === 'watch_command') {
    const line = (primaryFull ?? primary ?? '').trim();
    const signature = commandSignature(line);
    if (!signature) {
      return { rule: toolName, describes: `any ${toolName} call — ${lifetime}` };
    }
    // `<signature>*` rather than `<signature> *` so the rule matches the bare
    // command as well as suffixed forms — `git status` and `git status --short`
    // both, not just the latter. The glob engine escapes `*` inside `{a,b}`
    // alternation, so the exact-or-suffixed form can't be expressed precisely;
    // the residual looseness (`git status` also matching a hypothetical `git
    // statuses`) is harmless, and the critical-tier floor in `decidePermission`
    // is what stops a signature from ever spanning into destructive territory.
    const rule = `${toolName}:${signature}*`;
    return { rule, describes: `any \`${signature} …\` command — ${lifetime}` };
  }

  if (EDIT_TOOLS.has(toolName)) {
    // Session and always diverge here, and the split matters.
    //
    // SESSION is tool-broad on purpose: the motivating case is one refactor
    // touching many files, where re-prompting per path is pure friction. The
    // blast radius is bounded by the session and by the workspace, and every
    // change is visible in `git diff`.
    //
    // ALWAYS is path-narrow. A persisted tool-broad edit rule would authorize
    // writing any file in the project, in every future session, from a single
    // click on one file's card — strictly worse than the behavior this module
    // replaced. "Always" should mean "always for this", not "always for
    // everything of this kind".
    //
    // Paths outside the workspace never reach either branch: they classify
    // `critical` and the floor sends them back to the card every time.
    if (persisted) {
      return primary
        ? { rule: `${toolName}:${primary}`, describes: `\`${toolName}\` on \`${primary}\` — ${lifetime}` }
        : { rule: toolName, describes: `any \`${toolName}\` call — ${lifetime}` };
    }
    return {
      rule: toolName,
      describes: `any \`${toolName}\` on files in this project — ${lifetime}`
    };
  }

  if (!primary) {
    return { rule: toolName, describes: `any \`${toolName}\` call — ${lifetime}` };
  }
  return { rule: `${toolName}:${primary}`, describes: `\`${toolName}\` on \`${primary}\` — ${lifetime}` };
}

/**
 * Does this policy already authorize the call a rule would cover? Used to skip
 * a redundant card when a queued parallel call arrives after its sibling was
 * granted.
 */
export function policyIncludes(policy: PermissionPolicy, rule: string): boolean {
  return policy.allow.includes(rule);
}

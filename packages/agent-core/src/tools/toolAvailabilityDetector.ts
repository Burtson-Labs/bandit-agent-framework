/**
 * Tool-availability self-correction detector.
 *
 * Failure mode: after a compaction-heavy turn, OR when an earlier tool
 * call errored, the model sometimes claims a tool "isn't available" /
 * "I don't have access to X" / "no X tool exists" — even though the
 * tool IS registered and would have shown up in the native-tools
 * schema sent on this very turn. The model is hallucinating absence,
 * usually because a prior error message ("Error: tool 'X' not
 * registered" from a typo, or "Expected object, received string"
 * from a schema rejection) survived into the compacted history while
 * the actual success path didn't.
 *
 * Captured 2026-05-25 (Mark, live CLI session): model said it couldn't
 * trash messages even though `burtson-labs.trashMessage` was registered
 * in the MCP pool with 119 other tools. Restarting Bandit "fixed" it.
 * That's a band-aid; the framework should detect the false claim and
 * correct the model inline.
 *
 * Strategy: if the model's response (with no tool_call) contains a
 * negation phrase paired with a tool-name-shaped token that matches
 * a registered tool, push a corrective user message that lists the
 * actually-available tools by name. Capped per-turn to avoid loops.
 */

/**
 * Phrases that signal the model is asserting tool unavailability.
 * Tuned for sensitivity — we'd rather false-positive once than miss
 * the failure mode. The verification step (does the named tool ACTUALLY
 * exist in the registry?) is what gates the corrective nudge, so a
 * false positive here is harmless.
 */
const ABSENCE_PHRASES: RegExp[] = [
  // "I don't have access to" / "I do not have a … tool"
  /\b(?:I|we)\s+(?:do\s+not|don'?t|does\s+not|doesn'?t)\s+have\s+(?:access\s+to\s+)?/i,
  // "I am unable to find/locate/access"
  /\b(?:I'?m|I am)\s+unable\s+to\s+(?:find|locate|access|use)/i,
  // "cannot find / locate / access X tool"
  /\b(?:cannot|can'?t)\s+(?:find|locate|access|use|call|invoke)\s+/i,
  // "no such tool" / "no … tool is available"
  /\bno\s+(?:such\s+)?\S+(?:\s+\S+){0,3}\s+tool\b/i,
  /\bthere\s+is\s+no\s+\S+(?:\s+\S+){0,3}\s+tool\b/i,
  // "X is not available / unavailable"
  /\b(?:is\s+not\s+available|isn'?t\s+available|are\s+not\s+available|aren'?t\s+available|is\s+unavailable|are\s+unavailable)\b/i,
  /\b(?:not\s+available|unavailable)\s+(?:in|for|to|here|right\s+now|at\s+the\s+moment)/i,
  // "I don't see / can't see X tool in"
  /\b(?:do\s+not|don'?t|cannot|can'?t)\s+see\s+(?:a\s+|an\s+|the\s+)?/i,
];

/** Verb keywords that hint the model is talking about an actionable tool. */
const ACTION_HINTS: RegExp[] = [
  /\b(?:trash|archive|delete|remove|send|create|update|modify|read|list|search|fetch|get|post|move|reply)\b/i,
];

export interface ToolAvailabilityCheckResult {
  /** True iff the response claims a tool is missing AND that tool IS registered. */
  detected: boolean;
  /** Names of registered tools that the model appears to be denying access to. */
  matchedToolNames: string[];
  /** Subset of registered tool names relevant to the model's claim, for the nudge body. */
  suggestedTools: string[];
}

/**
 * Pure check — does the response text appear to deny access to a
 * tool that's actually registered?
 *
 * @param response          Model's most recent assistant message (post-strip).
 * @param registeredTools   Names of every tool currently in the registry.
 *                          MCP namespacing preserved ("burtson-labs.trashMessage").
 * @returns ToolAvailabilityCheckResult — see field docs.
 */
export function detectFalseToolAbsence(
  response: string,
  registeredTools: string[]
): ToolAvailabilityCheckResult {
  if (!response || registeredTools.length === 0) {
    return { detected: false, matchedToolNames: [], suggestedTools: [] };
  }
  const hasAbsencePhrase = ABSENCE_PHRASES.some((re) => re.test(response));
  if (!hasAbsencePhrase) {
    return { detected: false, matchedToolNames: [], suggestedTools: [] };
  }
  // Find any registered tool whose bare name (post-MCP-namespace strip)
  // appears in the response. We test the bare name first because the
  // model rarely uses the full "burtson-labs." prefix when complaining
  // — it'll say "trashMessage" or "trash message" or "delete email".
  const matched: string[] = [];
  for (const full of registeredTools) {
    const bare = stripNamespace(full);
    // Exact bare-name substring (case-insensitive). Use word boundaries
    // when feasible — guards against "createFilter" matching mid-word.
    const bareRe = new RegExp(`\\b${escapeRegex(bare)}\\b`, 'i');
    if (bareRe.test(response)) {
      matched.push(full);
      continue;
    }
    // snake_case → space match: trashMessage → "trash message"
    const spaced = bare.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
    if (spaced !== bare.toLowerCase()) {
      const spacedRe = new RegExp(`\\b${escapeRegex(spaced)}\\b`, 'i');
      if (spacedRe.test(response)) {
        matched.push(full);
      }
    }
  }
  if (matched.length === 0) {
    // Fallback: model said "I don't have access to a Gmail tool" without
    // naming the exact registered name. If the response contains an
    // action verb AND any MCP tool exists that starts with a matching
    // verb stem, suggest those. Conservative — only kicks in when an
    // action hint is present so we don't false-positive on general
    // chitchat.
    const hasAction = ACTION_HINTS.some((re) => re.test(response));
    if (!hasAction) {
      return { detected: false, matchedToolNames: [], suggestedTools: [] };
    }
    // Heuristic: pick the first 6 registered tools whose bare name starts
    // with one of the action verbs the model mentioned. Caps the prompt
    // budget on the corrective message.
    const verbMatches = ACTION_HINTS
      .map((re) => response.match(re)?.[0]?.toLowerCase() ?? '')
      .filter(Boolean);
    if (verbMatches.length === 0) {
      return { detected: false, matchedToolNames: [], suggestedTools: [] };
    }
    const fallback = registeredTools.filter((full) => {
      const bare = stripNamespace(full).toLowerCase();
      return verbMatches.some((v) => bare.startsWith(v));
    });
    if (fallback.length === 0) {
      return { detected: false, matchedToolNames: [], suggestedTools: [] };
    }
    return { detected: true, matchedToolNames: [], suggestedTools: fallback.slice(0, 6) };
  }
  return { detected: true, matchedToolNames: matched, suggestedTools: matched.slice(0, 6) };
}

/**
 * Build the corrective user message body. Lists the actually-registered
 * tool names so the model sees concrete evidence its claim was wrong.
 */
export function buildToolAvailabilityNudge(result: ToolAvailabilityCheckResult): string {
  const names = result.suggestedTools.length > 0 ? result.suggestedTools : result.matchedToolNames;
  const list = names.map((n) => `  - ${n}`).join('\n');
  return (
    'You claimed a tool is unavailable, but the following tool(s) ARE registered for this turn ' +
    '(check the system tool list — they were sent in the native-tools schema, even if a prior compaction collapsed earlier results):\n' +
    `${list}\n\n` +
    'Re-attempt the action with the correct tool name from the list above. If you have already tried these and they errored, ' +
    'explain WHICH parameter or precondition failed — do not claim absence. If none of these match the user\'s ask, ' +
    'state honestly which capability you lack rather than guessing.'
  );
}

function stripNamespace(toolName: string): string {
  const dotIdx = toolName.indexOf('.');
  if (dotIdx > 0) {return toolName.slice(dotIdx + 1);}
  const underIdx = toolName.indexOf('__');
  if (underIdx > 0 && toolName.startsWith('mcp__')) {
    const after = toolName.slice(underIdx + 2);
    const next = after.indexOf('__');
    return next > 0 ? after.slice(next + 2) : after;
  }
  return toolName;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Eval harness types.
 *
 * A fixture is a single prompt-and-expectation pair: we hand the prompt to
 * the agent loop, capture every tool call it makes, then grade the trace
 * against a set of assertions. Fixtures live as TypeScript files — typed,
 * multi-line-string-friendly, IDE-complete — rather than YAML to avoid
 * writing yet another parser.
 *
 * Models are stochastic, so each fixture runs N times and passes if at
 * least `passThreshold` runs satisfy the assertions. Majority-pass (2/3)
 * is the sensible default; individual fixtures can override.
 */

import type { ToolLoopMessage } from '@burtson-labs/agent-core';

export interface FixtureSetup {
  /** Files written to the sandbox workspace before the agent runs.
   *  Keys are relative paths; values are verbatim file contents. */
  files?: Record<string, string>;
  /** Workspace skills to install under .bandit/skills/ before the run.
   *  Useful for eval'ing "does the agent use a skill once it's active?". */
  skills?: Record<string, string>;
  /** Optional BANDIT.md contents. */
  memory?: string;
}

export interface ToolCallAssertion {
  /** Tool name that must appear in the trace (at least one call).
   *  Accepts a plain string for exact match or a RegExp for OR patterns
   *  like /^(apply_edit|replace_range|write_file)$/ — useful when the correct tool
   *  choice depends on file shape (e.g. single-line files → write_file;
   *  targeted edits of multi-line files → apply_edit). */
  name: string | RegExp;
  /** Optional predicate on the params of that call. All provided keys must
   *  match their expected value (exact string match or a test function). */
  params?: Record<string, string | RegExp | ((value: string) => boolean)>;
}

export interface FixtureAssertions {
  /** The agent must call AT LEAST ONE of these tools at least once.
   *  Accepts plain tool names or {name, params} predicates for finer-grained
   *  checks (e.g. "git_log must include repo_path"). */
  mustCallAnyOf?: Array<string | ToolCallAssertion>;
  /** The agent must satisfy EVERY entry in this list — each entry matches
   *  at least one tool call. Use this for cross-stack fixtures that require
   *  edits in multiple files: "must edit Worksheet.cs AND worksheet.ts AND
   *  ChecklistSection.tsx". A missing entry is a failure with a specific
   *  "expected call matching X was never made" reason. */
  mustCallAllOf?: Array<string | ToolCallAssertion>;
  /** The agent must NOT call any of these tools. Used to forbid known
   *  wrong choices (write_file when apply_edit was expected, legacy JSON
   *  writes when markdown was expected, etc). */
  mustNotCall?: string[];
  /** The trace must finish within this many loop iterations. Catches the
   *  "model grinds to maxIterations" failure mode explicitly. Defaults
   *  to the loop's own cap if omitted. */
  maxIterations?: number;
  /** Optional assertion on the final text response (after tool calls
   *  complete). Regex match; pass if any trace matches. */
  finalResponseMatches?: RegExp;
}

export interface Fixture {
  id: string;
  /** One-line statement of what the fixture is testing. Shows in the report. */
  description: string;
  /** The user prompt the agent receives, verbatim. */
  prompt: string;
  setup?: FixtureSetup;
  assertions: FixtureAssertions;
  /** How many times to run — default 3. */
  runs?: number;
  /** Minimum passing runs for the fixture itself to pass — default 2. */
  passThreshold?: number;
  /** Per-fixture iteration cap handed to the tool-use loop. Default 8.
   *  Lower for fixtures that should resolve in one or two tool calls. */
  maxIterations?: number;
  /** When set, the fixture only runs against providers whose kind matches.
   *  Use for assertions that only make sense on a specific model family. */
  onlyProviders?: Array<'ollama' | 'bandit' | 'openai-compatible'>;
  /** Seed messages before the user prompt — useful for multi-turn setups
   *  (e.g. "user asked to read a file earlier, now asks to edit it"). */
  priorMessages?: ToolLoopMessage[];
}

export interface ToolCallTrace {
  name: string;
  params: Record<string, string>;
  /** Index in the sequence of tool calls across the whole run. */
  order: number;
  /** Loop iteration this call happened in. */
  iteration: number;
  isError?: boolean;
  outputSnippet?: string;
  /** First 400 chars of the raw tool_call block emitted by the model.
   *  Essential for debugging parser-edge cases where params land empty. */
  rawCallSnippet?: string;
}

export interface RunResult {
  runNumber: number;
  passed: boolean;
  failureReasons: string[];
  toolCalls: ToolCallTrace[];
  iterations: number;
  hitLimit: boolean;
  finalResponse: string;
  /** Wall clock ms — gut-check on whether a fix slowed us down. */
  wallTimeMs: number;
  error?: string;
}

export interface FixtureResult {
  fixture: Fixture;
  runs: RunResult[];
  passed: boolean;
  passRate: string;  // "2/3"
  skipped?: string;  // reason if the fixture was skipped for this provider
}

export interface EvalReport {
  provider: string;
  model: string;
  /** Which system-prompt variant the fixtures ran against. Defaults to 'cli'. */
  variant?: 'cli' | 'extension';
  fixtureResults: FixtureResult[];
  totalWallTimeMs: number;
  startedAt: string;
}

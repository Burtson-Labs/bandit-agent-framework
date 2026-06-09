/**
 * Turn-log replay tests.
 *
 * Each captured turn becomes a regression fixture: the model's
 * actual responses get replayed through a fresh ToolUseLoop and we
 * assert on the events the loop emits. If a future change to the
 * loop alters how it interprets a known-good (or known-broken)
 * historical run, the test fails.
 *
 * Fixtures live in `test/fixtures/turns/`. Add new fixtures by
 * copying a `.bandit/turns/*.jsonl` from a workspace and pruning to
 * the smallest representative slice. Avoid fixtures with
 * responsePreview truncation (replayCompleteness=false) until the
 * loop captures full responses — preview-truncated tail content can
 * silently drop tool calls during replay.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  loadTurnLog,
  extractParentScript,
  replayTurn
} from './_replay';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures/turns');

describe('turn-log replay harness', () => {
  it('parses a turn log and extracts the parent script', () => {
    const events = loadTurnLog(path.join(FIXTURES_DIR, 'turn-still-alive.jsonl'));
    const script = extractParentScript(events);

    expect(script.userPrompt).toBe('still alive?');
    // Two LLM responses captured — one tool-calling, one final answer.
    expect(script.responses.length).toBe(2);
    expect(script.responseMeta.length).toBe(2);
    // First response invokes check_task — the captured flag should
    // reflect that.
    expect(script.responseMeta[0].hasToolCallMarkup).toBe(true);
    expect(script.responseMeta[1].hasToolCallMarkup).toBe(false);
    // Both responses fit in the 2000-char preview window so this
    // fixture is fully replayable.
    expect(script.replayCompleteness).toBe(true);
  });

  it('replays the "still alive?" turn and the loop fires the right events', async () => {
    const events = loadTurnLog(path.join(FIXTURES_DIR, 'turn-still-alive.jsonl'));
    const { script, emitted, result } = await replayTurn(events);

    expect(script.replayCompleteness).toBe(true);

    // Two iterations expected: tool call → final answer.
    const llmStarts = emitted.filter((e) => e.type === 'tool_loop:llm_start');
    expect(llmStarts.length).toBeGreaterThanOrEqual(2);

    // The first iteration's parsed tools should include check_task —
    // the same tool the original log captured.
    const toolCallEvents = emitted.filter((e) => e.type === 'tool_loop:tool_calls');
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
    const firstToolCall = toolCallEvents[0].payload as { tools?: string[] };
    expect(firstToolCall.tools).toContain('check_task');

    // The loop should NOT have hit the iteration limit on a healthy
    // 2-iteration replay.
    expect(result.hitLimit).toBe(false);
    expect(result.cancelled).toBeUndefined();

    // None of the no-tool-call recovery detectors should have fired —
    // this is a clean run.
    const recoveryDetectors = [
      'tool_loop:empty_retry',
      'tool_loop:thinking_off_recovery',
      'tool_loop:parse_retry',
      'tool_loop:false_completion_nudge',
      'tool_loop:partial_completion_nudge',
      'tool_loop:code_fence_nudge',
      'tool_loop:announce_intent_nudge',
      'tool_loop:fake_tool_result_detected',
      'tool_loop:hallucinated_tool_result',
      'tool_loop:prose_loop_nudge',
      'tool_loop:todo_churn_nudge'
    ];
    for (const detector of recoveryDetectors) {
      const fires = emitted.filter((e) => e.type === detector);
      expect(fires.length, `detector ${detector} should not fire on a clean turn`).toBe(0);
    }
  });

  it('exposes a single chat() call per scripted response (one-shot replay)', async () => {
    const events = loadTurnLog(path.join(FIXTURES_DIR, 'turn-still-alive.jsonl'));
    const { emitted } = await replayTurn(events);
    // The number of llm_start events should equal the number of
    // scripted responses consumed (the loop calls chat() once per
    // iteration boundary, no retries on this clean turn).
    const llmStarts = emitted.filter((e) => e.type === 'tool_loop:llm_start');
    expect(llmStarts.length).toBe(2);
  });

  // Aggressive compaction trace — replays a real 9-iteration self-eval
  // run that triggered three compactions (30k→17k, 28k→22k, 24k→14k)
  // plus the resulting goal-anchor refire path. The final iteration's
  // wrap-up is 9.9k chars (exceeds the 2000-char preview cap), so
  // replayCompleteness is false — but the iterations of interest
  // (0-7, where compaction and goal-anchor fire) are all complete,
  // and the truncated final response just terminates the loop cleanly
  // without affecting earlier events.
  it('replays a real aggressive-compaction trace and pins the compaction + goal-anchor events', async () => {
    const events = loadTurnLog(path.join(FIXTURES_DIR, 'turn-aggressive-compaction.jsonl'));
    const { script, emitted, result } = await replayTurn(events, {
      // Original run hit a budget around 18k tokens (first compaction
      // fired with beforeTokens=30712 → afterTokens=17348). Match it.
      messageTokenBudget: 18_000,
      maxIterations: 12,
      // Length-dependent behaviors (compaction, goal anchoring) need
      // tool outputs sized like the originals — placeholder tools
      // return 64-char strings that never trip those gates.
      matchToolOutputSizes: true
    });

    // The final iteration's preview is truncated, but every earlier
    // iteration is complete — verify per-response.
    const earlyComplete = script.responseMeta.slice(0, 8).every((m) => m.captureComplete);
    expect(earlyComplete).toBe(true);

    // Real run logged THREE `compacted` events. Replay should fire at
    // least that many (loop runs compaction every iteration when budget
    // bites; original recorder may have logged a subset).
    const compactions = emitted.filter((e) => e.type === 'tool_loop:compacted');
    expect(compactions.length).toBeGreaterThanOrEqual(3);

    // Aggressive compaction (>25% drop) forces a goal-anchor refire.
    // The original run logged 3 goal_anchor events; pin that the
    // override path fires at least once under replay.
    const anchors = emitted.filter((e) => e.type === 'tool_loop:goal_anchor');
    expect(anchors.length).toBeGreaterThanOrEqual(1);
    const aggressiveAnchor = anchors.find(
      (a) => (a.payload as { postAggressiveCompaction?: boolean }).postAggressiveCompaction === true
    );
    expect(aggressiveAnchor).toBeDefined();

    // No recovery detectors should fire — this was a healthy run, just
    // a long one with heavy file reading.
    const noisyDetectors = [
      'tool_loop:false_completion_nudge',
      'tool_loop:partial_completion_nudge',
      'tool_loop:code_fence_nudge',
      'tool_loop:fake_tool_result_detected',
      'tool_loop:hallucinated_tool_result',
      'tool_loop:prose_loop_nudge',
      'tool_loop:todo_churn_nudge'
    ];
    for (const detector of noisyDetectors) {
      const fires = emitted.filter((e) => e.type === detector);
      expect(fires.length, `detector ${detector} should not fire on a healthy compaction-heavy run`).toBe(0);
    }

    // The loop should not have hit the iteration cap on the replay.
    expect(result.hitLimit).toBe(false);
    expect(result.cancelled).toBeUndefined();
  });
});

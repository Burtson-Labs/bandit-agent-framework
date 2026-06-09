# Turn-Log Replay Fixtures

This directory holds real `.bandit/turns/*.jsonl` traces, pruned to the smallest representative slice and used as regression tests for `ToolUseLoop`. Every weird model behavior bandit has produced in the wild can become a fixture here, asserting that a future loop change doesn't silently regress the response.

## What lives here

Each `.jsonl` file is a single turn-log captured by the host (extension or CLI) during a real agent run. The replay harness in `../_replay.ts` reads these, extracts the model's responses in order, and feeds them through a fresh `ToolUseLoop` with placeholder tools. Tests then assert on the events the loop emits — comparing them to what we *expect* given the loop's current detector contract.

## How to add a fixture

1. **Pick a turn.** A turn worth fixturing exhibits a specific behavior — a detector firing (`tool_loop:code_fence_nudge`, `tool_loop:goal_anchor`, etc.), a recovery path activating, or a known-good clean run on a model/scenario you want to keep working. Real workspace traces live in `.bandit/turns/` (project root, gitignored).

2. **Filter by replay completeness.** The host caps `responsePreview` at 2000 chars. If any LLM response in the trace has `responseLength > 2000`, the tail (which often contains the tool_call envelope) was clipped. The harness flags this via `script.replayCompleteness === false`. Avoid fixtures that fail this check until lossless capture lands.

   ```bash
   # Quick check — count responses that exceed the preview cap
   grep '"type":"llm-response"' your-turn.jsonl \
     | jq -r 'select(.responseLength > 2000) | .responseLength'
   ```

3. **Copy + rename descriptively.** Name the fixture for what it demonstrates, not the timestamp:

   ```bash
   cp .bandit/turns/turn-2026-05-09T02-52-17-964Z-4e97.jsonl \
      packages/agent-core/test/fixtures/turns/turn-still-alive.jsonl
   ```

   Good names: `turn-code-fence-hallucination.jsonl`, `turn-aggressive-compaction.jsonl`, `turn-subagent-spawn-clean.jsonl`. Bad names: the original timestamp.

4. **Prune if useful.** If the turn is huge (>50 KB) but the bug shows up in iterations 0-2, you can hand-edit the JSONL to drop trailing events. Keep the `user-prompt` event and every `llm-start` / `llm-response` pair through the iteration where the behavior settles. The harness only reads `user-prompt` and `llm-response` — other events are informational.

5. **Add a test.** In `../turnReplay.test.ts`, write a `describe` block per fixture. Pattern:

   ```ts
   it('replays <fixture-name> and pins <expected behavior>', async () => {
     const events = loadTurnLog(path.join(FIXTURES_DIR, '<fixture-name>.jsonl'));
     const { script, emitted, result } = await replayTurn(events, {
       // optional: messageTokenBudget, isSubagent, etc. to match the
       // original run's loop options
     });
     expect(script.replayCompleteness).toBe(true);

     // Pin specific events that the original captured. These are the
     // contract: if they stop firing under the same input, the loop
     // regressed.
     const codeFenceFires = emitted.filter((e) => e.type === 'tool_loop:code_fence_nudge');
     expect(codeFenceFires.length).toBe(1);
     // ... or the inverse — pin that detectors do NOT fire for clean runs.
   });
   ```

## What to assert

Pin the specific behaviors the trace was capturing. Common patterns:

| Trace shape | What to pin |
|---|---|
| Clean run, real tool calls | `tool_loop:tool_calls` fires with the right tool names; no recovery detectors fire |
| Model hallucinated `<tool_result>` | `tool_loop:fake_tool_result_detected` fires, and `result.finalResponse` is scrubbed |
| Model pasted code fence instead of editing | `tool_loop:code_fence_nudge` fires once; the nudge text mentions `apply_edit` / `write_file` |
| Long turn that hit message budget | `tool_loop:compacted` fires with non-zero `messagesCompacted`; possibly `tool_loop:goal_anchor` follows |
| Iter limit hit | `result.hitLimit` is true; `iterations >= maxIterations` |
| Cancellation | `result.cancelled` is true; `result.finalResponse` is `'[cancelled]'` or partial captured text |

## When NOT to add a fixture

- The behavior is already pinned by a synthetic test in one of the `*Detectors.test.ts` / `*Contract.test.ts` files. Real-trace fixtures shine when the synthetic test inputs would be too contrived to hit the same edge case.
- The trace is large (>100 KB) and the interesting behavior is unique. The replay tests run on every push; an oversized fixture taxes CI and rarely earns its weight.
- The trace contains workspace-private content (file contents from a private repo, secret tokens). Strip or redact before committing — fixtures land in the public package.

## Limitations to know about

1. **Preview truncation (2000 chars).** Tool calls in the tail of long responses get dropped. Future work: lossless capture for replayable traces.
2. **Placeholder tools.** The replay registry registers a fixed set of tool names with placeholder execute functions that return `[replay placeholder result for <name>]`. Tests that depend on actual tool output (e.g., asserting on `apply_edit` diffs) won't work — those need integration tests, not replay.
3. **Subagent traces aren't directly replayable through the parent loop.** Subagents spawn their own loops with their own chat functions; the replay harness only feeds the parent's script. To test subagent behavior, either capture the subagent's own log separately or write a synthetic test against `taskTool`.
4. **Native-tool mode differs.** A trace captured with `nativeTools: true` provides tool schemas via the chat function's second arg, not the system prompt's XML block. The harness doesn't yet replay native-tool traces with full fidelity — passing `nativeTools: true` to `replayTurn` works for the loop but the test assertions need to know.

## See also

- `../_replay.ts` — the harness itself
- `../turnReplay.test.ts` — the tests this directory's fixtures feed
- `../constructorOptionsContract.test.ts` and the `*Detectors.test.ts` siblings — synthetic detector contracts that this real-trace coverage complements

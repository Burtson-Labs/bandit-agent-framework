# How a turn works

A "turn" is one trip from a goal to a result. Understanding the loop in the middle is the mental model that makes everything else — tools, skills, memory, the guard — click into place.

---

## The loop

```
goal
  │
  ▼
build prompt  ──►  model generates  ──►  final answer?  ──► yes ──► done
  ▲                      │                    │ no
  │                      ▼                    ▼
  │                 tool calls          feed results back
  │                      │                    │
  └──────────────────────┴────────────────────┘
```

1. **Assemble the prompt.** A capability-aware system prompt + your project [memory](./host-kit.html) (`BANDIT.md` and lazy-loaded topics) + the conversation so far + any [skills](./host-kit.html) the prompt activated.
2. **The model generates** (streamed token by token). It either writes a final answer or emits one or more **tool calls**.
3. **Each tool call is gated before it runs** — the opt-in [security guard](./host-kit.html), then your `PreToolUse` hooks, then the approval prompt (unless auto-approved). Any of them can block it.
4. **Tools execute** through the environment adapter — `read_file`, `run_command`, `web_search`, your own. Results (and errors) are captured.
5. **Results feed back** into the conversation, and the loop runs again — so the model can react to what it just learned.
6. **The turn ends** when the model returns a final answer with no tool calls, or it hits a step/token budget.

---

## What keeps it from derailing

Real models are flaky, contexts fill up, and small models fumble tool syntax. The loop has guardrails for each:

- **Retries** — an upstream hiccup (timeout, 5xx) retries with backoff instead of failing the turn.
- **Tool-protocol fallback** — if native tool-calling fails, the runtime retries that step with Bandit's text-based tool protocol, which small models handle more reliably.
- **Empty / reasoning-only recovery** — if the model "thinks" but takes no action, it's nudged to actually call a tool.
- **Thinking-off recovery** — if a reasoning-mode model stalls in its reasoning channel, the runtime retries with thinking disabled.
- **Compaction** — when the context window fills, older turns are summarized so the conversation can continue without blowing the budget.
- **Goal re-anchoring** — on long turns, the original goal is re-injected so the model doesn't drift.

These are why the same prompt behaves consistently across Gemma, Qwen, Llama, GPT, and Claude — the [model behavior profiles](./stealth-core-runtime.html) pick the right strategy per model.

---

## Where each piece lives

| Concern | Owned by |
|---|---|
| The loop itself, tool registry | [`agent-core`](./agent-core.html) |
| Provider impls, model catalog, prompts, compaction strategy | [`stealth-core-runtime`](./stealth-core-runtime.html) |
| Memory, hooks, the guard, MCP, drop-in tools | [`host-kit`](./host-kit.html) |
| Filesystem / shell / editor / browser access | [`agent-adapters`](./agent-adapters.html) |

---

## What you observe

Every step emits an event — `llm_start`, `llm_chunk`, `llm_response`, `tool_execute`, `tool_result`, retries, compaction. The CLI and extension render these live (the streaming text, the tool lines, the spinner), and the opt-in [telemetry](./configuration.html) maps the same stream to a trace: one turn = one trace, with the LLM call and each tool as child spans.

**Next:** [Build your own host](./build-your-own-host.html) · [Configuration](./configuration.html)

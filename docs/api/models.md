# Models

Bandit serves a small family of first-party models behind one OpenAI-compatible
API. You pick a model with the `model` parameter on any request — there are no
weights to host, no GPUs to manage, and no upstreams to wire up. Where each call
runs is described under [Where requests run](#where-requests-run).

> You target a **capability tier**, not a specific checkpoint. Bandit keeps the
> implementation behind each model free to improve over time, so your
> integration keeps working as the models get better underneath it.

## The lineup

| Model | Tier | Best for |
|-------|------|----------|
| `bandit-core` | Fast, general-purpose | Everyday chat, drafting, summarizing, classification, and high-volume calls where latency and cost matter most. |
| `bandit-core-2` | Advanced general-purpose | Harder general tasks that need stronger reasoning and tighter instruction-following than `bandit-core`. |
| `bandit-logic` | Reasoning | Analysis, planning, and step-by-step problem solving — tasks that reward deliberate thinking. |
| `bandit-logic-2` | Advanced reasoning &amp; coding | The most capable tier: long-horizon reasoning, agentic tool use, and code generation/editing. This is the tier behind **Bandit Stealth**. |

`bandit-core-1` is a pinned alias of `bandit-core`; use the unversioned
`bandit-core` to always track the latest of that tier.

## Where requests run

Requests go to Burtson Labs' gateway at `api.burtson.ai`, which sends each one to a backend according to the model and your plan:

| Model | Paid plans | Free accounts |
|-------|-----------|---------------|
| `bandit-core`, `bandit-core-2` | Burtson Labs' own GPUs. If they are unavailable, the request moves to an open-weight model through OpenRouter. | Burtson Labs' own GPUs only |
| `bandit-logic`, `bandit-logic-2` | Open-weight models (such as Kimi) from hosting providers through OpenRouter, with Burtson Labs' GPUs as the fallback. | Burtson Labs' own GPUs only |

Every request Bandit sends to OpenRouter asks for zero-data-retention endpoints only (`provider.zdr`) and denies data collection (`provider.data_collection: deny`), so it is served only by providers that do not store or train on prompts. When a paid plan's weekly Bandit Cloud allowance is used up, requests continue on Burtson Labs' GPUs.

Burtson Labs does not train models on your requests. The full list of connections and data handling is in [What Bandit sends](https://burtson.ai/bandit/what-bandit-sends) and on [Security and trust](https://burtsonlabs.com/security).

## Choosing a model

- **Start with `bandit-core`.** It handles the majority of assistant work and is the fastest, lowest-cost option.
- **Move up to `bandit-core-2`** when answers need more depth or stricter adherence to detailed instructions.
- **Use `bandit-logic`** for problems that benefit from explicit reasoning — analysis, multi-constraint decisions, planning.
- **Use `bandit-logic-2`** for coding and agentic work: writing and refactoring code, tool-driven tasks, and anything with a long chain of steps. It powers the Bandit Stealth coding agent.

## Calling a model

The API is OpenAI-compatible — set `model` to any ID above:

```bash
curl https://api.burtson.ai/api/chat/completions \
  -H "Authorization: Bearer $BANDIT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "bandit-logic-2",
    "messages": [
      { "role": "user", "content": "Refactor this function and explain the change." }
    ]
  }'
```

See the [Overview](api-overview.html) for authentication, the base URL, and
streaming.

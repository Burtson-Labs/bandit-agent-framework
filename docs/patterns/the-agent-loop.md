# The agent loop

> **Patterns** are the general techniques behind modern agents — not Bandit inventions. Each page explains the idea, points at the original sources, and shows how Bandit applies it. Start here: the loop is the foundation everything else sits on.

---

## The idea

A language model on its own can only do one thing: predict text. To *act* — read a file, call an API, run a test — it needs to be wrapped in a loop:

```
reason  →  act (call a tool)  →  observe the result  →  reason again  →  …  →  answer
```

Anthropic calls the basic building block the **augmented LLM** — a model given retrieval, tools, and memory, able to generate its own queries, pick tools, and decide what to keep. An *agent* is then almost anti-climactic to define: in their words, agents are "just LLMs using tools in a loop based on environmental feedback." The sophistication isn't in the architecture — it's in the loop running against real results.

## Why the loop matters

The key word is **feedback**. A model asked to fix a bug in one shot is guessing — it writes a patch against its mental model of code it half-remembers. A model *in a loop* reads the actual file, makes a change, runs the actual test, sees the actual failure, and corrects. It reasons over reality instead of its priors.

The landmark result here is **ReAct** (Yao et al., 2022), which showed that interleaving **rea**soning traces with **act**ions beats doing either alone. Pure chain-of-thought reasoning hallucinates and propagates its own errors because nothing ever checks it; pure action lacks a plan. Interleaving them — think, act, observe, think again — let a model interacting with a simple Wikipedia API outperform much heavier approaches, precisely because each action grounds the next thought.

## What the loop needs to be reliable

A naive loop derails: models stall, contexts fill, small models fumble tool syntax. A production loop adds guardrails around each failure mode — retries on transient errors, a fallback when native tool-calling breaks, recovery when the model "thinks" but never acts, and context compaction when the window fills.

## How Bandit applies it

[How a turn works](./how-a-turn-works.html) is Bandit's loop, concretely: assemble the prompt → the model streams reasoning and tool calls → each call is gated and executed through an [environment adapter](./build-your-own-host.html) → results feed back → repeat until a final answer. The guardrails above are built in, and the strategy for each is chosen per model via the [behavior profiles](./providers-and-models.html) — which is why the same loop holds up across a 4B local model and a frontier cloud one.

---

## Sources

- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629) — Yao et al., 2022. The interleaved reason/act formulation.
- [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) — Anthropic, 2024. The augmented LLM, workflows vs. agents, and why to start simple.
- [Writing Effective Tools for AI Agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — Anthropic. Designing the tool interface the loop calls.

**Next:** [Retrieval & context](./retrieval-and-context.html) · [How a turn works](./how-a-turn-works.html) · [Tools](./tools.html)

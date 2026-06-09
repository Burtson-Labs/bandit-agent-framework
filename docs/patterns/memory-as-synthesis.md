# Memory as synthesis

Most agent "memory" is a vector store: dump every conversation into a database, embed it, and retrieve the nearest chunks later. It scales storage, but it doesn't scale *understanding* — you get fragments back, ranked by cosine similarity, with no judgment about what actually mattered. This page is about the alternative, and it's the idea [`BANDIT.md`](./memory.html) is built on.

---

## The idea: synthesize, don't just retrieve

Andrej Karpathy sketched the sharper version in his **LLM wiki** pattern (2026): an agent's memory shouldn't be a pile of raw logs you search — it should be a *curated, compiled artifact*. Conversations flow into daily logs; the logs get compiled by the model into a wiki; that wiki is injected back into the next session; the agent grows its own knowledge base over time. The headline:

> **Memory should be synthesis, not retrieval.**

It connects to his broader framing of the [LLM as a new kind of operating system](./retrieval-and-context.html): the model is the CPU, the context window is the RAM, and long-term memory is the disk you page the *right, distilled* facts in from — not a firehose you grep.

The difference is judgment. Retrieval gives you "here are five chunks that look similar to your query." Synthesis gives you "here is what we decided and why." For a coding agent that needs your conventions, your architecture, and the landmines you've already stepped on, the second is worth far more than the first.

## Why this fits a coding agent

A synthesized, file-based memory has properties a vector store can't match:

- **Auditable** — you can read it, top to bottom, and know exactly what the agent believes.
- **Editable** — a fact goes stale, you fix the line. No re-embedding, no opaque store.
- **Diffable** — it lives in git. Memory changes show up in review like any other change.
- **Shareable** — commit it and your whole team's agent starts from the same context.
- **Portable** — it's plain markdown, so it survives swapping the model underneath it.

You trade automatic-everything for curation. That's the right trade when the memory is supposed to encode *decisions*, not transcripts.

## How Bandit applies it

[`BANDIT.md`](./memory.html) is the synthesized layer — a human-readable file of durable facts, kept deliberately small because it rides in every prompt. It's curated two ways: you edit it directly, and the agent appends to it with the `remember` tool when you tell it something worth keeping. The long tail that doesn't deserve a slot in every prompt lives behind a lazy topic index, pulled in only when a hook matches — synthesis up front, retrieval only for the overflow.

We hold `BANDIT.md` to a high bar on purpose: the goal is for it to be a public reference for *what good project memory looks like* — the kind of file you'd point someone at to explain the pattern. It's the same instinct as a great `CLAUDE.md` or `AGENTS.md`: a small, curated, version-controlled brain for your project.

---

## Sources

- [LLM wiki / agent memory](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — Andrej Karpathy, 2026. Memory as a compiled wiki; "synthesis, not retrieval."
- [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — Anthropic. Curating what stays in context over time.

**Next:** [Memory](./memory.html) · [Retrieval & context](./retrieval-and-context.html) · [Configuration](./configuration.html)

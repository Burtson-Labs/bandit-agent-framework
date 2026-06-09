# Memory

A fresh model knows nothing about your project. Memory is how Bandit carries the durable facts — your conventions, your architecture, the decisions you don't want to re-explain — from one session into the next.

It's deliberately simple: **plain markdown files you can read, edit, and commit.** No vector database, no opaque store. (For *why* it's built this way, see the [Memory as synthesis](./memory-as-synthesis.html) pattern.)

---

## Always-in-context: BANDIT.md

At the start of a session Bandit loads a project memory file and injects it into the system prompt under a `## Project Memory` heading. It looks for the first of these (each capped at ~32 KB):

```
BANDIT.md · CLAUDE.md · AGENTS.md · .bandit/BANDIT.md · .bandit/memory.md
```

`BANDIT.md` is just markdown — keep it tight, since it rides in *every* prompt:

```markdown
# Project Memory

## Conventions
- All repos live in ~/Documents/GitHub
- Prefer pnpm; named exports only

## Notes
- The web build stubs only fs/fs-promises — keep os/path calls lazy
```

The agent can append to it itself with the **`remember`** tool — when you say "remember X" or "always do Y", it adds a bullet under `## Notes` so the fact survives the session.

---

## On-demand: the topic index

Some knowledge is too big or too situational to keep in every prompt. For that, Bandit uses a *lazy* index. Put topic files in `.bandit/memory/<slug>.md` and list them in `.bandit/memory/MEMORY.md` with a one-line **hook** describing when each is relevant:

```markdown
# Memory Index

- [CLI ink refactor](.bandit/memory/cli-ink-refactor.md) — when changing the CLI input layer
- [MCP roadmap](.bandit/memory/mcp-roadmap.md) — when adding or debugging MCP connections
```

Only the *index* is preloaded — the hooks, not the contents. Each turn the model reads the hooks, and if one matches the task it calls the **`read_memory`** tool to pull that file's full text on demand:

```
read_memory(name="cli-ink-refactor")
```

So the always-in-context footprint stays small while an arbitrarily large knowledge base stays one tool call away. That's the whole trick: spend the prompt budget on what's relevant *now*, and index the rest.

---

## How it lands in the prompt

```
[ base system prompt ]

## Project Memory
[ BANDIT.md — always in context ]

<!-- index: call read_memory(name="…") when a hook matches -->
[ the topic hooks — contents loaded on demand ]

## Active Skills
[ … ]
```

---

## Where to set it

`BANDIT.md` lives at the repo root (committed, shared with your team). Personal or machine-specific notes can go in the global `~/.bandit/` or in gitignored workspace files. Memory is loaded automatically by the CLI and the extension; if you're building a host, `loadCombinedMemory()` in [`host-kit`](./host-kit.html) assembles the bundle for you.

**Next:** [Memory as synthesis](./memory-as-synthesis.html) · [Configuration](./configuration.html) · [How a turn works](./how-a-turn-works.html)

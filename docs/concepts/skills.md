# Skills

A [tool](./tools.html) is the unit of *execution*. A **skill** is the unit of *packaging and activation* — a bundle of related tools plus the guidance and the rules for when they should be available.

Why the split? Because not every tool belongs in every turn. Loading all of them all the time bloats the prompt and gives the model too many ways to go wrong. Skills let the runtime put the *right* tools in front of the model for *this* task and leave the rest out.

---

## The shape of a skill

```ts
import type { SkillManifest } from "@burtson-labs/agent-core";

export const codeReviewSkill: SkillManifest = {
  id: "review/code-review",
  name: "Code review",
  version: "1.0.0",
  description: "Review changes for bugs, style, and risk.",
  instructions: "When reviewing, read the diff first, then the surrounding code…",
  activation: "auto",
  triggerPatterns: [/\breview\b/i, /\bcode review\b/i, /\blint\b/i],
  tools: [/* the tools this skill contributes */]
};
```

- **`description`** goes into the system prompt so the model knows the skill exists.
- **`instructions`** (optional) is longer prose injected *only when the skill activates* — task-specific guidance that would be noise the rest of the time.
- **`tools`** are added to the turn's registry when the skill is active.
- **`activation`** decides when that happens.

---

## Activation

| Mode | When it activates |
|---|---|
| `always` | Every turn, regardless of the prompt. |
| `auto` | When the user's prompt matches one of the skill's `triggerPatterns`. |
| `on-demand` | Only when the host explicitly includes it. |

The registry resolves the active set per turn, then assembles a `ToolRegistry` from just those skills:

```ts
const active = registry.resolveActiveSkills(userPrompt);   // always + matching auto skills
const tools = registry.buildToolRegistry(active);          // the tools the model will see
```

This is context engineering in miniature: the prompt only ever describes the tools that matter right now.

---

## What ships built in

`createDefaultSkillRegistry()` gives you seven:

- **`core/filesystem`** and **`core/git`** — `always`. The file, shell, and git tools every turn needs.
- **`review/code-review`** — `auto` on *review / lint*.
- **`testing/test-gen`** — `auto` on *test*.
- **`agent/plan`** — `auto` on *refactor / plan / design / architecture*.
- **`search/semantic`** — `auto` on *how does / where is* (embedding-backed code search — see [Retrieval & context](./retrieval-and-context.html)).
- **`mail/search`** — `auto` on *email / gmail* (bridges to an [MCP](./mcp.html) mail server).

---

## Authoring your own

Drop a markdown file in `.bandit/skills/<name>.md` with YAML frontmatter and prose instructions:

```markdown
---
id: house/style
name: House style
description: Apply our team's code conventions.
activation: auto
triggers: ["style", "convention", "format"]
---

Always use named exports. Prefer composition over inheritance.
Run `pnpm lint --fix` after edits.
```

A markdown skill doesn't declare tools — it *guides the agent on how to use the tools it already has*. That covers most needs: codifying conventions, workflows, and house rules. When you need a skill that contributes brand-new behavior, that's a tool — see [Writing a custom tool](./writing-a-custom-tool.html).

**Next:** [Tools](./tools.html) · [Writing a custom tool](./writing-a-custom-tool.html) · [Memory](./memory.html)

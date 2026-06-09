# Tools

Tools are what the agent can *do*. The model reasons in text; a tool is the bridge from that text to a real action — reading a file, running a command, searching the web. Everything the agent accomplishes, it accomplishes by calling a tool.

---

## The shape of a tool

A tool is a small object: a name the model calls, a description it reads to decide *when* to call it, a typed parameter list, and a handler that does the work.

```ts
import type { AgentTool, ToolExecutionContext, ToolResult } from "@burtson-labs/agent-core";

const wordCount: AgentTool = {
  name: "word_count",
  description: "Count the words in a workspace file.",
  parameters: [
    { name: "path", description: "File to count, relative to the workspace.", required: true, schema: { type: "string" } }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const text = await ctx.readFile(params.path);
    return { output: `${text.trim().split(/\s+/).length} words` };
  }
};
```

A few deliberate choices:

- **Parameters use a JSON-Schema-shaped `schema`, not Zod.** That keeps tool definitions portable across providers — the same tool works whether the model calls it via native function-calling or Bandit's text protocol. Omit `schema` and a parameter is treated as a string.
- **The handler returns `{ output, isError? }`.** `output` is the text fed back to the model; set `isError: true` on failure so the loop knows the call didn't succeed.
- **The host hands you a `ToolExecutionContext`.** That's how a tool touches the outside world — `readFile`, `writeFile`, `runCommand`, `searchCode`, `listFiles`, and more. The context is supplied by the environment adapter, so the *same* tool runs in Node, a browser sandbox, or the VS Code extension without change.

---

## The registry

Tools live in a `ToolRegistry`. The registry is what the runtime turns into the prompt the model sees — either an XML tool block (text protocol) or a native tools schema (Ollama function-calling), chosen per model.

```ts
import { ToolRegistry } from "@burtson-labs/agent-core";

const registry = new ToolRegistry();
registry.register(wordCount);
```

In practice you rarely build a registry by hand — [skills](./skills.html) assemble it for you from the tools relevant to the turn.

---

## What ships built in

`agent-core` ships the tools an agent needs to work in a codebase, grouped into [skills](./skills.html):

| Group | Tools |
|---|---|
| **Filesystem & shell** (always on) | `read_file`, `write_file`, `apply_edit`, `replace_range`, `apply_patch`, `ls`, `list_files`, `find_directory`, `search_code`, `run_command`, `watch_command` |
| **Git** (always on) | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_branch`, `git_checkout`, `git_stash`, `git_pull`, `git_push` |

The editing tools are layered on purpose: `apply_edit` does fuzzy find/replace, `replace_range` does line-addressed edits for big files, and `apply_patch` applies multi-file diffs. Write tools guard against overwriting a file the agent hasn't read.

## Drop-in tools from host-kit

[`host-kit`](./host-kit.html) ships higher-level tools you opt into:

```ts
import { buildWebSearchTool, buildWebFetchTool, buildTaskTool, buildTestRunTool } from "@burtson-labs/host-kit";

registry.register(buildWebSearchTool({ apiKey }));  // web_search   — Tavily-backed search
registry.register(buildWebFetchTool());             // web_fetch    — fetch a URL as clean text
registry.register(buildTestRunTool());              // test_run     — detect the test framework + run it
registry.register(buildTaskTool({ /* … */ }));      // task         — spawn a focused subagent
```

There's also `todo_write` (a working checklist), and the memory tools `remember` and `read_memory` — see [Memory](./memory.html). Web tools have a built-in SSRF guard that blocks private and loopback addresses.

---

## Gating

Every tool call is checked before it runs: the opt-in [security guard](./configuration.html), then your `PreToolUse` hooks, then the approval prompt. Any of them can block the call. That gate is the same regardless of who wrote the tool — see [How a turn works](./how-a-turn-works.html).

**Next:** [Writing a custom tool](./writing-a-custom-tool.html) · [Skills](./skills.html) · [How a turn works](./how-a-turn-works.html)

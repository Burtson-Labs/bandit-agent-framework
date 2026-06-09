# Writing a custom tool

This walks through building a real [tool](./tools.html) end to end — defining it, giving it access to the workspace, registering it, and getting the model to call it. We'll build `find_todos`: a tool that surfaces every `TODO` / `FIXME` / `HACK` comment in a codebase.

> A tool adds a *new capability*. If you only want to give the agent guidance or codify a workflow with the tools it already has, you want a [skill](./skills.html) — and for the shipped CLI/extension, a markdown skill or an [MCP connector](./mcp.html) needs no build step. See [No-build options](#no-build-options) at the end.

---

## 1. Define the tool

A tool is an object with four parts: a `name` the model calls, a `description` it reads to decide *when* to call it, typed `parameters`, and an `execute` handler.

```ts
import type { AgentTool, ToolExecutionContext, ToolResult } from "@burtson-labs/agent-core";

export const findTodos: AgentTool = {
  name: "find_todos",
  description:
    "Find TODO / FIXME / HACK comments in the workspace. Use when the user asks " +
    "about outstanding work, tech debt, or unfinished code.",
  parameters: [
    { name: "tag",  description: "Marker to search for. Defaults to TODO|FIXME|HACK.", required: false, schema: { type: "string" } },
    { name: "path", description: "Optional sub-directory to limit the search.",        required: false, schema: { type: "string" } }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    return { output: "" }; // filled in next
  }
};
```

The `description` is the most important line you'll write — it's the only thing the model sees when deciding whether this tool fits the task. Write it like a function doc: what it does *and when to reach for it*.

## 2. Touch the workspace through the context

The handler never talks to the filesystem directly — it goes through the `ToolExecutionContext` the host provides. That's what makes the tool portable: the same code runs in Node, the VS Code extension, or a browser sandbox, because the host supplies the right context. Here we use `searchCode`:

```ts
async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
  const tag = params.tag?.trim() || "TODO|FIXME|HACK";
  const matches = await ctx.searchCode(`(${tag})`, params.path);   // returns "path:line: content"
  if (!matches.trim()) return { output: `No ${tag} comments found.` };

  const count = matches.trim().split("\n").length;
  return { output: `${count} match(es):\n${matches}` };
}
```

`ctx` gives you `readFile`, `writeFile`, `listFiles`, `searchCode`, `runCommand`, and more — the whole [Tools](./tools.html) context surface.

## 3. Return results the model can use

`execute` returns `{ output, isError? }`. `output` is text fed straight back into the conversation, so make it readable — the model reads it the way you'd read terminal output. On failure, set `isError: true` so the loop knows the call didn't succeed and can react:

```ts
try {
  const matches = await ctx.searchCode(`(${tag})`, params.path);
  // …
} catch (err) {
  return { output: `Search failed: ${String(err)}`, isError: true };
}
```

## 4. Register it

Tools reach the agent through a [skill](./skills.html). Bundle yours into a `SkillManifest` and register it:

```ts
import { SkillRegistry, type SkillManifest } from "@burtson-labs/agent-core";

export const todoSkill: SkillManifest = {
  id: "custom/todos",
  name: "TODO finder",
  version: "1.0.0",
  description: "Locate outstanding TODO/FIXME/HACK comments.",
  activation: "always",          // or "auto" with triggerPatterns
  tools: [findTodos]
};

const registry = new SkillRegistry();
registry.register(todoSkill);

const active = registry.resolveActiveSkills(userPrompt);
const toolRegistry = registry.buildToolRegistry(active);   // find_todos is now in scope
```

In a full host you hand that registry to the runtime when you build it — see [Build your own host](./build-your-own-host.html) for wiring it into `createStealthRuntime` or `createAgentRuntime`.

## 5. See it get called

With the skill active, the model now sees `find_todos` in its tool list and calls it when the prompt fits:

```
> what's left to finish in src/auth?

  → find_todos(tag="TODO|FIXME", path="src/auth")
  ← 3 match(es):
    src/auth/login.ts:42: // TODO: rate-limit failed attempts
    …
```

If the model *isn't* calling it when you expect, the fix is almost always the `description`, not the code — tighten the "use this when…" sentence.

---

## No-build options

You don't always need to write TypeScript:

- **Markdown skill** — drop a `.bandit/skills/<name>.md` file to guide the agent with the tools it already has. No build, works in the shipped CLI and extension. See [Skills](./skills.html).
- **MCP connector** — point Bandit at an [MCP server](./mcp.html) and its tools join the registry automatically. Best when the capability already exists as a server (Slack, GitHub, a database).

Reach for a custom tool when the capability is genuinely new and lives in your own code.

**Next:** [Tools](./tools.html) · [Skills](./skills.html) · [Build your own host](./build-your-own-host.html)

# MCP connectors

The [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is an open standard for exposing tools and data to an agent over a uniform interface. Point Bandit at an MCP server and its tools join the same registry the agent already uses — Slack, GitHub, Google, a database, your own server, all without writing a [tool](./tools.html) for each.

---

## Configuring servers

List servers in `mcp-servers.json` — global (`~/.bandit/`) and workspace (`.bandit/`), with workspace winning on a name clash:

```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-slack"],
      "env": { "SLACK_BOT_TOKEN": "xoxb-…" }
    },
    "remote": {
      "url": "https://your-mcp-server.example.com/mcp",
      "auth": { "type": "bearer", "token": "…" }
    }
  }
}
```

Two transports:

- **stdio** — Bandit spawns `command` + `args` as a child process and speaks MCP over its stdin/stdout. `env` is passed through (and never logged).
- **Streamable HTTP** — set `url` instead and Bandit connects to a remote server. `auth` can be `"bandit"` (reuse your Bandit API key), a static `bearer` token, or a custom `header`.

If a server needs your Bandit key, you don't have to duplicate it: Bandit **auto-injects `BANDIT_API_KEY`** into stdio servers from your config, so one sign-in covers both the provider and your connectors.

---

## How tools get bridged

Nothing spawns at startup. The first time a server's tools are actually needed, Bandit connects, handshakes, and discovers its tools — then registers each one **namespaced** as `<server>.<tool>` so it can't collide with a built-in:

```
slack.post_message   github.create_issue   burtson.search_docs
```

JSON-Schema parameters (including nested objects and arrays) are preserved, not flattened, so the model calls MCP tools with the same fidelity as native ones. A spawn or handshake failure is isolated — it's recorded and the session keeps running rather than breaking.

---

## Activation and trust

A server can be `"always"` on, or `"on-mention"` — registered only when its name or one of its `triggers` appears in your prompt, so a dozen configured servers don't crowd every turn:

```json
{ "mcpServers": { "jira": { "command": "…", "activation": "on-mention", "triggers": ["ticket", "sprint"] } } }
```

Before a server is first launched, Bandit can run it past a trust gate. Servers are **fingerprinted** by a stable hash of their config — command, args, env *keys* (not values), or URL and auth kind — so rotating a token doesn't re-prompt you, but changing what actually runs does.

For the building blocks behind this — the client pool and the tool adapter — see [`host-kit`](./host-kit.html).

**Next:** [Tools](./tools.html) · [The agent loop](./the-agent-loop.html) · [Configuration](./configuration.html)

# Configuration

Bandit reads three files, all optional, all JSON. Nothing is required for a first run — defaults work out of the box.

| File | Scope | What it holds |
|---|---|---|
| `~/.bandit/config.json` | global (you) | provider, model, credentials, telemetry |
| `.bandit/config.json` | workspace (the repo) | per-project overrides, committed |
| `.bandit/config.local.json` | workspace, gitignored | personal per-project overrides |
| `~/.bandit/settings.json` + `.bandit/settings.json` | global + workspace | hooks, permissions, the security guard |
| `mcp-servers.json` | global + workspace | MCP servers |

**Precedence** (highest wins): CLI flags → environment variables → `config.local.json` → workspace `config.json` → global `config.json` → defaults.

---

## config.json

```json
{
  "provider": "bandit",
  "model": "bandit-logic",

  "ollama":  { "url": "http://localhost:11434" },
  "bandit":  { "apiKey": "bai_…", "apiUrl": "https://api.burtson.ai" },
  "openai":  { "baseUrl": "https://api.example.com/v1", "apiKey": "…", "model": "…" },

  "repos":   { "roots": ["~/work", "~/code"] },
  "coauthor": false,
  "notifications": { "desktop": true, "sound": false },
  "tools":   { "tavily": { "apiKey": "tvly-…" } },

  "telemetry": {
    "enabled": true,
    "endpoint": "https://otel.your-company.com",
    "mode": "metrics+traces"
  }
}
```

- **`provider`** — `ollama` (local), `bandit` (cloud), or `openai-compatible`.
- **`model`** — defaults per provider (`gemma4:e4b` for Ollama, `bandit-logic` for cloud); for OpenAI-compatible you must set it.
- **`ollama` / `bandit` / `openai`** — the connection details for whichever provider you use; each also takes `headers` for auth proxies.
- **`repos.roots`** — extra folders the `find_directory` tool can discover.
- **`telemetry`** — opt-in OpenTelemetry. `mode: "metrics-only"` drops traces; prompts/responses are never sent. See [How a turn works](./how-a-turn-works.html).

---

## Environment variables

Handy for CI and per-shell overrides — they beat the files:

| Variable | Sets |
|---|---|
| `BANDIT_PROVIDER`, `BANDIT_MODEL` | provider + model |
| `BANDIT_API_KEY`, `BANDIT_API_URL` | Bandit cloud credentials |
| `OLLAMA_URL` | Ollama endpoint |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | OpenAI-compatible endpoint |
| `TAVILY_API_KEY` | web search |
| `BANDIT_TELEMETRY`, `BANDIT_OTLP_ENDPOINT`, `BANDIT_OTLP_MODE`, `BANDIT_OTLP_TOKEN` | telemetry on/off + target |
| `BANDIT_NOTIFY`, `BANDIT_NOTIFY_SOUND` | desktop notifications |

---

## settings.json — hooks, permissions, the guard

The global `~/.bandit/settings.json` is merged **under** the workspace `.bandit/settings.json`, so anything you configure once applies to every repo, with per-project files layering on top.

```json
{
  "security": {
    "guard": {
      "enabled": true,
      "blockCommands": ["terraform destroy"],
      "protectPaths": ["infra/"]
    }
  },
  "hooks": {
    "PostToolUse": [{ "command": "prettier --write {{primary}}" }]
  }
}
```

- **`security.guard`** — an opt-in, in-process safety net that blocks catastrophic tool calls (`rm -rf /`, `curl … | sh`, disk wipes, credential exfil, writes to system/credential paths) before they run. Extend it with `blockCommands` / `protectPaths`. Off by default.
- **`hooks`** — shell commands at lifecycle points. `PreToolUse` can **block** (non-zero exit aborts the call); `PostToolUse` / `Stop` / `UserPromptSubmit` are fire-and-forget — great for formatters, version bumps, notifications, CI triggers. Placeholders: `{{name}}`, `{{primary}}`, `{{duration}}`. Full reference in [`host-kit`](./host-kit.html).
- **`permissions`** — allow/deny rules so trusted tools skip the approval prompt.

---

## mcp-servers.json — Model Context Protocol

Point Bandit at MCP servers (global + workspace, workspace wins). Bandit injects `BANDIT_API_KEY` and registers each server's tools into the same registry the agent already uses. See [`host-kit`](./host-kit.html) for the loader.

**Next:** [Build your own host](./build-your-own-host.html) · [How a turn works](./how-a-turn-works.html)

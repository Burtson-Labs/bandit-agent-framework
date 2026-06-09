# Providers & models

Bandit is **model-agnostic**: the same agent runs on a local model through Ollama, on an OpenAI-compatible endpoint, or on the Bandit cloud gateway. You switch with one config line, and you're never locked to a vendor.

Two pieces make that work — a thin **provider** contract that abstracts *where* a model runs, and a **model catalog** that tells the runtime *how* to drive each model well.

---

## The provider contract

A provider is intentionally tiny — one streaming method:

```ts
interface ProviderClient {
  readonly name: string;
  chat(prompt: string, options?: ProviderChatOptions): AsyncIterable<string>;
}
```

Three implementations ship:

| Provider | Runs against | Auth |
|---|---|---|
| **Ollama** | a local model on your machine (`http://localhost:11434`) | none |
| **OpenAI-compatible** | any `/chat/completions` endpoint — LM Studio, vLLM, OpenRouter, Together, Groq, … | API key |
| **Bandit cloud** | the Bandit gateway (`api.burtson.ai`) | `BANDIT_API_KEY` |

Because the contract is so small, writing a fourth provider is a short afternoon — anything that can stream text qualifies.

---

## Switching providers

Set it in [config](./configuration.html), or override per-shell with env vars:

```json
{ "provider": "ollama",  "model": "gemma4:e4b" }
{ "provider": "openai-compatible", "model": "…", "openai": { "baseUrl": "http://localhost:1234/v1", "apiKey": "…" } }
{ "provider": "bandit",  "model": "bandit-logic" }
```

```bash
BANDIT_PROVIDER=ollama BANDIT_MODEL=qwen2.5-coder:14b bandit
```

Building a host? Pass a `providerClient` straight into `createStealthRuntime` — see [Build your own host](./build-your-own-host.html).

---

## Why the catalog matters

Here's the part most frameworks skip. A 4B local model and a frontier cloud model are not interchangeable: they have different context windows, different tool-calling reliability, and different failure modes. Sending all of them the same prompt gets you inconsistent results.

Bandit keeps two profiles per model so the runtime can adapt:

**Capabilities** — what the model *can* do:

- `contextWindow` — usable tokens (8K → 256K)
- `supportsToolCalling` — native function-calling vs not
- `supportsVision` — image input
- `tier` — `small` / `medium` / `large`, used to size budgets and prompt complexity

**Behavior** — how the runtime *drives* it:

- `protocol` — native tool-calling or Bandit's **text-based tool protocol**, plus the fallback to try when the preferred one fails (small models fumble native calls; the text protocol is steadier)
- `thinking` — `on` / `off` / `auto` for reasoning-channel models
- `context` — the input budget before [compaction](./how-a-turn-works.html) kicks in, and the per-turn output budget
- `prompting` — the prompt template and how many in-context examples to include
- `reliability` — how many tools to call in parallel, which upstream errors to retry, and known failure modes to surface in the UI

Lookup is longest-prefix on the model id, with sensible defaults for anything unknown — so a model the catalog has never seen still runs.

This is why the same goal behaves consistently across Gemma, Qwen, Llama, GPT, and Claude: the prompt is the same, but the *strategy* around it is chosen per model. See [How a turn works](./how-a-turn-works.html) for the guardrails those profiles drive.

**Next:** [How a turn works](./how-a-turn-works.html) · [Configuration](./configuration.html) · [Build your own host](./build-your-own-host.html)

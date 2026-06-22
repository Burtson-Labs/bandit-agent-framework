# Gateway API Contract
## Overview
The gateway centralizes every provider integration behind a single authenticated endpoint. Bandit Engine forwards chat, generation, memory, and health requests without leaking provider credentials to the browser. This contract is language agnostic—implement it in Node.js, Python, Go, .NET, or any platform that can speak HTTP.

Every request must include `Authorization: Bearer <token>`. Tokens are injected by Bandit Engine via Axios interceptors, so your gateway only needs to validate the credential and map it to your auth system.

## Endpoint Overview
### Core routes
| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/health` | GET | Returns gateway uptime, provider availability, and semantic version. |
| `/api/models` | GET | Lists models available across providers with metadata consumed by the management UI. |
| `/api/models/:provider` | GET | Lists models for a specific provider (e.g. `/api/models/openai`). |
| `/api/memory` | GET | Optional endpoint that returns stored memory records for the active tenant. |
| `/api/chat/completions` | POST | Streams chat responses using Server-Sent Events or chunked JSON when no provider override is set. |
| `/api/generate` | POST | Handles non-chat text generation and returns chunked JSON for streaming when no provider override is set. |
| `/api/feedback` | POST | (Optional) Collects in-app feedback and attachments. |
| `/api/tts`, `/api/stt`, `/api/tts/available-models` | POST/GET | Optional voice endpoints for advanced deployments. |

### Provider-specific chat/generation routes
When the UI specifies a provider (Bandit AI, OpenAI, Azure OpenAI, Anthropic, Ollama), Bandit Engine switches to provider-scoped endpoints automatically. Implement these routes alongside the core ones above:

| Provider | Chat endpoint | Generation endpoint |
| --- | --- | --- |
| Bandit AI | `POST /api/bandit/chat/completions` | `POST /api/bandit/generate`* |
| OpenAI | `POST /api/openai/chat/completions` | `POST /api/openai/generate` |
| Azure OpenAI | `POST /api/azure-openai/chat/completions` | `POST /api/azure-openai/generate` |
| Anthropic | `POST /api/anthropic/chat/completions` | `POST /api/anthropic/generate` |
| Ollama | `POST /api/ollama/chat` | `POST /api/ollama/generate` |

> ℹ️ Bandit still includes the `provider` field in the request body for convenience, but the URL itself determines which upstream integration should run. Ollama uses `/chat` (not `/chat/completions`) to match its native API.  
> \* `POST /api/bandit/generate` is optional today but mirrors the shape of `/api/chat/completions` for parity with other providers.

If you only support a single upstream provider you may implement the matching provider-specific endpoints and omit the others. The `/api/chat/completions` and `/api/generate` routes remain useful as a “default” path when the frontend has no explicit provider preference.

## Example Implementation
```ts
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    providers: ["bandit", "openai", "ollama"],
    version: "1.0.0"
  });
});

app.post("/api/bandit/chat/completions", async (req, res) => {
  const response = await fetch(`${process.env.GATEWAY_URL}/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.BANDIT_API_KEY}`
    },
    body: JSON.stringify(req.body)
  });

  res.status(response.status);
  response.body?.pipe(res);
});

app.post("/api/openai/chat/completions", async (req, res) => {
  const { model, messages, stream = true } = req.body;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_KEY}`
    },
    body: JSON.stringify({ model, messages, stream })
  });

  res.status(response.status);
  response.body?.pipe(res);
});

app.post("/api/ollama/chat", async (req, res) => {
  const { model, messages, stream = true } = req.body;

  const response = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream })
  });

  res.status(response.status);
  response.body?.pipe(res);
});

// Optional default handler when no provider override is supplied
app.post("/api/chat/completions", async (req, res) => {
  const { model, messages, stream = true } = req.body;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_KEY}`
    },
    body: JSON.stringify({ model, messages, stream })
  });

  res.status(response.status);
  response.body?.pipe(res);
});
```
See [`examples/gateway-node`](../examples/gateway-node) for a complete runnable server with environment configuration and npm scripts.

## Integration Notes
- **Streaming**: Preserve chunked responses when proxying to providers. The client will parse each `data:` line.
- **Provider-specific routes**: Bandit Engine automatically swaps endpoints such as `/api/ollama/chat` or `/api/openai/chat/completions` when a provider is specified (see table above).
- **Error handling**: Return structured JSON with `message` and `details` to take advantage of the engine's notification system.
- **Security**: Perform rate limiting, audit logging, and token verification on the gateway—never in the browser.

## Related Files
- [`src/services/gateway/gateway.service.ts`](../src/services/gateway/gateway.service.ts)
- [`src/types/gateway.ts`](../src/types/gateway.ts)
- [`docs/03_provider_integration.md`](./03_provider_integration.md)

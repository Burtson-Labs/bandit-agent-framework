# Provider Integration Patterns
## Overview
Bandit Engine routes every model invocation through your gateway but preserves provider-specific capabilities such as multimodal prompts, Azure deployment parameters, and local Ollama streaming. This guide summarizes the nuances for each supported provider and how to combine them with Bandit's feature flag system.

## Endpoints / API Usage
- `POST /api/{provider}/chat/completions` — automatically selected when `provider` is set to `bandit`, `openai`, `azure-openai`, `anthropic`, or `xai`.
- `POST /api/{provider}/generate` — optional non-chat endpoint for custom workloads.
- `GET /api/models/{provider}` — provider-specific model listing exposed in the management UI.

## Example Implementation
```ts
import { GatewayProvider } from "@burtson-labs/bandit-engine";

const provider = new GatewayProvider({
  provider: "bandit",
  gatewayUrl: "https://gateway.example.com",
  tokenFactory: () => localStorage.getItem("authToken") ?? ""
});

provider.listModelsByProvider("bandit").subscribe(models => {
  console.log("Bandit models", models.map(model => model.name));
});
```

### Provider Notes
- **Bandit AI**: Accepts OpenAI-format requests and automatically normalizes aliases such as `bandit-core-1`. Supports both auth tokens (UI) and API keys (CLI/partner usage) through the gateway.
- **OpenAI & Azure OpenAI**: Send images as `image_url` entries alongside text segments. Azure requires `deploymentName` and `apiVersion` within the gateway configuration.
- **Anthropic**: Supports the same streaming pipeline with Claude models and structured responses.
- **Ollama**: Keeps images on the final user message through the `images` array and exposes `/api/ollama/chat` plus `/api/ollama/generate` endpoints.

## Integration Notes
- Use the feature flag system to expose premium providers only to subscribed tenants. See [`docs/05_contributing.md`](./05_contributing.md) for contribution standards around feature gates.
- When enabling vector memory, pair provider selection with the semantic search guide in [`docs/04_local_dev.md`](./04_local_dev.md).
- Always log provider selections on the gateway for observability and quota tracking.

## Related Files
- [`src/services/ai-provider/providers/gateway.provider.ts`](../src/services/ai-provider/providers/gateway.provider.ts)
- [`src/services/gateway/openai-gateway.service.ts`](../src/services/gateway/openai-gateway.service.ts)
- [`src/services/vectorDatabase`](../src/services/vectorDatabase)

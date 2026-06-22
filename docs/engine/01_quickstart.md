# Quickstart
## Overview
Get Bandit Engine running locally in less than five minutes. This guide walks through installation, configuration, and verification using the provided gateway example.

## Endpoints / API Usage
The quickstart gateway exposes the contract Bandit expects out of the box:
- `GET /api/health` — confirm connectivity and list configured providers.
- `GET /api/models` and `GET /api/models/:provider` — populate the model switcher and provider tabs.
- `POST /api/chat/completions` and `POST /api/generate` — default OpenAI-style chat/generation when no provider override is supplied.
- `POST /api/bandit/chat/completions` — Bandit AI chat completions (OpenAI-compatible).
- `POST /api/openai|azure-openai|anthropic/chat/completions` — provider-scoped chat completions.
- `POST /api/openai|azure-openai|anthropic/generate` — provider-scoped text generation.
- `POST /api/ollama/chat` and `POST /api/ollama/generate` — native Ollama streaming routes.

## Example Implementation
1. **Install dependencies**:
   ```bash
   npm install @burtson-labs/bandit-engine
   npm install @tanstack/react-query @mui/material @emotion/react @emotion/styled zustand react react-dom
   ```
2. **Bootstrap the gateway** (optional but recommended):
   ```bash
   cd packages/bandit-engine/examples/gateway-node
   npm install
   npm run dev
   ```
   The example server listens on `http://localhost:8080` and proxies to Bandit AI, OpenAI, Azure OpenAI, Anthropic, or Ollama using provider-scoped endpoints. Providers without credentials respond with `501` until you wire them up.
3. **Wrap your app with `ChatProvider`**:
   ```tsx
   import { ChatProvider } from "@burtson-labs/bandit-engine";

   <ChatProvider
     packageSettings={{
       gatewayApiUrl: "http://localhost:8080/api",
       defaultModel: "bandit-core-1",
       brandingConfigUrl: "/config.json",
       aiProvider: {
         type: "gateway",
         gatewayUrl: "http://localhost:8080/api",
         provider: "bandit"
       }
     }}
   >
     {/* your routes */}
   </ChatProvider>
   ```
4. **Verify connectivity** using the provided hooks:
   ```tsx
   import { useGatewayHealth, useGatewayModels } from "@burtson-labs/bandit-engine";

   const { data: health } = useGatewayHealth();
   const { data: models } = useGatewayModels();
   ```

## Integration Notes
- Update the `gatewayApiUrl` to point at your production gateway before deployment.
- Store API keys on the gateway server; never expose them in the browser bundle.
- Use the docs in [`docs/04_local_dev.md`](./04_local_dev.md) to enable optional services like vector memory and voice.

## Related Files
- [`docs/02_gateway_api.md`](./02_gateway_api.md)
- [`docs/03_provider_integration.md`](./03_provider_integration.md)
- [`examples/gateway-node`](../examples/gateway-node)

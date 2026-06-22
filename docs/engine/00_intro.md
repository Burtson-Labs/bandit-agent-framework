# Bandit Engine Overview
## Overview
Bandit Engine is the client framework that powers the Bandit conversational AI experience. It delivers a production-ready chat interface, management console, and integration utilities while keeping proprietary infrastructure behind your own gateway. The library ships as a TypeScript-first React package published as `@burtson-labs/bandit-engine` under the Business Source License (BUSL-1.1).

## Endpoints / API Usage
Bandit Engine communicates with a customer-hosted **gateway API**. The minimum required endpoints are:
- `GET /api/health` — service heartbeat and provider inventory
- `GET /api/models` — aggregated model catalog for the UI
- `GET /api/memory` — persisted conversation memory (optional but recommended)
- `POST /api/chat/completions` — streaming chat completion pipeline
- `POST /api/generate` — non-chat text generation requests

Additional voice and feedback endpoints are documented throughout this guide. All requests include a Bearer token provided by the host application and never expose provider API keys in the browser.

## Example Implementation
See [`docs/02_gateway_api.md`](./02_gateway_api.md) for the canonical gateway contract and [`examples/gateway-node`](../examples/gateway-node) for a runnable Node.js gateway implementation.

## Integration Notes
- Install Bandit Engine in any React 18+ project and wrap your tree with `ChatProvider`.
- Provide a `gatewayApiUrl` plus optional branding and feature-flag configuration.
- Keep your production gateway private; only the package contents under `packages/bandit-engine` are published to npm.

## Related Files
- [`README.md`](../README.md)
- [`docs/01_quickstart.md`](./01_quickstart.md)
- [`docs/06_busl_licensing.md`](./06_busl_licensing.md)

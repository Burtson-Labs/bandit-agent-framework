# Local Development & Advanced Services
## Overview
This guide describes how to run Bandit Engine locally with optional services including vector memory, document ingestion, and voice features. Use it to simulate production behaviour while keeping sensitive credentials on your machine.

## Endpoints / API Usage
- `GET /api/memory` — synchronize long-term memory between IndexedDB and your gateway or vector database.
- `POST /api/tts` & `POST /api/stt` — enable voice experiences.
- `POST /api/vector/migrate` — optional endpoint to migrate stored knowledge to a managed vector index.

## Example Implementation
```bash
# Clone the repository and install dependencies
npm install

# Start the example gateway
cd packages/bandit-engine/examples/gateway-node
npm install
npm run dev

# Launch the Bandit site in development mode (private app)
npm run dev:development
```

Within your app, enable vector support when available:
```ts
import { useVectorStore } from "@burtson-labs/bandit-engine";

const { isVectorEnabled, performMigration } = useVectorStore();

if (!isVectorEnabled) {
  await performMigration();
}
```

## Integration Notes
- Configure environment variables such as `VITE_GATEWAY_API_URL`, `VITE_FILE_STORAGE_API_URL`, and `VITE_DEFAULT_MODEL` in `.env.local`.
- Feature flags can be toggled per tier to expose advanced services only to entitled users.
- Vector migrations fall back to IndexedDB when the gateway is unavailable, ensuring your teams never lose data.

## Related Files
- [`src/services/vectorDatabase`](../src/services/vectorDatabase)
- [`src/hooks/useVoices.ts`](../src/hooks/useVoices.ts)
- [`docs/03_provider_integration.md`](./03_provider_integration.md)

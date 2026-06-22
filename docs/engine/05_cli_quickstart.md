# Bandit CLI Quick Start

The Bandit CLI ships with this package and scaffolds a ready-to-run playground complete with a Vite + React frontend, Bandit Engine wiring, and a lightweight Express gateway. Use it when you want to see the engine in action or hand teammates a reproducible starting point.

## Requirements

- Node.js 18 or newer
- npm (or any package manager that can run npm scripts)

## Create a project

```bash
npx @burtson-labs/bandit-engine create my-bandit-app
```

When the CLI finishes you will have a directory that contains:

- `src/` — a Vite + React app with `ChatProvider`, `Chat`, and a launchable modal
- `public/config.json` — branding + persona defaults that load at runtime
- `server/gateway.js` — Express proxy for OpenAI or Ollama
- `.env.example` — environment flags for the frontend and gateway
- `.npmrc` — legacy registry config for older private builds; once the npm package is public you can delete this file or ignore it

Run the following commands to start development:

```bash
cd my-bandit-app
npm install
cp .env.example .env
npm run dev
```

The script runs the gateway and the frontend concurrently. Visit `http://localhost:5183` and start chatting.

> **Authentication**
> Public releases install from `registry.npmjs.org` and do not require any special npm token. If you are working from an older scaffold that still points to GitHub Packages, either update the registry line to `https://registry.npmjs.org/` or remove the `.npmrc` file.

## Common options

| Flag | Description |
| ---- | ----------- |
| `--branding-text <text>` | Sets the UI label for the assistant. |
| `--frontend-port <number>` | Changes the Vite dev server port (defaults to `5183`). |
| `--gateway-port <number>` | Changes the Express gateway port (defaults to `8080`). |
| `--yes` / `--skip-prompts` | Skips interactive questions and accepts defaults. |
| `--force` | Overwrites the target directory if it already contains files. |

Examples:

```bash
npx @burtson-labs/bandit-engine create bandit-dashboard \
  --branding-text "Bandit Ops" \
  --frontend-port 5190 \
  --gateway-port 9090
```

The CLI validates the target directory (use `--force` to overwrite), seeds `public/config.json` with a branded display name, and writes the selected ports into `.env.example`. Adjust those values any time to suit your environment.

## Configure .env for Ollama

Prefer Ollama over OpenAI? After copying `.env.example` to `.env`, replace the provider and model variables:

```ini
VITE_GATEWAY_PROVIDER=ollama
VITE_DEFAULT_MODEL=llava:latest # or any model installed on your Ollama host
VITE_FALLBACK_MODEL=gemma2:9b-instruct # optional, useful for text-only fallbacks
OLLAMA_URL=http://localhost:11434
```

Pull the models you reference with `ollama pull llava:latest`, `ollama pull gemma2:9b-instruct`, or any custom tags you maintain. Bandit automatically leverages multimodal Ollama builds (LLaVA, Gemma vision, Moondream, etc.), so image uploads are routed to models that understand them.

## Gateway behaviour

The generated `server/gateway.js` demonstrates the minimal contract described in [`docs/02_gateway_api.md`](./02_gateway_api.md):

- `GET /api/health` responds with version and provider summary.
- `GET /api/models` returns the `BASE_GATEWAY_MODELS` entries for management UI usage.
- `POST /api/chat/completions` proxies to the selected provider (OpenAI or Ollama).
- `POST /api/generate` handles non-chat prompts.

Extend the gateway to add authentication, logging, or additional providers before shipping to production.

## Next steps

- Update `.env` with an `OPENAI_API_KEY` or point `OLLAMA_URL` at your local server.
- Adjust `public/config.json` to fine-tune branding, default personas, or knowledge docs.
- Deploy the gateway somewhere secure and point `VITE_GATEWAY_URL` at it for production builds.

# Bandit API

The Bandit API is an **OpenAI-compatible** HTTP API for Bandit's first-party
models. If you've called OpenAI's `chat/completions`, you already know the shape:
point your base URL at your Bandit gateway, send a `model` from the
[catalogue](api-models.html), and Bandit handles routing, scaling, and keeping
your data private.

## Base URL

All requests go to the Bandit API:

```
https://api.burtson.ai/api/chat/completions
```

The API is OpenAI-compatible, so any OpenAI client library works — just point its
base URL here and use your Bandit API key.

## Authentication

Send a bearer token on every request:

```
Authorization: Bearer $BANDIT_API_KEY
```

Two credential types are accepted:

- **Auth tokens** — short-lived tokens issued to signed-in users in the web app and CLI.
- **API keys** — long-lived keys for server-to-server, CLI, and partner usage.

## Making a request

```bash
curl https://api.burtson.ai/api/chat/completions \
  -H "Authorization: Bearer $BANDIT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "bandit-core",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Say hello in three languages." }
    ],
    "stream": true
  }'
```

Requests and responses follow the OpenAI Chat Completions schema, including
`stream: true` for server-sent events.

## Next steps

- **[Models](api-models.html)** — the full model catalogue and how to choose a tier.
- **[Gateway API](engine-gateway-api.html)** — the gateway contract, if you're implementing or self-hosting it.

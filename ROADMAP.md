# Roadmap

A living view of where Bandit is heading — **directions, not promises, and no dates.**
It exists so contributors can see the shape of the work and help steer it. The best
items on this list will come from people building on the framework, so if you have an
idea or a need, open an issue or start a discussion.

## What Bandit is

A local-first, model-agnostic agent framework that runs end to end on your own
hardware — a CLI, a VS Code / Cursor extension, an embeddable host-agnostic runtime,
and the building blocks to assemble your own host. Off by default, no phone-home.

## In progress

- **Opt-in observability** — OpenTelemetry traces + usage metrics from the CLI and the
  extension to a collector *you* control. Off by default, redaction-first.
- **Pre-tool security guard + hooks** — opt-in, in-process guardrails and custom hooks
  that run before a tool executes.
- **MCP** — Model Context Protocol client support and first-party connectors.
- **Open-source release** — bringing the whole framework into the open under Apache 2.0.

## Next

- **Robust CLI input layer** — a sturdier interactive composer under wrap, resize, and paste.
- **More MCP connectors** — guided setup for common services.
- **Agent runner** — running agents as longer-lived, orchestrated jobs.

## Exploring

- Wider local-model and provider coverage.
- Templates for self-hosting the observability stack.
- Voice interaction in the CLI.

## Help shape it

Open an issue with the `roadmap` label, or start a discussion. Pull requests that move
an item forward are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

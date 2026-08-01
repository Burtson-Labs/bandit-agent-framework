# Bandit Engine docs — scope and licensing

**These pages do not describe the code in this repository.**

`docs/engine/` documents **Bandit Engine** (`@burtson-labs/bandit-engine`), a
separate commercial React chat library distributed under the **Business Source
License 1.1**. It is published from its own repository and sold under its own
terms. The pages live here only because [docs.burtson.ai](https://docs.burtson.ai)
is built from this `docs/` tree.

The framework in this repository — the CLI, the VS Code extension, and
everything under `packages/` — is **Apache 2.0**. See [`LICENSE`](../../LICENSE)
and [`NOTICE`](../../NOTICE). Nothing in this folder adds a restriction to it,
and the revenue tiers and change-date language in
[`06_busl_licensing.md`](./06_busl_licensing.md) apply only to Bandit Engine.

Two consequences worth knowing before you read on:

- **Relative links in these pages point at the Bandit Engine repo**, not this
  one. Paths such as `../src/services/…`, `../examples/gateway-node`, and
  `../LICENSE` do not resolve here and are not broken links in this repo to be
  "fixed" — they are cross-repo references.
- **Nothing here is a contribution target.** Issues and PRs about Bandit Engine
  belong on that product's tracker; see [CONTRIBUTING.md](../../CONTRIBUTING.md)
  for what this repo accepts.

| Page | Covers |
|---|---|
| [`00_intro.md`](./00_intro.md) | What Bandit Engine is, gateway endpoints it expects |
| [`01_quickstart.md`](./01_quickstart.md) | Installing and mounting the React package |
| [`02_gateway_api.md`](./02_gateway_api.md) | The gateway contract the client speaks |
| [`03_provider_integration.md`](./03_provider_integration.md) | Wiring model providers behind the gateway |
| [`04_local_dev.md`](./04_local_dev.md) | Running the Engine locally |
| [`05_cli_quickstart.md`](./05_cli_quickstart.md) | Engine CLI usage |
| [`06_busl_licensing.md`](./06_busl_licensing.md) | BUSL-1.1 terms and commercial tiers — **Engine only** |

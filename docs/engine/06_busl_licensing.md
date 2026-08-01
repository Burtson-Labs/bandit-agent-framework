> **Bandit Engine — separate product, separate license.** This page documents
> `@burtson-labs/bandit-engine` (BUSL-1.1), not the Apache-2.0 framework in this
> repository. Relative links point at the Engine repo. See
> [docs/engine/README.md](./README.md).

# BUSL Licensing & Commercial Terms
## Overview
Bandit Engine is distributed under the Business Source License 1.1 (BUSL-1.1). The license allows free evaluation and local development while reserving production usage for customers with a commercial agreement. After a two-year change date the code converts to Apache 2.0.

## Endpoints / API Usage
No special endpoints are required for licensing enforcement, but your deployment should:
- Provide an internal audit trail for who accesses the gateway endpoints described in [`docs/02_gateway_api.md`](./02_gateway_api.md).
- Surface licensing notices in any management UI served through your product site.

## Example Implementation
- Add a link to `/LICENSE` and `/LICENSE-NOTICE.md` in your hosted documentation.
- Maintain a renewal job that checks commercial license status before calling `npm run release`.

## Integration Notes
- **Change Date**: Two years after each release tag the BUSL terms convert to Apache 2.0. Keep a calendar reminder for compliance.
- **Commercial Tiers**:
  - **Indie** – Annual revenue under $1M, includes email support.
  - **Startup** – Revenue $1M–$10M, includes priority support and roadmap input.
  - **Enterprise** – Revenue above $10M, includes SLA-backed support and private builds.
- **Support**: Contact `legal@burtson.ai` for licensing questions and `security@burtson.ai` for vulnerability reports.

## Related Files

In the **Bandit Engine** repository (not this one): `LICENSE`,
`LICENSE-NOTICE.md`, `SECURITY.md`.

These are deliberately not links. Resolved against this repository they would
land on the Apache 2.0 [`LICENSE`](../../LICENSE) — the opposite of the terms
described above, and the most expensive possible place to be wrong about which
license applies.

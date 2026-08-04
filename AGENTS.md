# Companion repository guidance

Use this file as a routing layer. Keep durable product and system knowledge in its named authority and mechanical requirements in checks.

## Authorities

- For current product behavior and user journeys, read `docs/product.md`. Use `docs/PRD.md` for planned scope and `docs/vision.md` for enduring direction.
- For architecture, RBAC, data models, provider seams, and runtime boundaries, follow `docs/design.md`; update it when those decisions change.
- For product UI work, follow `DESIGN.md`. Treat the CSS sources it names as the executable token and component definitions.
- For test level and critical security/data promises, follow `docs/testing.md`.
- For production deployment and rollback, use `deploy/railway/README.md`.

## Supported workflow

- Use Node 20+ and the repository-pinned `pnpm@9.12.0` through Corepack.
- Before claiming a change is ready, run `pnpm verify:change -- --plan`, then `pnpm verify:change`. Exit code 2 means the fast checks passed but the listed environment-dependent gates are still required; run or report each one rather than treating the change as fully verified.
- Use an explicitly disposable, migrated Postgres database for integration tests. Never point test commands at production or an unconfirmed developer database.

## Decision boundaries

- When changing tenant isolation, ownership, RBAC, RLS, secrets, migrations, or runtime-role grants, preserve the promises in `docs/testing.md` and run the disposable-Postgres integration suite; mocked or unit-only coverage cannot prove those boundaries.
- When changing the public UI, run the design checks and affected browser flow selected by `pnpm verify:change`; do not invent tokens or patterns outside `DESIGN.md` and the existing component layer.
- The web application calls the API. Do not introduce direct browser or Next.js access to Postgres or MinIO.
- Keep `packages/core` framework-free. Put HTTP, Next.js, provider SDK, and runtime composition in the owning app or adapter rather than importing those concerns into core services.
- Never commit credentials, `.env` files, production data, plaintext secret values, or sensitive values in fixtures, logs, URLs, argv, or audit metadata.
- Before modifying `packages/companion-skill/`, read its nested `AGENTS.md`; that package has a generated client and an integrity/version protocol.
- When a public skills API endpoint, request/response contract, or workflow changes, update the affected bundled Companion skill docs and behavior under `packages/companion-skill/` in the same change.

Keep pull requests focused and use a Commitizen title such as `feat(skills): add dependency status`.

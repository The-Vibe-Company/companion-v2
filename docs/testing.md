# Testing standard

Tests defend product promises, not implementation trivia. Every critical suite should state the promise, regression caught, reason for its test level, and a change that proves it is sensitive.

Prefer the lowest level that proves the boundary, but use real PostgreSQL, object storage, HTTP, or a browser when the guarantee crosses that boundary. Mock identities and external providers, not the authorization or persistence behavior under test.

## Critical promise matrix

| Promise | Regression caught | Required level | Sensitivity example |
|---|---|---|---|
| Personal skills and personal database realms remain creator-only; org skills remain member-wide | Same-org admin override or cross-tenant disclosure | Core + PostgreSQL + HTTP | Remove the creator or tenant predicate |
| Historical Project/skill-run execution stays absent; gated Companions use Box/Pi with a minimal provider picker | Old runtime returns, a viewer wakes Box, plaintext credentials leak, or harness chrome renders | Contracts + Core + HTTP + migrated PostgreSQL + browser | Call the Box adapter before the owner/editor guard, return a provider credential, or render a Pi control |
| Skills Hub cutover preserves external cleanup ownership until deletion succeeds | Migration drops S3 keys or provider identities before old cleanup drains | Historical PostgreSQL migration replay | Seed a legacy storage ownership row and let migration 0063 continue |
| Uploads and public packages are archive-safe, checksum-bound, and limited to verified sessions, approved agent tickets, or exact `public-skills:install` PATs | Traversal, link, collision, oversized archive, substituted release, or under-scoped PAT download | Package + storage + HTTP integration | Relax one ZIP, checksum, or package-scope guard |
| Share is the only personal-to-org transition and carries required private dependencies | Partial dependency closure or unauthorized share | Core + PostgreSQL + HTTP | Skip the owner or dependency-plan gate |
| GitHub mirrors are deterministic, tenant-scoped, and idempotent | Duplicate writes, credential leak, or cross-org destination | Core + worker + provider contract + PostgreSQL | Remove digest/fence/tenant checks |
| Skill secrets never leak plaintext and grants cannot replay | Value in response/log/audit or reused grant | Core + HTTP + PostgreSQL | Return ciphertext/value or remove redemption CAS |
| Skill Databases preserve additive schemas, realm privacy, serialization, and conditional storage | Destructive drift, lost update, or personal-realm disclosure | Core + SQLite + storage + PostgreSQL | Remove schema compatibility, owner key, lock, or ETag condition |
| Agent Auth grants only exact-workspace Skills Hub capabilities | Mixed workspace approval or undeclared capability | HTTP + compatibility + PostgreSQL | Broaden constraint or capability registry |
| Agent Auth child PATs inherit only the active exact-workspace grant snapshot | PAT-to-PAT minting, caller-chosen scope/org, expired grant inheritance, target mismatch, or plaintext persistence | Contracts + Core + HTTP + PostgreSQL + bundled client | Remove inheritance, source-expiry, provenance, target binding, pipe-only handoff, or redaction guards |
| API and worker database roles stay separated | Worker reads auth data or API claims maintenance work | Migrated PostgreSQL | Grant the opposite process function/table |
| Billing gates only documented Skills Hub entitlements | Sandbox/runtime quota returns or Skills access changes unexpectedly | Contracts + Core + web | Add a runtime entitlement or bypass org skill limit |

## Required suites

- Table-driven RBAC: membership × role × action, including non-members and cross-tenant requests.
- Archive/transfer-ticket and secret-redaction tests for every changed binary or sensitive flow.
- Integration tests against a disposable migrated PostgreSQL database for schema/RLS/grant changes.
- Browser validation for any UI, route, auth, style, or browser behavior change.
- Provider-like adapters such as storage, GitHub, Skill Database, and Box runtimes need shared contract/idempotency tests.

## Frontend gate

Run the application, then:

```bash
APP_URL=http://127.0.0.1:<port> pnpm browser:smoke
```

The smoke covers signed-out redirect, login, Skills list and filters, detail, upload, public/install flows, mobile layout, and browser errors. Changed or risky paths need focused manual `agent-browser` checks. Old `/projects` URLs and runtime query parameters must fail closed, and no navigation or skill detail may offer launching.

## Change verification

Run targeted affected-package tests first, followed by:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
pnpm verify:change
```

`verify:change` exit code 2 means its selected checks passed but the printed database, browser, container, or dependency gates remain mandatory. Report exact commands and outcomes; static inspection is not a passing test.

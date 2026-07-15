# Testing standard

Companion tests protect product promises, not implementation details. A test is valuable when its
failure identifies a user-visible, security, or data-integrity regression that we would refuse to
ship.

## Protection map

Keep this table synchronized with critical suites. Removing or weakening one of these tests requires
updating the corresponding promise and explaining how it remains protected.

| Product promise | Incident prevented | Owning suite | Level | Failure proof |
| --- | --- | --- | --- | --- |
| A personal skill is visible and manageable only by its creator | Private data exposed to an admin, another member, or another tenant | `skillLifecycle.integration.test.ts` | HTTP + Postgres | Removing the creator/scope predicate makes the visibility scenario fail |
| Share is a one-way, atomic move into the organization library | Duplicated skills, leaked personal labels, or a partially shared dependency graph | `skillLifecycle.integration.test.ts` | HTTP + Postgres | Updating only the root or mutating before closure validation fails the positive or blocked dependency scenario |
| Org labels are shared; personal labels are owner-private; empty folders persist | A folder disappears, silently merges, or a rename/delete corrupts another user or tenant | `labelLifecycle.integration.test.ts` | HTTP + Postgres | Removing creation, collision/self-subtree guards, `org_id`, or `owner_id` scoping fails the empty-folder, rename-rejection, or foreign-sentinel assertion |
| Secret plaintext is write-only and never persisted or audited | Credential disclosure through an API response, database row, or audit entry | `secretLifecycle.integration.test.ts` | Service + Postgres | Returning or storing the submitted sentinel makes the persistence scenario fail |
| Secret retrieval follows the current ACL, quotas, and single-use grants | Unauthorized, unbounded, or replayed credential retrieval | `secretLifecycle.integration.test.ts` | Service + Postgres | Relaxing UPDATE RLS, quota locking, or the atomic redemption guard fails its concurrent scenario |
| Tenant RLS policies isolate organizations for a non-bypass role | Cross-tenant data disclosure or corruption when RLS is active | `rls.integration.test.ts` | Postgres non-superuser | Removing an `org_id` policy or making tenant GUCs session-scoped fails the behavioral scenario |
| Skill runs, saved configurations, inputs, prompts, events, and prompt-linked attachments stay creator-only | An admin or another member reads or mutates a private run, or a file is detached from the message that introduced it | `runsDb.integration.test.ts` | Postgres non-superuser | Relaxing a creator-through-parent policy, deferred legacy link, or prompt attachment foreign key makes the same-tenant admin, rolling-write, or attachment-association assertions fail |
| The durable run queue has one lease owner, mounts follow-up files before dispatch, and resumes without duplicating commands | Two workers start the same sandbox, an old worker accepts or reclaims attachment prompts, or OpenCode sees a prompt before its files | `runsDb.integration.test.ts`, `runSupervisor.test.ts` | Core + Postgres + worker | Weakening protocol-aware claim/reclaim admission or moving dispatch ahead of mounting makes the lease, rolling-deploy, or ordering assertions fail |
| Ambiguous run uploads remain retryable without leaking storage forever | A request race deletes committed bytes, or rejected uploads remain permanently unbounded | `runAttachmentCleanup.test.ts`, `runRoutes.test.ts`, `runsDb.integration.test.ts` | API + worker + Postgres | Moving deletion into the request path, removing the 24-hour age gate/reservation lock, dropping upload-reservation RLS, or uploading a follow-up before its preflight fails these assertions |
| Frozen and canceled runs resume the creator's retained conversation without racing cleanup | A resumed chat loses context, duplicates a prompt, or has its sandbox destroyed underneath it | `runsDb.integration.test.ts`, `runSupervisor.test.ts` | Core + Postgres + worker | Removing the activation revision, retention predicate, creator gate, or retained-session assertion fails the reactivation scenarios |
| Runtime credentials cannot bypass RLS before a tenant is selected | Login, PAT, invite, share, avatar, or billing discovery requires an all-powerful application role | `preTenantRls.integration.test.ts` | Postgres non-bypass role | Removing a narrow RPC grant or exposing tenant tables directly makes the no-GUC boundary assertions fail |
| The official installer can resolve skill metadata with a read-scoped PAT | Every automated skill install fails with 401 before dependency or package download | `skillListRoute.test.ts` | HTTP route | Removing PAT opt-in or the `skills:read` gate from the detail route fails the installer metadata scenarios |
| Browser flows preserve the same privacy guarantees as the API | A working backend hidden behind a broken or misleading UI | `e2e/critical-flows.spec.ts` | Playwright | Dropping the selected folder, breaking Share, or rendering a saved secret value fails the relevant journey |

Future providers, Hermès, and reconcile implementations must add their conformance promises here
when their production code lands. Do not add placeholder tests for code that does not exist.

## Critical-suite header

Every critical suite starts with a docblock that records why it exists:

```ts
/**
 * Product promise:
 * A personal skill is visible and manageable only by its creator.
 *
 * Regression caught:
 * Missing creator_id or scope filters could expose it to an admin or another member.
 *
 * Why this test is integrated:
 * A mocked database cannot prove that the Drizzle query and Postgres RLS enforce the rule.
 *
 * Failure proof:
 * Removing the creator filter must make this suite fail.
 */
```

Comments explain risk, test level, and non-obvious traps. They must not narrate assertions line by
line. Reference the issue or pull request when a test protects a known regression.

## Choosing the test level

- **Unit:** pure authorization matrices, encryption primitives, parsing, validation, dependency
  graph algorithms, and contract schemas.
- **Integration:** SQL predicates, transactions, migrations, RLS, ownership, tenant isolation, and
  secret lifecycle. Use a real disposable Postgres database.
- **HTTP integration:** request validation plus a critical domain workflow. Keep the real service and
  database layers; replace only authentication identity and external providers.
- **Browser:** a small number of journeys where rendering, browser state, or user interaction is the
  risk. Do not duplicate every API case in Playwright.

Mock Stripe, S3, Resend, and other external systems. Do not mock the service-to-database boundary when
the promise depends on tenant, scope, transaction, or RLS behavior.

RLS tests prove policy semantics only when they execute as a non-owner role with neither `SUPERUSER`
nor `BYPASSRLS`. They do not certify a deployment that connects its application as a table owner or
superuser; runtime credentials must independently satisfy that operational requirement.

## Test quality rules

- Name a test after the business rule and observable outcome.
- Assert public results and durable state, not internal call counts or Drizzle builder shapes.
- A bug fix includes a test that fails on the previous implementation.
- Unit tests perform no undeclared network or database I/O.
- Tests restore globals, timers, DOM roots, and mocks that they change.
- Do not commit `.only`, conditional skips, or ignored console/browser errors.
- Integration tests require an explicit disposable `DATABASE_URL`; they never silently fall back to a
  developer or production database.
- Coverage is diagnostic. A percentage is not a substitute for demonstrating that a critical test
  fails when its protected invariant is broken.

## Verified failure sensitivity

The following temporary mutations were applied locally on 2026-07-13 and reverted immediately.
They check the tests themselves; none of these faults belongs in the repository.

| Injected fault | Scenario that failed |
| --- | --- |
| Removed the `skills.org_id` predicate from shared skill reads | `hides a personal skill from same-org admins and cross-tenant actors until its owner shares it` returned a foreign-tenant row |
| Allowed every member through the personal-skill detail predicate | The same visibility scenario returned the owner's private skill to the admin instead of the indistinguishable 404 |
| Added the submitted secret value to the create response | `never returns or persists plaintext and gives an admin no implicit access` found its sentinel in the HTTP body |
| Removed the atomic `redeemed_at is null` grant claim | `allows an authorized read token to redeem once and rejects replay or changed access` observed two 200 responses instead of 200 + 409 |
| Made `withTenantContext` settings session-scoped | `uses transaction-local tenant identifiers that are cleared after withTenantContext returns` observed the leaked Org/User values on the same application connection |

## Commands

```bash
pnpm test

# Requires an explicit disposable Postgres DATABASE_URL. Migrations must already be applied.
DATABASE_URL=postgres://... pnpm test:integration

# Requires a built/seeded local stack; see playwright.config.ts for ports and credentials.
pnpm test:e2e
```

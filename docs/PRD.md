# Companion v2 PRD — Skills Hub

## Goal

Give organizations one secure, self-hostable place to govern reusable AI coding skills without operating agents or runtimes.

## MVP requirements

### Identity and tenancy

- Better Auth, organizations, memberships, Owner/Admin/Developer RBAC, invitations, and tenant-scoped queries.
- Billing gates only for Skills Hub entitlements.

### Skill lifecycle

- Personal and organization libraries with workspace-unique slugs.
- Safe ZIP upload, browser authoring, manifest validation, immutable versions, archive/restore, rename, and one-way Share.
- Dependencies, labels, comments, Activity, install/update reporting, and local inventory.
- Pinned public releases and safe package downloads for verified sessions, approved Agent Auth tickets, and exact `public-skills:install` PATs.
- GitHub App synchronization and REST/CLI workflows.

### Skill capabilities

- Write-only skill secrets with audience/recipient controls, stable bindings, redaction, preflight, and one-time redemption grants.
- Declared hosted Skill Databases with organization and personal realms, additive schemas, parameterized statements, and explicit personal-realm shares.
- Delegated Agent Auth limited to skills, Skill Databases, public installs, and skill secrets. Connected clients are external consumers, never hosted agents.
- Short-lived child PATs may inherit only the server-computed active exact-workspace Agent Auth grant snapshot; callers cannot choose broader scopes or organizations.

### Security

- Every tenant row carries `org_id`; personal resources remain creator-only with no admin override.
- The control plane never executes skill scripts.
- Archive extraction rejects traversal, links, special files, collisions, ZIP64, excessive entries, and excessive expanded size.
- Transfer tickets are short-lived, purpose-bound, non-replayable, and revalidated before use.
- Plaintext secrets never appear in API responses, logs, audit metadata, or persistent projections outside the approved encrypted store.

### Explicit exclusions

- Historical Projects/skill runs, control-plane prompts/transcripts/runtime files, prewarming,
  container catalogs, deployment management, and harnesses other than Pi.
- The optional `companions` flag may register the documented Box/Pi lifecycle API only. It must not
  expose provider or harness UI, wake Box on viewer reads, or execute the harness in Companion.

## Success measures

- Time from package to validated published version.
- Active organization skills, successful installs/updates, and public-release downloads.
- Dependency and validation failures resolved before publication.
- GitHub sync reliability and Skill Database statement reliability.
- Zero cross-tenant or personal-skill privacy violations and zero plaintext-secret leaks.

## Acceptance gates

- Old Project/run web and API paths remain unavailable, and no Pi/Box harness chrome renders.
- A forward migration removes runtime tables, policies, functions, indexes, and enums without changing historical migrations.
- Skills list/detail/upload/publish/install/public release and authenticated external-agent workflows pass behavior tests.
- Typecheck, lint, build, migration/integration tests, browser smoke, and change verification pass.

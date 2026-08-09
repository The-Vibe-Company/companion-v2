# Companion v2 architecture — Skills Hub

This document is the authoritative architecture. Companion is a Skills Hub only. It does not execute or launch agents.

## System shape

```text
apps/web       Next.js Skills workspace and settings
apps/api       REST/tRPC gateway over shared services
apps/worker    GitHub sync, billing reconciliation, Skill Database object cleanup
cli            REST client for skill workflows

packages/contracts       shared Zod/API contracts
packages/db              Drizzle schema, forward migrations, RLS
packages/core            tenant/authz and domain services; no Next.js dependency
packages/skills          package parsing, validation, versioning
packages/skilldb         hosted SQLite execution for declared Skill Databases
packages/storage         archives, releases, images, logos, database objects
packages/github          GitHub App and deterministic repository writer
packages/auth            Better Auth
packages/billing         Stripe integration
packages/companion-skill bundled external-agent workflow
```

There is no sandbox/runtime package, provider adapter, deployment reconciler, Project supervisor, run supervisor, model catalog, or agent launcher.

## Data model

Every tenant-owned row carries `org_id`. The current Drizzle schema in `packages/db/src/schema.ts` is the source of truth.

Core entities are organizations, users, memberships, invitations, skills, immutable skill versions/files, dependencies, installs, labels and personal labels, comments/images, public releases and transfer tickets, GitHub connections/destinations, skill-secret declarations/bindings/suggestions, encrypted secrets/versions/recipients, Skill Database declarations/realms/shares/object deletions, audit records, billing, tokens, onboarding/preferences, and Agent Auth identities/grants.

The forward migration `0063_skills_hub_only.sql` intentionally drops all historical Project, skill-run, sandbox-usage, model-provider, prompt, transcript, attachment, artifact, and runtime worker state. The cutover is fail-closed: its first statement refuses to drop ownership rows while Project workspaces, unsettled sandboxes, active usage, or S3-backed runtime metadata remain. Operators must quiesce the old release and drain or explicitly delete those external resources before upgrading. Historical migrations remain immutable so already-migrated databases can upgrade safely.

## Authorization

Every service-layer decision combines:

1. membership in the exact organization;
2. the org-role capability;
3. resource ownership where applicable.

Organization skills are readable and manageable by every member. Personal skills are visible and manageable only by `creator_id`; Owner/Admin has no override. Personal Skill Database realms and personal labels use the same owner-private boundary. Cross-tenant access fails closed. Public release reads go only through purpose-built, checksum-bound public functions and tickets.

## Skills lifecycle

Packages are validated without executing scripts. Publication writes immutable version/file metadata, dependency edges, secret slots, database declarations, and an audit event. Share performs the only personal-to-org transition and includes required personal dependencies after an explicit plan. Install records are per member and do not copy skill rows.

Public release promotion pins one exact organization skill version and checksum. Upload/download transfer tickets are short-lived, purpose-specific, single-use where applicable, and revalidated at redemption. GitHub sync writes deterministic, digest-verifiable repository state.

## Secrets

Secret plaintext is accepted only on write/rotation, envelope-encrypted, and never returned by ordinary CRUD. Skill bindings refer to stable slots. External clients retrieve authorized values only through preflight plus short-lived, non-replayable grants. Logs and audit metadata remain value-free. The database usage helper counts active skill bindings only.

## Skill Databases

Skills may declare bounded SQLite tables. Core validates additive schema evolution and access, `packages/skilldb` executes parameterized statements, and object storage persists the realm with conditional generation checks. Organization realms are shared; personal realms are creator-private unless explicitly shared with a current member. The worker cleans queued database objects only.

## Delegated Agent Auth

Agent Auth connects an external coding agent to the Skills Hub. Tenant capabilities are limited to `skills:read`, `skills:write`, `database:read`, `database:write`, `secrets:read`, and `secrets:write`, each constrained to one exact workspace; `public-skills:install` remains instance-wide. This is client authorization, not an internal agent product. Host defaults cannot silently grant tenant capabilities, and transfer-ticket operations are separately registered and revalidated.

An authenticated Agent Auth identity may issue a short-lived child PAT only through the registered inheritance form. The server snapshots its active exact-workspace grants, expands database write to read, caps expiry at seven days and the earliest source expiry, and persists value-free source/target provenance. Request bodies cannot select scopes or another organization, PATs cannot mint or refresh child PATs, and target-bound tokens require the matching delegation-target header. This is bearer binding rather than runtime attestation: possession of both values remains sufficient until expiry or revocation.

## API and fail-closed removal

The API exposes auth, organizations, skills, labels, dependencies, comments, files/versions, installs, public releases, GitHub, secrets, Skill Databases, billing, tokens, onboarding, and skill-facing Agent Auth. Project, run, prompt, transcript, runtime attachment/artifact, model-provider, and launch endpoints are not registered and therefore use the normal not-found response.

The web has no `/projects` route and no Run/Session state in the Skills URL grammar. Old query parameters are ignored and canonical navigation returns to the Skills detail. The only product workspace navigation is Skills.

## Process and database roles

The API and worker use distinct `NOSUPERUSER NOBYPASSRLS NOINHERIT` roles in production. `runtime-role-grants.sql` grants the API narrow pre-tenant/public/skill functions and grants the worker only billing, GitHub sync, and Skill Database cleanup functions. No runtime execution function or table grant remains.

## Deployment

Self-hosted development runs PostgreSQL, S3-compatible storage, and email plus API, worker, and web. The worker needs no Vercel/OpenCode/model-provider credentials. Railway and container configs deploy only the Skills Hub services. Conductor runs native per-workspace PostgreSQL with optional MinIO/Mailpit as documented in `CLAUDE.md`.

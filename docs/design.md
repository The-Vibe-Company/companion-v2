# Design — Companion v2 (authoritative architecture)

> **Status:** the **Skills Hub (Pillar 3)** vertical slice is implemented. Agents and the
> Container Catalog are stubbed. This document is the source of truth for the slice that exists;
> keep it in sync with the code (CLAUDE.md invariant).

## V0 stack deviation (decided, deliberate)

CLAUDE.md describes the *target* stack: Drizzle ORM, tRPC + a REST/OpenAPI gateway, Auth.js,
BullMQ on Redis, and S3-compatible storage (MinIO). For this first slice the backend is
**Supabase** (Postgres + RLS, Auth, Storage), chosen explicitly for the frontend. The schema is
plain SQL migrations under `supabase/migrations`, so it stays portable to the canonical stack later
(the same tables a Drizzle schema would introspect). When the full monorepo lands, Supabase becomes
the concrete V0 implementation of the data + auth + storage layer behind the same contracts.

What this changes vs the target doc:
- **RLS is promoted from defense-in-depth to the enforced visibility gate** (the browser/CLI can reach
  Postgres directly). The capability gate still lives in a framework-free service layer
  (`packages/core`) **and** in `SECURITY DEFINER` write RPCs — never only in client code.
- **No separate `apps/api`/worker yet.** Web writes go through Next.js route handlers (the service
  layer); the CLI calls the same Postgres RPCs. One authorization path for both clients.

## Repository layout (as built)

```
apps/web/            # Next.js 15 App Router — the Skills Hub
packages/contracts/  # Zod schemas + types (scope, frontmatter, skill, lockfile) — framework-free
packages/skills/     # SKILL.md parse / validate / pack / checksum / unpack — framework-free, tested
packages/core/       # authz capability matrix (role × scope × action) — framework-free, tested
cli/                 # `companion` CLI (TypeScript) — login + skills push/pull/status/sync/...
supabase/            # migrations + seed (schema, RLS, storage, RPCs, triggers)
examples/skills/     # a sample SKILL.md package to push
```

`packages/contracts|skills|core` are imported by **both** `apps/web` and `cli` — one source of truth
for shapes, validation, and rules.

## Data model (`supabase/migrations`)

Scope is **team-centric**: the only visibility tiers are `private` (owner), `team` (team members),
and `public` (anyone). There is no org-wide tier and no agents/attachments concept (deferred). Three
columns separate concerns: `owner_id` (principal it is for) · `scope`/`team_id` (visibility) ·
`creator_id` (who acted).

- **Identity:** `organizations`, `profiles` (1:1 with `auth.users`, generated `initials`),
  `memberships` (org_role), `teams`, `team_memberships` (team_role).
- **`skills`** — mutable current-state row (`org_id, slug, owner_id, scope, team_id, creator_id,
  current_version_id, validation, …`), `unique(org_id, slug)`, index `(org_id, scope, team_id)`,
  `check ((scope='team') = (team_id is not null))`.
- **`skill_versions`** — immutable, checksummed history; a trigger forbids UPDATE/DELETE; written only
  by the publish RPC. `unique(skill_id, version)`, `check (checksum ~ '^sha256:…$')`.
- **`skill_stars`** (per-user star), **`skill_comments`** (per-skill thread).
- **`audit_log`** — append-only, written only by `SECURITY DEFINER` triggers.
- **`skill_list_v`** — `security_invoker` read view (skills ⨝ owner ⨝ team ⨝ current version +
  `star_count`/`starred`/`team_slug`) consumed by the web list and the CLI.

### Authorization

- **Visibility gate = RLS (strict, team-centric).** A user sees a skill iff
  `scope=public` ∨ `owner_id=auth.uid()` ∨ (`scope=team` ∧ `app_member_of_team(team_id)`). **No
  org-wide tier and no org-admin override** — a user never sees the whole org, only public + their
  teams + their own. Verified by `apps/web/test/teams.rls.test.ts`: each member (incl. the org owner)
  sees only their own team's `team` skills, plus public, plus their own private.
- **Capability gate = `packages/core` + RPCs.** `publish_skill_version(...)` (SECURITY DEFINER, one
  transaction): re-checks role/scope, enforces a **monotonic** semver, writes the immutable version,
  flips `current_version_id`. `toggle_star` / `add_comment` / `set_skill_scope` are the other
  SECURITY DEFINER write RPCs. Verified: duplicate version + downgrade are rejected; scope/role gates hold.
- **Bootstrap:** the first signup with no existing owner becomes Org Owner; later users join as
  members (invitations are a fast-follow).
- **Storage:** private `skill-archives` bucket, key `{org_id}/{slug}/{version}.tar.gz`, policies gated
  on the tenant path segment; downloads via short-lived signed URLs minted server-side.

## Validation boundary (`packages/skills`)

Metadata-only — **the control plane never executes archive scripts.** `validateSkillArchive` /
`validateSkillDir` run five checks (frontmatter parse + Zod, semver, in-memory traversal/symlink/
zip-bomb rejection, size cap, declared tools). `packDir` produces a deterministic tar (stable order,
normalized headers) → a stable `sha256` over the canonical tar, the version identity. `unpackTo`
re-applies the guards on extraction. The web upload route and the CLI run the **same** code.

## Web (`apps/web`)

Next.js App Router. Server components fetch `skill_list_v` under RLS; the dense table, scope filter,
search, the right slide-over **detail drawer**, and the **upload drawer** are client components. Writes
go through `app/api/skills/upload` (validate → Storage → `publish_skill_version` RPC). Tokens live in
`src/styles/tokens.css` (the design contract); the accent default is the prototype's **signal yellow**
(`oklch(0.81 0.166 88)`) — the canonical cloud-blue stays in the root `DESIGN.md` (so its lint stays
green) and is available via `[data-accent="cloud"]`.

## CLI (`cli`, `companion`)

`login/logout/whoami` (Supabase email+password, session in `~/.companion`), `skills
list/info/versions/validate/push/pull/status/sync`. A committed `companion.lock` tracks each skill
(pin, resolved version, checksum). `status`/`sync` classify drift by comparing the local working-tree
checksum, the lock baseline, and the registry target (`up-to-date / outdated / modified / conflict /
pinned / …`); `sync` fast-forwards clean outdated skills and never clobbers modified ones. The CLI
talks directly to Supabase (anon key + user session + RLS) and calls the same publish RPC; the
service-role key never ships.

## Deferred

Invitations/role management UI, agents + Container Catalog pillars, realtime pill, zip (vs tar.gz)
upload, OS-keychain token storage, the canonical Drizzle/tRPC/worker stack.

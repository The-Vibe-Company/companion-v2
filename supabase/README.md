# Supabase backend (Companion v2 — Skills Hub V0)

Postgres (with Row-Level Security), Auth (email), and Storage back the Skills Hub. The
schema is plain SQL migrations so it stays portable to the canonical Drizzle stack later.

## Apply locally

```bash
# 1. Install the Supabase CLI (https://supabase.com/docs/guides/cli) and start Docker.
supabase start            # boots Postgres + Auth + Storage + Studio locally
supabase db reset         # applies migrations/ then runs seed.sql
```

`supabase start` prints the local `API URL`, `anon key`, and `service_role key`. Put them in
`.env.local` (web) and `.env` (CLI) — see `.env.example`.

> If `supabase start` rejects `config.toml` (CLI version drift), run `supabase init` and keep
> the existing `migrations/` and `seed.sql`, then `supabase db reset`.

## What the migrations create

| Migration | Contents |
|---|---|
| `…_extensions` | `citext`, `pgcrypto` |
| `…_identity` | enums (`scope`, `org_role`, …), `organizations`, `profiles`, `memberships`, `teams`, `team_memberships` |
| `…_agents` | agents stub (attachment target) |
| `…_skills` | `skills`, immutable `skill_versions`, `skill_attachments`, `audit_log`, the `skill_list_v` read view |
| `…_rls` | RLS helpers + visibility-gate policies (private/team/org + org-admin override) + grants |
| `…_storage` | private `skill-archives` bucket + tenant-prefix policies |
| `…_functions` | `publish_skill_version` / `attach_skill` RPCs, immutability + audit triggers, first-user-becomes-owner bootstrap |

## Authorization model

- **Visibility gate = RLS.** A row is visible if you are an org member AND (`scope=org`, or
  `scope=private` and you own it, or `scope=team` and you are on the team), or you are an org
  admin (owner/admin see everything in the tenant).
- **Capability gate = the service layer** (`packages/core`) + the SECURITY DEFINER write RPCs.
  `publish_skill_version` re-checks role/scope, enforces a monotonic semver, writes the
  immutable `skill_versions` row, and flips the skill's current-version pointer in one
  transaction. Clients cannot INSERT/UPDATE `skill_versions` directly.
- **First run:** the first user to sign up becomes Org Owner; the seed leaves that slot open so
  your first login owns the seeded `acme` org and sees the whole sample registry.

The `anon` role is granted nothing on these tables; the service-role key never ships to the
browser or the CLI.

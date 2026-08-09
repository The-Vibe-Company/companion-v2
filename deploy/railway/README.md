# Railway deployment

Companion deploys as three services plus managed dependencies:

- `web`: Next.js Skills Hub
- `api`: REST/tRPC, authentication, skills, secrets, Skill Databases, public releases
- `worker`: GitHub sync, billing reconciliation, Skill Database object cleanup
- PostgreSQL and S3-compatible object storage; email provider as configured

There is no sandbox, Project, run, model-provider, or agent-execution service.

## Order

1. Back up PostgreSQL and object storage.
2. Deploy the API image and run `node dist/migrate.js` with the migration-owner URL.
3. Deploy worker and web from the same commit.
4. Run health, Skills browser smoke, and public package checks.

Migration `0062_skills_hub_only.sql` intentionally deletes historical runtime data. It must finish before starting the new API/worker version. Historical migrations are not rewritten.

## Shared configuration

Configure public API/web origins, Better Auth secret/cookie prefix, PostgreSQL role URLs, S3 credentials, and email. Configure `COMPANION_SECRETS_MASTER_KEY` for skill secrets. Optional integrations use GitHub App, Stripe, and PostHog variables documented in `.env.example`.

API and worker should use distinct `LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT` PostgreSQL roles. Apply `packages/db/runtime-role-grants.sql` after migrations. The API owns request paths; the worker receives only billing, GitHub, and Skill Database cleanup grants.

The worker needs no Vercel, OpenCode, model-provider, golden snapshot, or runtime lifecycle variables.

## Health and rollback

Use `/health` for API availability and the Railway process status for worker/web. A rollback across migration 0062 restores code but not intentionally dropped runtime data; restore the pre-deploy database backup only if the product decision itself is rolled back. Skills, organizations, users, auth, Agent Auth, secrets, Skill Databases, GitHub, billing, and public-release data are preserved by the migration.

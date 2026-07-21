CREATE TYPE "github_sync_mode" AS ENUM ('all', 'selected');--> statement-breakpoint
CREATE TYPE "github_sync_status" AS ENUM ('pending', 'syncing', 'synced', 'error', 'disconnected');--> statement-breakpoint

CREATE TABLE "github_connections" (
  "org_id" uuid PRIMARY KEY NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "github_user_id" text NOT NULL,
  "github_login" text NOT NULL,
  "github_avatar_url" text,
  "credential_generation" uuid DEFAULT gen_random_uuid() NOT NULL,
  "credential_version" integer DEFAULT 1 NOT NULL,
  "access_ciphertext" text NOT NULL,
  "access_iv" text NOT NULL,
  "access_auth_tag" text NOT NULL,
  "access_wrapped_dek" text NOT NULL,
  "access_wrap_iv" text NOT NULL,
  "access_wrap_auth_tag" text NOT NULL,
  "access_key_id" text NOT NULL,
  "refresh_ciphertext" text,
  "refresh_iv" text,
  "refresh_auth_tag" text,
  "refresh_wrapped_dek" text,
  "refresh_wrap_iv" text,
  "refresh_wrap_auth_tag" text,
  "refresh_key_id" text,
  "access_expires_at" timestamp with time zone,
  "refresh_expires_at" timestamp with time zone,
  "connected_by" text REFERENCES "user"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "github_connections_credential_version_check" CHECK ("credential_version" >= 1)
);--> statement-breakpoint

CREATE TABLE "github_sync_destinations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "installation_id" text NOT NULL,
  "repository_id" text NOT NULL,
  "owner" text NOT NULL,
  "name" text NOT NULL,
  "html_url" text NOT NULL,
  "default_branch" text DEFAULT 'main' NOT NULL,
  "private" boolean DEFAULT true NOT NULL,
  "mode" "github_sync_mode" DEFAULT 'all' NOT NULL,
  "status" "github_sync_status" DEFAULT 'pending' NOT NULL,
  "desired_revision" integer DEFAULT 1 NOT NULL,
  "applied_revision" integer DEFAULT 0 NOT NULL,
  "resolved_skill_count" integer DEFAULT 0 NOT NULL,
  "last_synced_at" timestamp with time zone,
  "last_observed_at" timestamp with time zone,
  "last_commit_sha" text,
  "last_error" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_retry_at" timestamp with time zone,
  "lease_owner" text,
  "lease_until" timestamp with time zone,
  "lease_generation" integer DEFAULT 0 NOT NULL,
  "created_by" text REFERENCES "user"("id") ON DELETE set null,
  "updated_by" text REFERENCES "user"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "github_sync_destinations_org_id_id_uq" UNIQUE("org_id", "id"),
  CONSTRAINT "github_sync_destinations_repository_uq" UNIQUE("repository_id"),
  CONSTRAINT "github_sync_destinations_revision_check" CHECK ("desired_revision" >= 1 AND "applied_revision" >= 0 AND "applied_revision" <= "desired_revision"),
  CONSTRAINT "github_sync_destinations_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "github_sync_destinations_lease_generation_check" CHECK ("lease_generation" >= 0)
);--> statement-breakpoint
CREATE INDEX "github_sync_destinations_due_idx" ON "github_sync_destinations" ("status", "next_retry_at", "lease_until");--> statement-breakpoint

CREATE TABLE "github_sync_destination_skills" (
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "destination_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "github_sync_destination_skills_pk" PRIMARY KEY("org_id", "destination_id", "skill_id"),
  CONSTRAINT "github_sync_destination_skills_destination_org_fk" FOREIGN KEY ("org_id", "destination_id") REFERENCES "github_sync_destinations"("org_id", "id") ON DELETE cascade,
  CONSTRAINT "github_sync_destination_skills_skill_org_fk" FOREIGN KEY ("org_id", "skill_id") REFERENCES "skills"("org_id", "id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX "github_sync_destination_skills_skill_idx" ON "github_sync_destination_skills" ("org_id", "skill_id");--> statement-breakpoint

ALTER TABLE "github_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "github_sync_destinations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "github_sync_destination_skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "github_connections_tenant_rls" ON "github_connections" USING ("org_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "github_sync_destinations_tenant_rls" ON "github_sync_destinations" USING ("org_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "github_sync_destination_skills_tenant_rls" ON "github_sync_destination_skills" USING ("org_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE FUNCTION companion_claim_github_sync_destinations(p_worker_id text, p_limit integer, p_lease_seconds integer)
RETURNS TABLE (org_id uuid, destination_id uuid, claimed_revision integer, lease_generation integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH candidates AS (
    SELECT d.id
    FROM public.github_sync_destinations d
    WHERE d.status <> 'disconnected'
      AND EXISTS (
        SELECT 1 FROM public.github_connections c WHERE c.org_id = d.org_id
      )
      AND (d.lease_until IS NULL OR d.lease_until < statement_timestamp())
      AND (d.next_retry_at IS NULL OR d.next_retry_at <= statement_timestamp())
      AND (
        d.desired_revision > d.applied_revision
        OR d.last_observed_at IS NULL
        OR d.last_observed_at < statement_timestamp() - interval '15 minutes'
      )
    ORDER BY d.updated_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT greatest(1, least(p_limit, 50))
  ), claimed AS (
    UPDATE public.github_sync_destinations d
    SET desired_revision = CASE WHEN d.desired_revision = d.applied_revision THEN d.desired_revision + 1 ELSE d.desired_revision END,
        status = 'syncing', lease_owner = p_worker_id,
        lease_until = statement_timestamp() + make_interval(secs => greatest(30, least(p_lease_seconds, 3600))),
        lease_generation = d.lease_generation + 1,
        updated_at = statement_timestamp()
    FROM candidates c
    WHERE d.id = c.id
    RETURNING d.org_id, d.id, d.desired_revision, d.lease_generation
  )
  SELECT claimed.org_id, claimed.id, claimed.desired_revision, claimed.lease_generation FROM claimed
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_claim_github_sync_destinations(text, integer, integer) FROM PUBLIC;

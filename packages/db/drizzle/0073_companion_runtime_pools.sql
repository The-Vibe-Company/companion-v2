-- THE-330: Box cardinality becomes a workspace property. All personal Companions of a user share one
-- Box; all Companions of a team organization share one org Box. The shared runtime (box id, runtime
-- and daemon state, provider credential generation, disk layout, desktop availability, last error,
-- and lifecycle timestamps) moves off each Companion row and onto a workspace-scoped pool. Companions
-- keep only their durable identity plus the provider they select; threads stay 1:1 per Companion.
CREATE TYPE "companion_runtime_pool_scope" AS ENUM ('personal', 'org');
--> statement-breakpoint
CREATE TABLE "companion_runtime_pools" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "scope" "companion_runtime_pool_scope" NOT NULL,
  "owner_id" text,
  "box_id" text,
  "runtime_state" "companion_runtime_state" DEFAULT 'not_created' NOT NULL,
  "daemon_state" "companion_daemon_state" DEFAULT 'unknown' NOT NULL,
  "provider_credential_generation" uuid,
  "disk_layout_version" integer DEFAULT 1 NOT NULL,
  "desktop_available" boolean DEFAULT false NOT NULL,
  "last_error" text,
  "last_observed_at" timestamp with time zone,
  "last_started_at" timestamp with time zone,
  "last_stopped_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_runtime_pools_scope_owner_check" CHECK (
    ("scope" = 'personal' AND "owner_id" IS NOT NULL)
    OR ("scope" = 'org' AND "owner_id" IS NULL)
  ),
  CONSTRAINT "companion_runtime_pools_disk_layout_version_check" CHECK ("disk_layout_version" >= 1),
  CONSTRAINT "companion_runtime_pools_box_id_check"
    CHECK ("box_id" IS NULL OR "box_id" ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'),
  CONSTRAINT "companion_runtime_pools_last_error_check"
    CHECK ("last_error" IS NULL OR char_length("last_error") <= 500)
);
--> statement-breakpoint
ALTER TABLE "companion_runtime_pools" ADD CONSTRAINT "companion_runtime_pools_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_runtime_pools" ADD CONSTRAINT "companion_runtime_pools_owner_membership_fk"
  FOREIGN KEY ("org_id", "owner_id") REFERENCES "public"."memberships"("org_id", "user_id") ON DELETE CASCADE;
--> statement-breakpoint
-- One shared pool per personal workspace (org + owner) and one per team organization.
CREATE UNIQUE INDEX "companion_runtime_pools_personal_uq"
  ON "companion_runtime_pools" ("org_id", "owner_id")
  WHERE "scope" = 'personal' AND "owner_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "companion_runtime_pools_org_uq"
  ON "companion_runtime_pools" ("org_id")
  WHERE "scope" = 'org' AND "owner_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "companion_runtime_pools" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_runtime_pools" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Every member reads the chip for their workspace: a personal pool is readable only by its owner, an
-- org pool by any member. Viewers therefore see the shared runtime state without any Box contact.
CREATE POLICY "companion_runtime_pools_member_read_rls" ON "companion_runtime_pools"
  FOR SELECT USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.org_id = companion_runtime_pools.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
    )
    AND (
      "scope" = 'org'
      OR "owner_id" = NULLIF(current_setting('app.user_id', true), '')
    )
  );
--> statement-breakpoint
-- Only a caller who can wake a Companion in the scope may create/claim its shared pool: the owner of
-- some Companion in the scope, or a workspace Editor. A personal pool is writable only by its owner.
CREATE POLICY "companion_runtime_pools_runner_insert_rls" ON "companion_runtime_pools"
  FOR INSERT WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND (
      (
        "scope" = 'personal'
        AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
      )
      OR (
        "scope" = 'org'
        AND "owner_id" IS NULL
        AND EXISTS (
          SELECT 1 FROM public.companions c
          WHERE c.org_id = companion_runtime_pools.org_id
            AND (
              c.owner_id = NULLIF(current_setting('app.user_id', true), '')
              OR EXISTS (
                SELECT 1 FROM public.companion_workspace_access a
                WHERE a.org_id = c.org_id
                  AND a.companion_id = c.id
                  AND a.role = 'editor'
              )
            )
        )
      )
    )
  );
--> statement-breakpoint
CREATE POLICY "companion_runtime_pools_runner_update_rls" ON "companion_runtime_pools"
  FOR UPDATE
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND (
      (
        "scope" = 'personal'
        AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
      )
      OR (
        "scope" = 'org'
        AND "owner_id" IS NULL
        AND EXISTS (
          SELECT 1 FROM public.companions c
          WHERE c.org_id = companion_runtime_pools.org_id
            AND (
              c.owner_id = NULLIF(current_setting('app.user_id', true), '')
              OR EXISTS (
                SELECT 1 FROM public.companion_workspace_access a
                WHERE a.org_id = c.org_id
                  AND a.companion_id = c.id
                  AND a.role = 'editor'
              )
            )
        )
      )
    )
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND (
      (
        "scope" = 'personal'
        AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
      )
      OR (
        "scope" = 'org'
        AND "owner_id" IS NULL
        AND EXISTS (
          SELECT 1 FROM public.companions c
          WHERE c.org_id = companion_runtime_pools.org_id
            AND (
              c.owner_id = NULLIF(current_setting('app.user_id', true), '')
              OR EXISTS (
                SELECT 1 FROM public.companion_workspace_access a
                WHERE a.org_id = c.org_id
                  AND a.companion_id = c.id
                  AND a.role = 'editor'
              )
            )
        )
      )
    )
  );
--> statement-breakpoint
-- The shared runtime leaves the Companion row. Drop the per-Companion runtime columns, their check
-- constraints, and the now-obsolete runtime UPDATE policy; provider selection stays owner-only.
DROP POLICY "companions_runtime_update_rls" ON "companions";
--> statement-breakpoint
CREATE POLICY "companions_owner_update_rls" ON "companions"
  FOR UPDATE
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
  );
--> statement-breakpoint
ALTER TABLE "companions" DROP CONSTRAINT IF EXISTS "companions_disk_layout_version_check";
--> statement-breakpoint
ALTER TABLE "companions" DROP CONSTRAINT IF EXISTS "companions_box_id_check";
--> statement-breakpoint
ALTER TABLE "companions" DROP CONSTRAINT IF EXISTS "companions_last_error_check";
--> statement-breakpoint
ALTER TABLE "companions" DROP COLUMN IF EXISTS "box_id";
--> statement-breakpoint
ALTER TABLE "companions" DROP COLUMN IF EXISTS "runtime_state";
--> statement-breakpoint
ALTER TABLE "companions" DROP COLUMN IF EXISTS "daemon_state";
--> statement-breakpoint
ALTER TABLE "companions" DROP COLUMN IF EXISTS "provider_credential_generation";
--> statement-breakpoint
ALTER TABLE "companions" DROP COLUMN IF EXISTS "disk_layout_version";
--> statement-breakpoint
ALTER TABLE "companions" DROP COLUMN IF EXISTS "desktop_available";
--> statement-breakpoint
ALTER TABLE "companions" DROP COLUMN IF EXISTS "last_error";
--> statement-breakpoint
ALTER TABLE "companions" DROP COLUMN IF EXISTS "last_observed_at";
--> statement-breakpoint
ALTER TABLE "companions" DROP COLUMN IF EXISTS "last_started_at";
--> statement-breakpoint
ALTER TABLE "companions" DROP COLUMN IF EXISTS "last_stopped_at";

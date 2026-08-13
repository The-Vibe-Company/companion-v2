-- THE-332 reverts THE-330: Box cardinality goes back to one Box per Companion (1 Companion = 1 Box =
-- 1 Pi). The shared runtime chip (box id, runtime and daemon state, provider credential generation,
-- disk layout, desktop availability, last error, and lifecycle timestamps) returns to each Companion
-- row. Where a THE-330 pool exists its state is copied onto every Companion in that scope so a woken
-- workspace keeps its current Box; the pool table itself is left in place with its rows unused (a
-- non-destructive clean cut) rather than dropped.
ALTER TABLE "companions" ADD COLUMN IF NOT EXISTS "box_id" text;
--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN IF NOT EXISTS "runtime_state" "companion_runtime_state" DEFAULT 'not_created' NOT NULL;
--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN IF NOT EXISTS "daemon_state" "companion_daemon_state" DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN IF NOT EXISTS "provider_credential_generation" uuid;
--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN IF NOT EXISTS "disk_layout_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN IF NOT EXISTS "desktop_available" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN IF NOT EXISTS "last_error" text;
--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN IF NOT EXISTS "last_observed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN IF NOT EXISTS "last_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN IF NOT EXISTS "last_stopped_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "companions" ADD CONSTRAINT "companions_disk_layout_version_check" CHECK ("disk_layout_version" >= 1);
--> statement-breakpoint
ALTER TABLE "companions" ADD CONSTRAINT "companions_box_id_check"
  CHECK ("box_id" IS NULL OR "box_id" ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$');
--> statement-breakpoint
ALTER TABLE "companions" ADD CONSTRAINT "companions_last_error_check"
  CHECK ("last_error" IS NULL OR char_length("last_error") <= 500);
--> statement-breakpoint
-- Copy any personal pool's runtime onto each Companion the user owns in that personal workspace.
UPDATE "companions" c SET
  "box_id" = p."box_id",
  "runtime_state" = p."runtime_state",
  "daemon_state" = p."daemon_state",
  "provider_credential_generation" = p."provider_credential_generation",
  "disk_layout_version" = p."disk_layout_version",
  "desktop_available" = p."desktop_available",
  "last_error" = p."last_error",
  "last_observed_at" = p."last_observed_at",
  "last_started_at" = p."last_started_at",
  "last_stopped_at" = p."last_stopped_at"
FROM "companion_runtime_pools" p
WHERE p."org_id" = c."org_id"
  AND p."scope" = 'personal'
  AND p."owner_id" = c."owner_id";
--> statement-breakpoint
-- Copy any org pool's runtime onto every Companion in that team workspace.
UPDATE "companions" c SET
  "box_id" = p."box_id",
  "runtime_state" = p."runtime_state",
  "daemon_state" = p."daemon_state",
  "provider_credential_generation" = p."provider_credential_generation",
  "disk_layout_version" = p."disk_layout_version",
  "desktop_available" = p."desktop_available",
  "last_error" = p."last_error",
  "last_observed_at" = p."last_observed_at",
  "last_started_at" = p."last_started_at",
  "last_stopped_at" = p."last_stopped_at"
FROM "companion_runtime_pools" p
WHERE p."org_id" = c."org_id"
  AND p."scope" = 'org'
  AND p."owner_id" IS NULL;
--> statement-breakpoint
-- The runtime chip is a per-Companion write again. Restore the Owner/Editor runtime UPDATE policy
-- THE-330 replaced with an owner-only one, so a workspace Editor can wake a Companion in scope.
DROP POLICY "companions_owner_update_rls" ON "companions";
--> statement-breakpoint
CREATE POLICY "companions_runtime_update_rls" ON "companions"
  FOR UPDATE
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND (
      "owner_id" = NULLIF(current_setting('app.user_id', true), '')
      OR EXISTS (
        SELECT 1 FROM public.companion_workspace_access a
        WHERE a.org_id = companions.org_id
          AND a.companion_id = companions.id
          AND a.role = 'editor'
      )
    )
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND (
      "owner_id" = NULLIF(current_setting('app.user_id', true), '')
      OR EXISTS (
        SELECT 1 FROM public.companion_workspace_access a
        WHERE a.org_id = companions.org_id
          AND a.companion_id = companions.id
          AND a.role = 'editor'
      )
    )
  );

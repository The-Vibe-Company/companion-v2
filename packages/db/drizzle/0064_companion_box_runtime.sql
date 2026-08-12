CREATE TYPE "companion_runtime_state" AS ENUM (
  'not_created',
  'provisioning',
  'running',
  'stopping',
  'stopped',
  'error'
);
--> statement-breakpoint
CREATE TYPE "companion_daemon_state" AS ENUM (
  'unknown',
  'starting',
  'running',
  'stopped',
  'error'
);
--> statement-breakpoint
CREATE TABLE "companions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "owner_id" text NOT NULL,
  "name" text NOT NULL,
  "box_id" text,
  "runtime_state" "companion_runtime_state" DEFAULT 'not_created' NOT NULL,
  "daemon_state" "companion_daemon_state" DEFAULT 'unknown' NOT NULL,
  "provider_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "disk_layout_version" integer DEFAULT 1 NOT NULL,
  "desktop_available" boolean DEFAULT false NOT NULL,
  "last_observed_at" timestamp with time zone,
  "last_started_at" timestamp with time zone,
  "last_stopped_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companions_org_id_id_uq" UNIQUE ("org_id", "id"),
  CONSTRAINT "companions_disk_layout_version_check" CHECK ("disk_layout_version" >= 1),
  CONSTRAINT "companions_box_id_check"
    CHECK ("box_id" IS NULL OR "box_id" ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$')
);
--> statement-breakpoint
ALTER TABLE "companions" ADD CONSTRAINT "companions_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id");
--> statement-breakpoint
ALTER TABLE "companions" ADD CONSTRAINT "companions_owner_id_user_id_fk"
  FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id");
--> statement-breakpoint
ALTER TABLE "companions" ADD CONSTRAINT "companions_owner_membership_fk"
  FOREIGN KEY ("org_id", "owner_id") REFERENCES "public"."memberships"("org_id", "user_id");
--> statement-breakpoint
CREATE INDEX "companions_org_updated_idx" ON "companions" ("org_id", "updated_at");
--> statement-breakpoint
ALTER TABLE "companions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "companions_member_read_rls" ON "companions"
  FOR SELECT
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.org_id = companions.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
    )
  );
--> statement-breakpoint
CREATE POLICY "companions_owner_insert_rls" ON "companions"
  FOR INSERT
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.org_id = companions.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
    )
  );
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
CREATE POLICY "companions_owner_delete_rls" ON "companions"
  FOR DELETE
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
  );

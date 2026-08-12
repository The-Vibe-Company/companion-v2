CREATE TYPE "companion_provider_auth_method" AS ENUM ('api_key', 'subscription');
--> statement-breakpoint
ALTER TABLE "organizations"
  ADD COLUMN "default_companion_provider_id" text;
--> statement-breakpoint
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_default_companion_provider_id_check"
  CHECK (
    "default_companion_provider_id" IS NULL
    OR "default_companion_provider_id" ~ '^[a-z][a-z0-9-]{0,62}$'
  );
--> statement-breakpoint
CREATE TABLE "companion_provider_connections" (
  "org_id" uuid NOT NULL,
  "provider_id" text NOT NULL,
  "auth_method" "companion_provider_auth_method" NOT NULL,
  "credential_generation" uuid DEFAULT gen_random_uuid() NOT NULL,
  "credential_version" integer DEFAULT 1 NOT NULL,
  "ciphertext" text NOT NULL,
  "iv" text NOT NULL,
  "auth_tag" text NOT NULL,
  "wrapped_dek" text NOT NULL,
  "wrap_iv" text NOT NULL,
  "wrap_auth_tag" text NOT NULL,
  "key_id" text NOT NULL,
  "connected_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_provider_connections_org_id_provider_id_pk"
    PRIMARY KEY ("org_id", "provider_id"),
  CONSTRAINT "companion_provider_connections_provider_id_check"
    CHECK ("provider_id" ~ '^[a-z][a-z0-9-]{0,62}$'),
  CONSTRAINT "companion_provider_connections_credential_version_check"
    CHECK ("credential_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "companion_provider_connections"
  ADD CONSTRAINT "companion_provider_connections_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_provider_connections"
  ADD CONSTRAINT "companion_provider_connections_connected_by_user_id_fk"
  FOREIGN KEY ("connected_by") REFERENCES "public"."user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "companion_provider_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_provider_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "companion_provider_connections_member_read_rls"
  ON "companion_provider_connections"
  FOR SELECT
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.org_id = companion_provider_connections.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
    )
  );
--> statement-breakpoint
CREATE POLICY "companion_provider_connections_admin_insert_rls"
  ON "companion_provider_connections"
  FOR INSERT
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.org_id = companion_provider_connections.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
        AND m.org_role IN ('owner', 'admin')
    )
  );
--> statement-breakpoint
CREATE POLICY "companion_provider_connections_admin_update_rls"
  ON "companion_provider_connections"
  FOR UPDATE
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.org_id = companion_provider_connections.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
        AND m.org_role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.org_id = companion_provider_connections.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
        AND m.org_role IN ('owner', 'admin')
    )
  );
--> statement-breakpoint
CREATE POLICY "companion_provider_connections_admin_delete_rls"
  ON "companion_provider_connections"
  FOR DELETE
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.org_id = companion_provider_connections.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
        AND m.org_role IN ('owner', 'admin')
    )
  );

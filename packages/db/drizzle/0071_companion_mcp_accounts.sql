CREATE TABLE "companion_mcp_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "owner_id" text NOT NULL,
  "provider" text NOT NULL,
  "label" text NOT NULL,
  "transport" text NOT NULL,
  "account_config" jsonb NOT NULL,
  "credential_generation" uuid DEFAULT gen_random_uuid() NOT NULL,
  "ciphertext" text NOT NULL,
  "iv" text NOT NULL,
  "auth_tag" text NOT NULL,
  "wrapped_dek" text NOT NULL,
  "wrap_iv" text NOT NULL,
  "wrap_auth_tag" text NOT NULL,
  "key_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_mcp_accounts_provider_check"
    CHECK ("provider" ~ '^[a-z][a-z0-9-]{0,62}$'),
  CONSTRAINT "companion_mcp_accounts_label_check"
    CHECK (char_length("label") BETWEEN 1 AND 40),
  CONSTRAINT "companion_mcp_accounts_transport_check"
    CHECK ("transport" IN ('http', 'stdio'))
);
--> statement-breakpoint
ALTER TABLE "companion_mcp_accounts"
  ADD CONSTRAINT "companion_mcp_accounts_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_mcp_accounts"
  ADD CONSTRAINT "companion_mcp_accounts_owner_id_user_id_fk"
  FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_mcp_accounts"
  ADD CONSTRAINT "companion_mcp_accounts_owner_membership_fk"
  FOREIGN KEY ("org_id", "owner_id")
  REFERENCES "public"."memberships"("org_id", "user_id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "companion_mcp_accounts_provider_label_uq"
  ON "companion_mcp_accounts" ("org_id", "owner_id", "provider", lower("label"));
--> statement-breakpoint
CREATE INDEX "companion_mcp_accounts_owner_idx"
  ON "companion_mcp_accounts" ("org_id", "owner_id", "updated_at");
--> statement-breakpoint
ALTER TABLE "companion_mcp_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_mcp_accounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "companion_mcp_accounts_owner_select_rls"
  ON "companion_mcp_accounts"
  FOR SELECT
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
  );
--> statement-breakpoint
CREATE POLICY "companion_mcp_accounts_owner_insert_rls"
  ON "companion_mcp_accounts"
  FOR INSERT
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.org_id = companion_mcp_accounts.org_id
        AND m.user_id = companion_mcp_accounts.owner_id
    )
  );
--> statement-breakpoint
CREATE POLICY "companion_mcp_accounts_owner_update_rls"
  ON "companion_mcp_accounts"
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
CREATE POLICY "companion_mcp_accounts_owner_delete_rls"
  ON "companion_mcp_accounts"
  FOR DELETE
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
  );

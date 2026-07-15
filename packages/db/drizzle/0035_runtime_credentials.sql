CREATE TYPE "model_provider_connection_scope" AS ENUM ('personal', 'organization');--> statement-breakpoint

CREATE TABLE "model_provider_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "scope" "model_provider_connection_scope" NOT NULL,
  "user_id" text,
  "provider" text NOT NULL,
  "key_name" text NOT NULL,
  "current_version" integer DEFAULT 1 NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_provider_connections_org_id_id_uq" UNIQUE("org_id", "id"),
  CONSTRAINT "model_provider_connections_provider_check" CHECK (char_length("provider") BETWEEN 1 AND 120),
  CONSTRAINT "model_provider_connections_key_check" CHECK ("key_name" ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND "key_name" !~ '^OPENCODE_SERVER_'),
  CONSTRAINT "model_provider_connections_scope_owner_check" CHECK (("scope" = 'personal' AND "user_id" IS NOT NULL) OR ("scope" = 'organization' AND "user_id" IS NULL)),
  CONSTRAINT "model_provider_connections_version_check" CHECK ("current_version" >= 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX "model_provider_connections_personal_provider_uq" ON "model_provider_connections" ("org_id", "user_id", "provider") WHERE "scope" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "model_provider_connections_org_provider_uq" ON "model_provider_connections" ("org_id", "provider") WHERE "scope" = 'organization';--> statement-breakpoint

CREATE TABLE "model_provider_credential_versions" (
  "org_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "key_name" text NOT NULL,
  "ciphertext" text NOT NULL,
  "iv" text NOT NULL,
  "auth_tag" text NOT NULL,
  "wrapped_dek" text NOT NULL,
  "wrap_iv" text NOT NULL,
  "wrap_auth_tag" text NOT NULL,
  "key_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_provider_credential_versions_pk" PRIMARY KEY("org_id", "connection_id", "version"),
  CONSTRAINT "model_provider_credential_versions_version_check" CHECK ("version" >= 1),
  CONSTRAINT "model_provider_credential_versions_key_check" CHECK ("key_name" ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND "key_name" !~ '^OPENCODE_SERVER_')
);--> statement-breakpoint

-- Provider pins are run metadata, not generic secret inputs. There is intentionally no FK to the
-- live connection/version: disconnect removes ciphertext immediately while this redacted snapshot
-- remains for history and queued/active jobs fail closed when they revalidate the pin.
CREATE TABLE "skill_run_model_provider_inputs" (
  "org_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "env_key" text NOT NULL,
  "connection_id" uuid NOT NULL,
  "credential_version" integer NOT NULL,
  "connection_scope" "model_provider_connection_scope" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_model_provider_inputs_pk" PRIMARY KEY("org_id", "run_id"),
  CONSTRAINT "skill_run_model_provider_inputs_key_check" CHECK ("env_key" ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND "env_key" !~ '^OPENCODE_SERVER_'),
  CONSTRAINT "skill_run_model_provider_inputs_version_check" CHECK ("credential_version" >= 1)
);--> statement-breakpoint

ALTER TABLE "model_provider_connections" ADD CONSTRAINT "model_provider_connections_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "model_provider_connections" ADD CONSTRAINT "model_provider_connections_user_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "model_provider_connections" ADD CONSTRAINT "model_provider_connections_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "model_provider_connections" ADD CONSTRAINT "model_provider_connections_member_org_fk" FOREIGN KEY ("org_id", "user_id") REFERENCES "memberships"("org_id", "user_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "model_provider_credential_versions" ADD CONSTRAINT "model_provider_credential_versions_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "model_provider_credential_versions" ADD CONSTRAINT "model_provider_credential_versions_connection_org_fk" FOREIGN KEY ("org_id", "connection_id") REFERENCES "model_provider_connections"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_model_provider_inputs" ADD CONSTRAINT "skill_run_model_provider_inputs_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_model_provider_inputs" ADD CONSTRAINT "skill_run_model_provider_inputs_run_org_fk" FOREIGN KEY ("org_id", "run_id") REFERENCES "skill_runs"("org_id", "id") ON DELETE cascade;--> statement-breakpoint

CREATE FUNCTION companion_preserve_model_provider_connection_identity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."org_id" IS DISTINCT FROM OLD."org_id"
    OR NEW."scope" IS DISTINCT FROM OLD."scope"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."provider" IS DISTINCT FROM OLD."provider" THEN
    RAISE EXCEPTION 'model provider connection identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER model_provider_connections_preserve_identity BEFORE UPDATE ON "model_provider_connections" FOR EACH ROW EXECUTE FUNCTION companion_preserve_model_provider_connection_identity();--> statement-breakpoint

ALTER TABLE "model_provider_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_provider_credential_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_model_provider_inputs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_provider_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_provider_credential_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_model_provider_inputs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "model_provider_connections_select" ON "model_provider_connections" FOR SELECT USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM "memberships" m WHERE m."org_id" = "model_provider_connections"."org_id" AND m."user_id" = NULLIF(current_setting('app.user_id', true), ''))
  AND ("scope" = 'organization' OR "user_id" = NULLIF(current_setting('app.user_id', true), ''))
);--> statement-breakpoint
CREATE POLICY "model_provider_connections_insert" ON "model_provider_connections" FOR INSERT WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND (
    ("scope" = 'personal' AND "user_id" = NULLIF(current_setting('app.user_id', true), '') AND EXISTS (
      SELECT 1 FROM "memberships" m WHERE m."org_id" = "model_provider_connections"."org_id" AND m."user_id" = "model_provider_connections"."user_id"
    ))
    OR ("scope" = 'organization' AND EXISTS (
      SELECT 1 FROM "memberships" m WHERE m."org_id" = "model_provider_connections"."org_id" AND m."user_id" = NULLIF(current_setting('app.user_id', true), '') AND m."org_role" IN ('owner', 'admin')
    ))
  )
);--> statement-breakpoint
CREATE POLICY "model_provider_connections_update" ON "model_provider_connections" FOR UPDATE USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND (("scope" = 'personal' AND "user_id" = NULLIF(current_setting('app.user_id', true), '')) OR ("scope" = 'organization' AND EXISTS (
    SELECT 1 FROM "memberships" m WHERE m."org_id" = "model_provider_connections"."org_id" AND m."user_id" = NULLIF(current_setting('app.user_id', true), '') AND m."org_role" IN ('owner', 'admin')
  )))
) WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND (("scope" = 'personal' AND "user_id" = NULLIF(current_setting('app.user_id', true), '')) OR ("scope" = 'organization' AND EXISTS (
    SELECT 1 FROM "memberships" m WHERE m."org_id" = "model_provider_connections"."org_id" AND m."user_id" = NULLIF(current_setting('app.user_id', true), '') AND m."org_role" IN ('owner', 'admin')
  )))
);--> statement-breakpoint
CREATE POLICY "model_provider_connections_delete" ON "model_provider_connections" FOR DELETE USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND (("scope" = 'personal' AND "user_id" = NULLIF(current_setting('app.user_id', true), '')) OR ("scope" = 'organization' AND EXISTS (
    SELECT 1 FROM "memberships" m WHERE m."org_id" = "model_provider_connections"."org_id" AND m."user_id" = NULLIF(current_setting('app.user_id', true), '') AND m."org_role" IN ('owner', 'admin')
  )))
);--> statement-breakpoint
CREATE POLICY "model_provider_credential_versions_select" ON "model_provider_credential_versions" FOR SELECT USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM "model_provider_connections" c
    WHERE c."org_id" = "model_provider_credential_versions"."org_id"
      AND c."id" = "model_provider_credential_versions"."connection_id"
      AND (c."scope" = 'organization' OR c."user_id" = NULLIF(current_setting('app.user_id', true), ''))
  )
);--> statement-breakpoint
CREATE POLICY "model_provider_credential_versions_insert" ON "model_provider_credential_versions" FOR INSERT WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM "model_provider_connections" c
    WHERE c."org_id" = "model_provider_credential_versions"."org_id"
      AND c."id" = "model_provider_credential_versions"."connection_id"
      AND (
        (c."scope" = 'personal' AND c."user_id" = NULLIF(current_setting('app.user_id', true), ''))
        OR (c."scope" = 'organization' AND EXISTS (
          SELECT 1 FROM "memberships" m WHERE m."org_id" = c."org_id" AND m."user_id" = NULLIF(current_setting('app.user_id', true), '') AND m."org_role" IN ('owner', 'admin')
        ))
      )
  )
);--> statement-breakpoint
CREATE POLICY "skill_run_model_provider_inputs_creator" ON "skill_run_model_provider_inputs" USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_model_provider_inputs"."org_id" AND r."id" = "skill_run_model_provider_inputs"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))
) WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_model_provider_inputs"."org_id" AND r."id" = "skill_run_model_provider_inputs"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))
);--> statement-breakpoint
CREATE TRIGGER skill_run_model_provider_inputs_immutable BEFORE UPDATE ON "skill_run_model_provider_inputs" FOR EACH ROW EXECUTE FUNCTION companion_reject_run_snapshot_update();--> statement-breakpoint

-- Dedicated model-provider credentials have no relation to the generic vault and are not counted.
CREATE FUNCTION companion_secret_usage_count(p_org_id uuid, p_secret_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  caller_id text;
  total bigint;
BEGIN
  caller_id := NULLIF(current_setting('app.user_id', true), '');
  IF caller_id IS NULL
    OR p_org_id <> NULLIF(current_setting('app.org_id', true), '')::uuid
    OR NOT EXISTS (SELECT 1 FROM public."memberships" m WHERE m."org_id" = p_org_id AND m."user_id" = caller_id)
    OR NOT EXISTS (SELECT 1 FROM public."secrets" s WHERE s."org_id" = p_org_id AND s."id" = p_secret_id AND s."owner_id" = caller_id) THEN
    RETURN 0;
  END IF;

  SELECT
    (SELECT count(*) FROM public."skill_secret_bindings" b WHERE b."org_id" = p_org_id AND b."secret_id" = p_secret_id AND b."revoked_at" IS NULL)
    + (SELECT count(*) FROM public."skill_run_config_secrets" c WHERE c."org_id" = p_org_id AND c."secret_id" = p_secret_id)
  INTO total;
  RETURN total;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_secret_usage_count(uuid, uuid) FROM PUBLIC;

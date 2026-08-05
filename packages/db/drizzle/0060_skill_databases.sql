CREATE TYPE "skill_database_audience" AS ENUM ('organization', 'personal');
--> statement-breakpoint
CREATE TABLE "skill_database_schemas" (
  "org_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "generation" integer DEFAULT 1 NOT NULL,
  "declarations_checksum" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_database_schemas_org_id_skill_id_pk" PRIMARY KEY ("org_id", "skill_id"),
  CONSTRAINT "skill_database_schemas_generation_check" CHECK ("generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE "skill_database_tables" (
  "org_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "table_name" text NOT NULL,
  "audience" "skill_database_audience" NOT NULL,
  "columns" jsonb NOT NULL,
  "primary_key" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "unique_constraints" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "retired_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_database_tables_org_id_skill_id_table_name_pk" PRIMARY KEY ("org_id", "skill_id", "table_name"),
  CONSTRAINT "skill_database_tables_name_check"
    CHECK ("table_name" ~ '^[a-z][a-z0-9_]{0,62}$' AND "table_name" !~ '^sqlite_')
);
--> statement-breakpoint
CREATE TABLE "skill_database_realms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "audience" "skill_database_audience" NOT NULL,
  "owner_id" text,
  "storage_key" text NOT NULL,
  "size_bytes" integer DEFAULT 0 NOT NULL,
  "etag" text,
  "schema_generation" integer DEFAULT 0 NOT NULL,
  "last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_database_realms_storage_key_unique" UNIQUE ("storage_key"),
  CONSTRAINT "skill_database_realms_audience_owner_check" CHECK (
    ("audience" = 'organization' AND "owner_id" IS NULL)
    OR ("audience" = 'personal' AND "owner_id" IS NOT NULL)
  ),
  CONSTRAINT "skill_database_realms_size_check" CHECK ("size_bytes" >= 0),
  CONSTRAINT "skill_database_realms_generation_check" CHECK ("schema_generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "skill_database_rate_windows" (
  "org_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "query_count" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "skill_database_rate_windows_org_id_user_id_window_start_pk"
    PRIMARY KEY ("org_id", "user_id", "window_start"),
  CONSTRAINT "skill_database_rate_windows_count_check" CHECK ("query_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "skill_database_object_deletions" (
  "storage_key" text PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claim_token" uuid,
  "claim_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_database_object_deletions_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "skill_database_object_deletions_claim_check" CHECK (
    ("claim_token" IS NULL AND "claim_expires_at" IS NULL)
    OR ("claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "skill_database_object_deletions_available_idx"
  ON "skill_database_object_deletions" ("available_at", "claim_expires_at");
--> statement-breakpoint
ALTER TABLE "skill_database_schemas" ADD CONSTRAINT "skill_database_schemas_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "skill_database_schemas" ADD CONSTRAINT "skill_database_schemas_skill_org_fk"
  FOREIGN KEY ("org_id", "skill_id") REFERENCES "public"."skills"("org_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "skill_database_tables" ADD CONSTRAINT "skill_database_tables_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "skill_database_tables" ADD CONSTRAINT "skill_database_tables_schema_fk"
  FOREIGN KEY ("org_id", "skill_id")
  REFERENCES "public"."skill_database_schemas"("org_id", "skill_id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "skill_database_realms" ADD CONSTRAINT "skill_database_realms_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "skill_database_realms" ADD CONSTRAINT "skill_database_realms_skill_org_fk"
  FOREIGN KEY ("org_id", "skill_id") REFERENCES "public"."skills"("org_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "skill_database_realms" ADD CONSTRAINT "skill_database_realms_owner_membership_fk"
  FOREIGN KEY ("org_id", "owner_id") REFERENCES "public"."memberships"("org_id", "user_id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "skill_database_rate_windows" ADD CONSTRAINT "skill_database_rate_windows_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "skill_database_rate_windows" ADD CONSTRAINT "skill_database_rate_windows_member_org_fk"
  FOREIGN KEY ("org_id", "user_id") REFERENCES "public"."memberships"("org_id", "user_id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_database_realms_org_uq"
  ON "skill_database_realms" ("org_id", "skill_id")
  WHERE "audience" = 'organization' AND "owner_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_database_realms_personal_uq"
  ON "skill_database_realms" ("org_id", "skill_id", "owner_id")
  WHERE "audience" = 'personal' AND "owner_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "skill_database_schemas" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill_database_tables" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill_database_realms" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill_database_rate_windows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill_database_schemas" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill_database_tables" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill_database_realms" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill_database_rate_windows" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill_database_object_deletions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "skill_database_object_deletions_deny_direct_rls"
  ON "skill_database_object_deletions"
  USING (false)
  WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "skill_database_schemas_tenant_rls" ON "skill_database_schemas"
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = skill_database_schemas.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
    )
    AND EXISTS (
      SELECT 1 FROM skills s
      WHERE s.org_id = skill_database_schemas.org_id
        AND s.id = skill_database_schemas.skill_id
        AND (s.scope = 'org' OR s.creator_id = NULLIF(current_setting('app.user_id', true), ''))
    )
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = skill_database_schemas.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
    )
    AND EXISTS (
      SELECT 1 FROM skills s
      WHERE s.org_id = skill_database_schemas.org_id
        AND s.id = skill_database_schemas.skill_id
        AND (s.scope = 'org' OR s.creator_id = NULLIF(current_setting('app.user_id', true), ''))
    )
  );
--> statement-breakpoint
CREATE POLICY "skill_database_tables_tenant_rls" ON "skill_database_tables"
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = skill_database_tables.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
    )
    AND EXISTS (
      SELECT 1 FROM skills s
      WHERE s.org_id = skill_database_tables.org_id
        AND s.id = skill_database_tables.skill_id
        AND (s.scope = 'org' OR s.creator_id = NULLIF(current_setting('app.user_id', true), ''))
    )
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = skill_database_tables.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
    )
    AND EXISTS (
      SELECT 1 FROM skills s
      WHERE s.org_id = skill_database_tables.org_id
        AND s.id = skill_database_tables.skill_id
        AND (s.scope = 'org' OR s.creator_id = NULLIF(current_setting('app.user_id', true), ''))
    )
  );
--> statement-breakpoint
CREATE POLICY "skill_database_realms_owner_private_rls" ON "skill_database_realms"
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = skill_database_realms.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
    )
    AND EXISTS (
      SELECT 1 FROM skills s
      WHERE s.org_id = skill_database_realms.org_id
        AND s.id = skill_database_realms.skill_id
        AND (s.scope = 'org' OR s.creator_id = NULLIF(current_setting('app.user_id', true), ''))
    )
    AND ("owner_id" IS NULL OR "owner_id" = NULLIF(current_setting('app.user_id', true), ''))
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = skill_database_realms.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
    )
    AND EXISTS (
      SELECT 1 FROM skills s
      WHERE s.org_id = skill_database_realms.org_id
        AND s.id = skill_database_realms.skill_id
        AND (s.scope = 'org' OR s.creator_id = NULLIF(current_setting('app.user_id', true), ''))
    )
    AND ("owner_id" IS NULL OR "owner_id" = NULLIF(current_setting('app.user_id', true), ''))
  );
--> statement-breakpoint
CREATE POLICY "skill_database_rate_windows_owner_rls" ON "skill_database_rate_windows"
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.user_id', true), '')
  );
--> statement-breakpoint
CREATE FUNCTION companion_enqueue_skill_database_object_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.skill_database_object_deletions (storage_key, org_id)
  VALUES (OLD.storage_key, OLD.org_id)
  ON CONFLICT (storage_key) DO UPDATE
    SET org_id = EXCLUDED.org_id,
        available_at = LEAST(
          public.skill_database_object_deletions.available_at,
          pg_catalog.now()
        );
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER skill_database_realms_enqueue_object_deletion
AFTER DELETE ON "skill_database_realms"
FOR EACH ROW EXECUTE FUNCTION companion_enqueue_skill_database_object_deletion();
--> statement-breakpoint
CREATE FUNCTION companion_claim_skill_database_object_deletions(p_limit integer, p_lease_seconds integer)
RETURNS TABLE ("storageKey" text, "claimToken" uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 1000 OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid skill database object deletion claim limits';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT d.storage_key
    FROM public.skill_database_object_deletions d
    WHERE d.available_at <= pg_catalog.now()
      AND (d.claim_expires_at IS NULL OR d.claim_expires_at <= pg_catalog.now())
    ORDER BY d.available_at, d.storage_key
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.skill_database_object_deletions d
  SET claim_token = gen_random_uuid(),
      claim_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds)
  FROM candidates c
  WHERE d.storage_key = c.storage_key
  RETURNING d.storage_key, d.claim_token;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION companion_complete_skill_database_object_deletion(p_storage_key text, p_claim_token uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH deleted AS (
    DELETE FROM public.skill_database_object_deletions
    WHERE storage_key = p_storage_key
      AND claim_token = p_claim_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM deleted);
$$;
--> statement-breakpoint
CREATE FUNCTION companion_defer_skill_database_object_deletion(p_storage_key text, p_claim_token uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH deferred AS (
    UPDATE public.skill_database_object_deletions
    SET attempts = attempts + 1,
        available_at = pg_catalog.now()
          + pg_catalog.make_interval(secs => LEAST(3600, 5 * (attempts + 1))),
        claim_token = NULL,
        claim_expires_at = NULL
    WHERE storage_key = p_storage_key
      AND claim_token = p_claim_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM deferred);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_enqueue_skill_database_object_deletion() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_claim_skill_database_object_deletions(integer, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_complete_skill_database_object_deletion(text, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_defer_skill_database_object_deletion(text, uuid) FROM PUBLIC;

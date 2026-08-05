ALTER TABLE "skill_database_realms"
  ADD CONSTRAINT "skill_database_realms_org_id_id_owner_id_uq"
  UNIQUE ("org_id", "id", "owner_id");
--> statement-breakpoint
CREATE TABLE "skill_database_realm_shares" (
  "org_id" uuid NOT NULL,
  "realm_id" uuid NOT NULL,
  "owner_id" text NOT NULL,
  "grantee_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_database_realm_shares_org_id_realm_id_grantee_id_pk"
    PRIMARY KEY ("org_id", "realm_id", "grantee_id"),
  CONSTRAINT "skill_database_realm_shares_different_members_check"
    CHECK ("owner_id" <> "grantee_id")
);
--> statement-breakpoint
ALTER TABLE "skill_database_realm_shares"
  ADD CONSTRAINT "skill_database_realm_shares_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "skill_database_realm_shares"
  ADD CONSTRAINT "skill_database_realm_shares_realm_owner_fk"
  FOREIGN KEY ("org_id", "realm_id", "owner_id")
  REFERENCES "public"."skill_database_realms"("org_id", "id", "owner_id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "skill_database_realm_shares"
  ADD CONSTRAINT "skill_database_realm_shares_owner_membership_fk"
  FOREIGN KEY ("org_id", "owner_id")
  REFERENCES "public"."memberships"("org_id", "user_id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "skill_database_realm_shares"
  ADD CONSTRAINT "skill_database_realm_shares_grantee_membership_fk"
  FOREIGN KEY ("org_id", "grantee_id")
  REFERENCES "public"."memberships"("org_id", "user_id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "skill_database_realm_shares" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill_database_realm_shares" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "skill_database_realm_shares_select_rls"
  ON "skill_database_realm_shares"
  FOR SELECT
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND (
      "owner_id" = NULLIF(current_setting('app.user_id', true), '')
      OR "grantee_id" = NULLIF(current_setting('app.user_id', true), '')
    )
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = skill_database_realm_shares.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
    )
  );
--> statement-breakpoint
CREATE POLICY "skill_database_realm_shares_insert_rls"
  ON "skill_database_realm_shares"
  FOR INSERT
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
    AND "grantee_id" <> NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = skill_database_realm_shares.org_id
        AND m.user_id = skill_database_realm_shares.grantee_id
    )
  );
--> statement-breakpoint
CREATE POLICY "skill_database_realm_shares_update_rls"
  ON "skill_database_realm_shares"
  FOR UPDATE
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
    AND "grantee_id" <> NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = skill_database_realm_shares.org_id
        AND m.user_id = skill_database_realm_shares.grantee_id
    )
  );
--> statement-breakpoint
CREATE POLICY "skill_database_realm_shares_delete_rls"
  ON "skill_database_realm_shares"
  FOR DELETE
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
  );
--> statement-breakpoint
DROP POLICY "skill_database_realms_owner_private_rls" ON "skill_database_realms";
--> statement-breakpoint
CREATE POLICY "skill_database_realms_shared_private_rls" ON "skill_database_realms"
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
    AND (
      "owner_id" IS NULL
      OR "owner_id" = NULLIF(current_setting('app.user_id', true), '')
      OR EXISTS (
        SELECT 1 FROM skill_database_realm_shares rs
        WHERE rs.org_id = skill_database_realms.org_id
          AND rs.realm_id = skill_database_realms.id
          AND rs.grantee_id = NULLIF(current_setting('app.user_id', true), '')
      )
    )
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
    AND (
      "owner_id" IS NULL
      OR "owner_id" = NULLIF(current_setting('app.user_id', true), '')
      OR EXISTS (
        SELECT 1 FROM skill_database_realm_shares rs
        WHERE rs.org_id = skill_database_realms.org_id
          AND rs.realm_id = skill_database_realms.id
          AND rs.grantee_id = NULLIF(current_setting('app.user_id', true), '')
      )
    )
  );
--> statement-breakpoint
CREATE FUNCTION companion_revoke_inactive_skill_database_realm_shares(
  p_org_id uuid,
  p_skill_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF p_org_id IS DISTINCT FROM NULLIF(current_setting('app.org_id', true), '')::uuid
    OR NOT EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.org_id = p_org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
    ) THEN
    RAISE EXCEPTION 'not authorized to revoke inactive skill database shares';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.skill_database_tables t
    WHERE t.org_id = p_org_id
      AND t.skill_id = p_skill_id
      AND t.audience = 'personal'
      AND t.retired_at IS NULL
  ) THEN
    RETURN 0;
  END IF;

  DELETE FROM public.skill_database_realm_shares rs
  USING public.skill_database_realms r
  WHERE rs.org_id = p_org_id
    AND rs.realm_id = r.id
    AND r.org_id = p_org_id
    AND r.skill_id = p_skill_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
--> statement-breakpoint
-- FORCE RLS also applies to a NOSUPERUSER/NOBYPASSRLS migration owner. These narrowly scoped
-- maintenance policies let only this SECURITY DEFINER function's current owner inspect realms and
-- delete stale grants; ordinary API sessions continue to use the member-facing policies above.
CREATE POLICY "skill_database_realms_inactive_share_maintenance_rls"
  ON "skill_database_realms"
  FOR SELECT
  USING (
    current_user = pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_revoke_inactive_skill_database_realm_shares(uuid,uuid)'::regprocedure
    ))
  );
--> statement-breakpoint
CREATE POLICY "skill_database_realm_shares_inactive_maintenance_rls"
  ON "skill_database_realm_shares"
  FOR DELETE
  USING (
    current_user = pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_revoke_inactive_skill_database_realm_shares(uuid,uuid)'::regprocedure
    ))
  );
--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_revoke_inactive_skill_database_realm_shares(uuid, uuid) FROM PUBLIC;

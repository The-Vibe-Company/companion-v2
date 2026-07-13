CREATE TYPE "secret_audience" AS ENUM ('personal', 'restricted', 'organization');--> statement-breakpoint
CREATE TYPE "secret_binding_source" AS ENUM ('manual', 'suggestion');--> statement-breakpoint
CREATE TYPE "secret_slot_status" AS ENUM ('personal', 'shared', 'required', 'optional_missing');--> statement-breakpoint

CREATE TABLE "secrets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "owner_id" text NOT NULL,
  "name" text NOT NULL,
  "key" text NOT NULL,
  "audience" "secret_audience" DEFAULT 'personal' NOT NULL,
  "current_version" integer DEFAULT 1 NOT NULL,
  "last_rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "disabled_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "secrets_org_id_id_uq" UNIQUE("org_id", "id"),
  CONSTRAINT "secrets_org_id_id_owner_uq" UNIQUE("org_id", "id", "owner_id"),
  CONSTRAINT "secrets_key_check" CHECK ("key" ~ '^[A-Za-z_][A-Za-z0-9_]*$')
);--> statement-breakpoint
CREATE TABLE "secret_versions" (
  "org_id" uuid NOT NULL,
  "secret_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "ciphertext" text NOT NULL,
  "iv" text NOT NULL,
  "auth_tag" text NOT NULL,
  "wrapped_dek" text NOT NULL,
  "wrap_iv" text NOT NULL,
  "wrap_auth_tag" text NOT NULL,
  "key_id" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "secret_versions_org_id_secret_id_version_pk" PRIMARY KEY("org_id", "secret_id", "version"),
  CONSTRAINT "secret_versions_positive_check" CHECK ("version" > 0)
);--> statement-breakpoint
CREATE TABLE "secret_recipients" (
  "org_id" uuid NOT NULL,
  "secret_id" uuid NOT NULL,
  "owner_id" text NOT NULL,
  "user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "secret_recipients_org_id_secret_id_user_id_pk" PRIMARY KEY("org_id", "secret_id", "user_id")
);--> statement-breakpoint
CREATE TABLE "skill_secret_slots" (
  "org_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "slot_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_secret_slots_org_skill_slot_pk" PRIMARY KEY("org_id", "skill_id", "slot_id")
);--> statement-breakpoint
CREATE TABLE "skill_version_secret_slots" (
  "org_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "skill_version_id" uuid NOT NULL,
  "slot_id" uuid NOT NULL,
  "env_key" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "required" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_version_secret_slots_version_slot_pk" PRIMARY KEY("skill_version_id", "slot_id"),
  CONSTRAINT "skill_version_secret_slots_key_check" CHECK ("env_key" ~ '^[A-Za-z_][A-Za-z0-9_]*$')
);--> statement-breakpoint
CREATE TABLE "skill_secret_bindings" (
  "org_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "skill_id" uuid NOT NULL,
  "slot_id" uuid NOT NULL,
  "secret_id" uuid NOT NULL,
  "projection_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "source" "secret_binding_source" DEFAULT 'manual' NOT NULL,
  "confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_secret_bindings_org_user_skill_slot_pk" PRIMARY KEY("org_id", "user_id", "skill_id", "slot_id"),
  CONSTRAINT "skill_secret_bindings_projection_uq" UNIQUE("projection_id")
);--> statement-breakpoint
CREATE TABLE "skill_secret_suggestions" (
  "org_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "slot_id" uuid NOT NULL,
  "secret_id" uuid NOT NULL,
  "suggested_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_secret_suggestions_org_skill_slot_pk" PRIMARY KEY("org_id", "skill_id", "slot_id")
);--> statement-breakpoint
CREATE TABLE "secret_retrieval_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "operation_id" uuid NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "granted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "secret_retrieval_plans_org_id_id_uq" UNIQUE("org_id", "id"),
  CONSTRAINT "secret_retrieval_plans_operation_uq" UNIQUE("org_id", "user_id", "operation_id")
);--> statement-breakpoint
CREATE TABLE "secret_retrieval_plan_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "plan_id" uuid NOT NULL,
  "projection_id" uuid NOT NULL,
  "skill" text NOT NULL,
  "skill_id" uuid,
  "skill_version_id" uuid,
  "skill_version" text,
  "slot_id" uuid,
  "env_key" text NOT NULL,
  "required" boolean DEFAULT true NOT NULL,
  "status" "secret_slot_status" NOT NULL,
  "secret_id" uuid,
  "secret_version" integer,
  "secret_name" text,
  "owner_name" text,
  "tombstone" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "secret_retrieval_plan_items_projection_uq" UNIQUE("plan_id", "projection_id")
);--> statement-breakpoint
CREATE TABLE "secret_retrieval_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "plan_id" uuid NOT NULL,
  "token_prefix" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "redeemed_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "secrets" ADD CONSTRAINT "secrets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_secret_org_fk" FOREIGN KEY ("org_id", "secret_id") REFERENCES "secrets"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secret_recipients" ADD CONSTRAINT "secret_recipients_secret_org_fk" FOREIGN KEY ("org_id", "secret_id", "owner_id") REFERENCES "secrets"("org_id", "id", "owner_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secret_recipients" ADD CONSTRAINT "secret_recipients_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secret_recipients" ADD CONSTRAINT "secret_recipients_member_org_fk" FOREIGN KEY ("org_id", "user_id") REFERENCES "memberships"("org_id", "user_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_secret_slots" ADD CONSTRAINT "skill_secret_slots_skill_org_fk" FOREIGN KEY ("org_id", "skill_id") REFERENCES "skills"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_version_secret_slots" ADD CONSTRAINT "skill_version_secret_slots_stable_fk" FOREIGN KEY ("org_id", "skill_id", "slot_id") REFERENCES "skill_secret_slots"("org_id", "skill_id", "slot_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_version_secret_slots" ADD CONSTRAINT "skill_version_secret_slots_version_org_fk" FOREIGN KEY ("org_id", "skill_version_id") REFERENCES "skill_versions"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_secret_bindings" ADD CONSTRAINT "skill_secret_bindings_member_org_fk" FOREIGN KEY ("org_id", "user_id") REFERENCES "memberships"("org_id", "user_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_secret_bindings" ADD CONSTRAINT "skill_secret_bindings_slot_fk" FOREIGN KEY ("org_id", "skill_id", "slot_id") REFERENCES "skill_secret_slots"("org_id", "skill_id", "slot_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_secret_bindings" ADD CONSTRAINT "skill_secret_bindings_secret_org_fk" FOREIGN KEY ("org_id", "secret_id") REFERENCES "secrets"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_secret_suggestions" ADD CONSTRAINT "skill_secret_suggestions_slot_fk" FOREIGN KEY ("org_id", "skill_id", "slot_id") REFERENCES "skill_secret_slots"("org_id", "skill_id", "slot_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_secret_suggestions" ADD CONSTRAINT "skill_secret_suggestions_secret_org_fk" FOREIGN KEY ("org_id", "secret_id") REFERENCES "secrets"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_secret_suggestions" ADD CONSTRAINT "skill_secret_suggestions_suggested_by_user_id_fk" FOREIGN KEY ("suggested_by") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secret_retrieval_plans" ADD CONSTRAINT "secret_retrieval_plans_member_org_fk" FOREIGN KEY ("org_id", "user_id") REFERENCES "memberships"("org_id", "user_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secret_retrieval_plan_items" ADD CONSTRAINT "secret_retrieval_plan_items_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "secret_retrieval_plans"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secret_retrieval_plan_items" ADD CONSTRAINT "secret_retrieval_plan_items_plan_org_fk" FOREIGN KEY ("org_id", "plan_id") REFERENCES "secret_retrieval_plans"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secret_retrieval_plan_items" ADD CONSTRAINT "secret_retrieval_plan_items_skill_version_org_fk" FOREIGN KEY ("org_id", "skill_version_id") REFERENCES "skill_versions"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secret_retrieval_plan_items" ADD CONSTRAINT "secret_retrieval_plan_items_secret_version_org_fk" FOREIGN KEY ("org_id", "secret_id", "secret_version") REFERENCES "secret_versions"("org_id", "secret_id", "version") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secret_retrieval_grants" ADD CONSTRAINT "secret_retrieval_grants_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "secret_retrieval_plans"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secret_retrieval_grants" ADD CONSTRAINT "secret_retrieval_grants_plan_org_fk" FOREIGN KEY ("org_id", "plan_id") REFERENCES "secret_retrieval_plans"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "secret_retrieval_grants" ADD CONSTRAINT "secret_retrieval_grants_member_org_fk" FOREIGN KEY ("org_id", "user_id") REFERENCES "memberships"("org_id", "user_id") ON DELETE cascade;--> statement-breakpoint

CREATE INDEX "secrets_org_owner_idx" ON "secrets" ("org_id", "owner_id");--> statement-breakpoint
CREATE INDEX "secrets_org_audience_idx" ON "secrets" ("org_id", "audience");--> statement-breakpoint
CREATE INDEX "secret_versions_org_idx" ON "secret_versions" ("org_id");--> statement-breakpoint
CREATE INDEX "secret_recipients_org_user_idx" ON "secret_recipients" ("org_id", "user_id");--> statement-breakpoint
CREATE INDEX "skill_version_secret_slots_skill_idx" ON "skill_version_secret_slots" ("org_id", "skill_id", "slot_id");--> statement-breakpoint
CREATE INDEX "skill_secret_bindings_secret_idx" ON "skill_secret_bindings" ("org_id", "secret_id");--> statement-breakpoint
CREATE INDEX "secret_retrieval_plans_rate_idx" ON "secret_retrieval_plans" ("org_id", "user_id", "created_at");--> statement-breakpoint
CREATE INDEX "secret_retrieval_plan_items_plan_idx" ON "secret_retrieval_plan_items" ("org_id", "plan_id");--> statement-breakpoint
CREATE INDEX "secret_retrieval_grants_rate_idx" ON "secret_retrieval_grants" ("org_id", "user_id", "created_at");--> statement-breakpoint

-- Backfill every historical companion.json declaration with the same deterministic UUID algorithm
-- used by @companion/skills. Explicit slotId values always win.
CREATE FUNCTION companion_secret_slot_uuid(skill_id uuid, env_key text) RETURNS uuid
LANGUAGE SQL IMMUTABLE STRICT AS $$
  WITH digest AS (SELECT md5(skill_id::text || ':secret:' || env_key) AS h), normalized AS (
    SELECT substr(h, 1, 12) || '5' || substr(h, 14, 3) ||
      CASE
        WHEN substr(h, 17, 1) IN ('0','4','8','c') THEN '8'
        WHEN substr(h, 17, 1) IN ('1','5','9','d') THEN '9'
        WHEN substr(h, 17, 1) IN ('2','6','a','e') THEN 'a'
        ELSE 'b'
      END || substr(h, 18) AS h
    FROM digest
  )
  SELECT (substr(h,1,8) || '-' || substr(h,9,4) || '-' || substr(h,13,4) || '-' || substr(h,17,4) || '-' || substr(h,21,12))::uuid FROM normalized
$$;--> statement-breakpoint

WITH declarations AS (
  SELECT sv.org_id, sv.skill_id, sv.id AS skill_version_id, e.key AS env_key, e.value AS declaration,
    COALESCE(NULLIF(e.value->>'slotId', '')::uuid, companion_secret_slot_uuid(sv.skill_id, e.key)) AS slot_id,
    sv.created_at
  FROM skill_versions sv
  CROSS JOIN LATERAL jsonb_each(COALESCE(sv.frontmatter::jsonb #> '{companion,environment,secrets}', '{}'::jsonb)) e
)
INSERT INTO skill_secret_slots (org_id, skill_id, slot_id, created_at, last_seen_at)
SELECT org_id, skill_id, slot_id, min(created_at), max(created_at)
FROM declarations GROUP BY org_id, skill_id, slot_id
ON CONFLICT (org_id, skill_id, slot_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at;--> statement-breakpoint

WITH declarations AS (
  SELECT sv.org_id, sv.skill_id, sv.id AS skill_version_id, e.key AS env_key, e.value AS declaration,
    COALESCE(NULLIF(e.value->>'slotId', '')::uuid, companion_secret_slot_uuid(sv.skill_id, e.key)) AS slot_id,
    sv.created_at
  FROM skill_versions sv
  CROSS JOIN LATERAL jsonb_each(COALESCE(sv.frontmatter::jsonb #> '{companion,environment,secrets}', '{}'::jsonb)) e
)
INSERT INTO skill_version_secret_slots (org_id, skill_id, skill_version_id, slot_id, env_key, description, required, created_at)
SELECT org_id, skill_id, skill_version_id, slot_id, env_key, COALESCE(declaration->>'description', ''),
  COALESCE((declaration->>'required')::boolean, true), created_at
FROM declarations ON CONFLICT DO NOTHING;--> statement-breakpoint
DROP FUNCTION companion_secret_slot_uuid(uuid, text);--> statement-breakpoint

ALTER TABLE "secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "secret_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "secret_recipients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_secret_slots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_version_secret_slots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_secret_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_secret_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "secret_retrieval_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "secret_retrieval_plan_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "secret_retrieval_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "secrets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "secret_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "secret_recipients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_secret_slots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_version_secret_slots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_secret_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_secret_suggestions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "secret_retrieval_plans" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "secret_retrieval_plan_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "secret_retrieval_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "secrets_select_acl" ON "secrets" FOR SELECT USING (
  org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = secrets.org_id AND m.user_id = NULLIF(current_setting('app.user_id', true), ''))
  AND (
    owner_id = NULLIF(current_setting('app.user_id', true), '') OR
    (
      owner_id = NULLIF(current_setting('app.departing_user_id', true), '') AND
      EXISTS (SELECT 1 FROM memberships manager WHERE manager.org_id = secrets.org_id AND manager.user_id = NULLIF(current_setting('app.user_id', true), '') AND manager.org_role IN ('owner', 'admin'))
    ) OR
    (
      disabled_at IS NULL AND deleted_at IS NULL AND (
        audience = 'organization' OR
        EXISTS (SELECT 1 FROM secret_recipients r WHERE r.org_id = secrets.org_id AND r.secret_id = secrets.id AND r.user_id = NULLIF(current_setting('app.user_id', true), ''))
      )
    )
  )
);--> statement-breakpoint
CREATE POLICY "secrets_insert_owner" ON "secrets" FOR INSERT WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND owner_id = NULLIF(current_setting('app.user_id', true), '') AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = secrets.org_id AND m.user_id = secrets.owner_id));--> statement-breakpoint
CREATE POLICY "secrets_update_owner" ON "secrets" FOR UPDATE USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND owner_id = NULLIF(current_setting('app.user_id', true), '') AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = secrets.org_id AND m.user_id = secrets.owner_id)) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND owner_id = NULLIF(current_setting('app.user_id', true), '') AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = secrets.org_id AND m.user_id = secrets.owner_id));--> statement-breakpoint
CREATE POLICY "secrets_update_member_departure" ON "secrets" FOR UPDATE USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND owner_id = NULLIF(current_setting('app.departing_user_id', true), '') AND EXISTS (SELECT 1 FROM memberships manager WHERE manager.org_id = secrets.org_id AND manager.user_id = NULLIF(current_setting('app.user_id', true), '') AND manager.org_role IN ('owner', 'admin'))) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND owner_id = NULLIF(current_setting('app.departing_user_id', true), '') AND disabled_at IS NOT NULL AND EXISTS (SELECT 1 FROM memberships manager WHERE manager.org_id = secrets.org_id AND manager.user_id = NULLIF(current_setting('app.user_id', true), '') AND manager.org_role IN ('owner', 'admin')));--> statement-breakpoint
CREATE POLICY "secrets_delete_owner" ON "secrets" FOR DELETE USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND owner_id = NULLIF(current_setting('app.user_id', true), '') AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = secrets.org_id AND m.user_id = secrets.owner_id));--> statement-breakpoint

CREATE POLICY "secret_versions_acl" ON "secret_versions" FOR SELECT USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM secrets s WHERE s.org_id = secret_versions.org_id AND s.id = secret_versions.secret_id));--> statement-breakpoint
CREATE POLICY "secret_versions_owner_insert" ON "secret_versions" FOR INSERT WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND created_by = NULLIF(current_setting('app.user_id', true), '') AND EXISTS (SELECT 1 FROM secrets s WHERE s.org_id = secret_versions.org_id AND s.id = secret_versions.secret_id AND s.owner_id = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "secret_recipients_acl" ON "secret_recipients" FOR SELECT USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = secret_recipients.org_id AND m.user_id = NULLIF(current_setting('app.user_id', true), '')) AND (user_id = NULLIF(current_setting('app.user_id', true), '') OR owner_id = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "secret_recipients_owner_mutate" ON "secret_recipients" FOR ALL USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND owner_id = NULLIF(current_setting('app.user_id', true), '') AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = secret_recipients.org_id AND m.user_id = secret_recipients.owner_id)) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND owner_id = NULLIF(current_setting('app.user_id', true), '') AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = secret_recipients.org_id AND m.user_id = secret_recipients.owner_id));--> statement-breakpoint

CREATE POLICY "skill_secret_slots_tenant" ON "skill_secret_slots" USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "skill_version_secret_slots_tenant" ON "skill_version_secret_slots" USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "skill_secret_bindings_owner" ON "skill_secret_bindings" USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), '')) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "skill_secret_suggestions_tenant" ON "skill_secret_suggestions" USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "secret_retrieval_plans_owner" ON "secret_retrieval_plans" USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), '')) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "secret_retrieval_plan_items_owner" ON "secret_retrieval_plan_items" USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM secret_retrieval_plans p WHERE p.id = secret_retrieval_plan_items.plan_id AND p.user_id = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM secret_retrieval_plans p WHERE p.id = secret_retrieval_plan_items.plan_id AND p.user_id = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "secret_retrieval_grants_owner" ON "secret_retrieval_grants" USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), '')) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), ''));

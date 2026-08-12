CREATE TYPE "companion_share_role" AS ENUM ('editor', 'viewer');
--> statement-breakpoint
CREATE TYPE "companion_transcript_role" AS ENUM ('user', 'assistant', 'system');
--> statement-breakpoint
ALTER TABLE "companions"
  ADD CONSTRAINT "companions_org_id_id_owner_id_uq" UNIQUE ("org_id", "id", "owner_id");
--> statement-breakpoint
CREATE TABLE "companion_workspace_access" (
  "org_id" uuid NOT NULL,
  "companion_id" uuid PRIMARY KEY NOT NULL,
  "owner_id" text NOT NULL,
  "role" "companion_share_role" NOT NULL,
  "granted_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companion_member_access" (
  "org_id" uuid NOT NULL,
  "companion_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "owner_id" text NOT NULL,
  "role" "companion_share_role" NOT NULL,
  "granted_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_member_access_companion_id_user_id_pk"
    PRIMARY KEY ("companion_id", "user_id")
);
--> statement-breakpoint
CREATE TABLE "companion_transcript_entries" (
  "org_id" uuid NOT NULL,
  "companion_id" uuid NOT NULL,
  "event_id" text NOT NULL,
  "ordinal" integer NOT NULL,
  "role" "companion_transcript_role" NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_transcript_entries_companion_id_event_id_pk"
    PRIMARY KEY ("companion_id", "event_id"),
  CONSTRAINT "companion_transcript_entries_ordinal_uq"
    UNIQUE ("companion_id", "ordinal"),
  CONSTRAINT "companion_transcript_entries_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "companion_transcript_entries_content_check"
    CHECK (octet_length("content") <= 1048576)
);
--> statement-breakpoint
ALTER TABLE "companion_workspace_access"
  ADD CONSTRAINT "companion_workspace_access_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_workspace_access"
  ADD CONSTRAINT "companion_workspace_access_companion_id_companions_id_fk"
  FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_workspace_access"
  ADD CONSTRAINT "companion_workspace_access_companion_fk"
  FOREIGN KEY ("org_id", "companion_id", "owner_id")
  REFERENCES "public"."companions"("org_id", "id", "owner_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_workspace_access"
  ADD CONSTRAINT "companion_workspace_access_granted_by_user_id_fk"
  FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "companion_member_access"
  ADD CONSTRAINT "companion_member_access_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_member_access"
  ADD CONSTRAINT "companion_member_access_companion_id_companions_id_fk"
  FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_member_access"
  ADD CONSTRAINT "companion_member_access_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_member_access"
  ADD CONSTRAINT "companion_member_access_companion_fk"
  FOREIGN KEY ("org_id", "companion_id", "owner_id")
  REFERENCES "public"."companions"("org_id", "id", "owner_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_member_access"
  ADD CONSTRAINT "companion_member_access_membership_fk"
  FOREIGN KEY ("org_id", "user_id")
  REFERENCES "public"."memberships"("org_id", "user_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_member_access"
  ADD CONSTRAINT "companion_member_access_granted_by_user_id_fk"
  FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "companion_transcript_entries"
  ADD CONSTRAINT "companion_transcript_entries_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_transcript_entries"
  ADD CONSTRAINT "companion_transcript_entries_companion_id_companions_id_fk"
  FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_transcript_entries"
  ADD CONSTRAINT "companion_transcript_entries_companion_fk"
  FOREIGN KEY ("org_id", "companion_id")
  REFERENCES "public"."companions"("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "companion_member_access_member_idx"
  ON "companion_member_access" ("org_id", "user_id");
--> statement-breakpoint
ALTER TABLE "companion_workspace_access" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_workspace_access" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_member_access" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_member_access" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_transcript_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_transcript_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "companion_workspace_access_member_read_rls" ON "companion_workspace_access"
  FOR SELECT USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.org_id = companion_workspace_access.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
    )
  );
--> statement-breakpoint
CREATE POLICY "companion_workspace_access_owner_write_rls" ON "companion_workspace_access"
  FOR ALL
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
    AND "granted_by" = NULLIF(current_setting('app.user_id', true), '')
  );
--> statement-breakpoint
CREATE POLICY "companion_member_access_member_read_rls" ON "companion_member_access"
  FOR SELECT USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND (
      "owner_id" = NULLIF(current_setting('app.user_id', true), '')
      OR "user_id" = NULLIF(current_setting('app.user_id', true), '')
    )
  );
--> statement-breakpoint
CREATE POLICY "companion_member_access_owner_write_rls" ON "companion_member_access"
  FOR ALL
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "owner_id" = NULLIF(current_setting('app.user_id', true), '')
    AND "granted_by" = NULLIF(current_setting('app.user_id', true), '')
  );
--> statement-breakpoint
DROP POLICY "companions_member_read_rls" ON "companions";
--> statement-breakpoint
CREATE POLICY "companions_acl_read_rls" ON "companions"
  FOR SELECT USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.org_id = companions.org_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
    )
    AND (
      "owner_id" = NULLIF(current_setting('app.user_id', true), '')
      OR EXISTS (
        SELECT 1 FROM public.companion_member_access a
        WHERE a.org_id = companions.org_id
          AND a.companion_id = companions.id
          AND a.user_id = NULLIF(current_setting('app.user_id', true), '')
      )
      OR EXISTS (
        SELECT 1 FROM public.companion_workspace_access a
        WHERE a.org_id = companions.org_id
          AND a.companion_id = companions.id
      )
    )
  );
--> statement-breakpoint
DROP POLICY "companions_owner_update_rls" ON "companions";
--> statement-breakpoint
CREATE POLICY "companions_runtime_update_rls" ON "companions"
  FOR UPDATE
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND (
      "owner_id" = NULLIF(current_setting('app.user_id', true), '')
      OR EXISTS (
        SELECT 1 FROM public.companion_member_access a
        WHERE a.org_id = companions.org_id
          AND a.companion_id = companions.id
          AND a.user_id = NULLIF(current_setting('app.user_id', true), '')
          AND a.role = 'editor'
      )
      OR (
        NOT EXISTS (
          SELECT 1 FROM public.companion_member_access a
          WHERE a.org_id = companions.org_id
            AND a.companion_id = companions.id
            AND a.user_id = NULLIF(current_setting('app.user_id', true), '')
        )
        AND EXISTS (
          SELECT 1 FROM public.companion_workspace_access a
          WHERE a.org_id = companions.org_id
            AND a.companion_id = companions.id
            AND a.role = 'editor'
        )
      )
    )
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND (
      "owner_id" = NULLIF(current_setting('app.user_id', true), '')
      OR EXISTS (
        SELECT 1 FROM public.companion_member_access a
        WHERE a.org_id = companions.org_id
          AND a.companion_id = companions.id
          AND a.user_id = NULLIF(current_setting('app.user_id', true), '')
          AND a.role = 'editor'
      )
      OR EXISTS (
        SELECT 1 FROM public.companion_workspace_access a
        WHERE a.org_id = companions.org_id
          AND a.companion_id = companions.id
          AND a.role = 'editor'
      )
    )
  );
--> statement-breakpoint
CREATE POLICY "companion_transcript_entries_acl_read_rls" ON "companion_transcript_entries"
  FOR SELECT USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.companions c
      WHERE c.org_id = companion_transcript_entries.org_id
        AND c.id = companion_transcript_entries.companion_id
    )
  );
--> statement-breakpoint
CREATE POLICY "companion_transcript_entries_editor_insert_rls" ON "companion_transcript_entries"
  FOR INSERT WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.companions c
      WHERE c.org_id = companion_transcript_entries.org_id
        AND c.id = companion_transcript_entries.companion_id
        AND (
          c.owner_id = NULLIF(current_setting('app.user_id', true), '')
          OR EXISTS (
            SELECT 1 FROM public.companion_member_access a
            WHERE a.org_id = c.org_id
              AND a.companion_id = c.id
              AND a.user_id = NULLIF(current_setting('app.user_id', true), '')
              AND a.role = 'editor'
          )
          OR (
            NOT EXISTS (
              SELECT 1 FROM public.companion_member_access a
              WHERE a.org_id = c.org_id
                AND a.companion_id = c.id
                AND a.user_id = NULLIF(current_setting('app.user_id', true), '')
            )
            AND EXISTS (
              SELECT 1 FROM public.companion_workspace_access a
              WHERE a.org_id = c.org_id
                AND a.companion_id = c.id
                AND a.role = 'editor'
            )
          )
        )
    )
  );

CREATE TABLE "companion_threads" (
  "org_id" uuid NOT NULL,
  "companion_id" uuid PRIMARY KEY NOT NULL,
  "next_ordinal" integer DEFAULT 0 NOT NULL,
  "delivered_ordinal" integer,
  "pi_log_offset" bigint DEFAULT 0 NOT NULL,
  "last_message_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_threads_next_ordinal_check" CHECK ("next_ordinal" >= 0),
  CONSTRAINT "companion_threads_delivered_ordinal_check"
    CHECK ("delivered_ordinal" is null or "delivered_ordinal" >= 0),
  CONSTRAINT "companion_threads_pi_log_offset_check" CHECK ("pi_log_offset" >= 0)
);
--> statement-breakpoint
ALTER TABLE "companion_threads"
  ADD CONSTRAINT "companion_threads_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_threads"
  ADD CONSTRAINT "companion_threads_companion_id_companions_id_fk"
  FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_threads"
  ADD CONSTRAINT "companion_threads_companion_fk"
  FOREIGN KEY ("org_id", "companion_id")
  REFERENCES "public"."companions"("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_threads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_threads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Anyone who can already see the Companion can read its thread state, so a Viewer transcript read
-- stays a pure control-plane read. The Companion policy filters the EXISTS probe.
CREATE POLICY "companion_threads_acl_read_rls" ON "companion_threads"
  FOR SELECT USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.companions c
      WHERE c.org_id = companion_threads.org_id
        AND c.id = companion_threads.companion_id
    )
  );
--> statement-breakpoint
-- Sending, delivering, and projecting Pi events all mutate this row, so writes match the
-- Owner/Editor run boundary used by companions_runtime_update_rls and the transcript insert policy.
CREATE POLICY "companion_threads_editor_write_rls" ON "companion_threads"
  FOR ALL
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.companions c
      WHERE c.org_id = companion_threads.org_id
        AND c.id = companion_threads.companion_id
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
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.companions c
      WHERE c.org_id = companion_threads.org_id
        AND c.id = companion_threads.companion_id
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

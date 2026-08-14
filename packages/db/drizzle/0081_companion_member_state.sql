-- Per-member Companions list preferences (THE-351): pin, hide, and unread watermarks.
-- Private to the member who set them; hide never archives the Companion or its Box.

CREATE TABLE "companion_member_state" (
  "org_id" uuid NOT NULL,
  "companion_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "pinned_at" timestamp with time zone,
  "hidden" boolean DEFAULT false NOT NULL,
  "last_read_ordinal" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_member_state_companion_id_user_id_pk"
    PRIMARY KEY ("companion_id", "user_id"),
  CONSTRAINT "companion_member_state_last_read_ordinal_check"
    CHECK ("last_read_ordinal" IS NULL OR "last_read_ordinal" >= 0)
);
--> statement-breakpoint
ALTER TABLE "companion_member_state"
  ADD CONSTRAINT "companion_member_state_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_member_state"
  ADD CONSTRAINT "companion_member_state_companion_id_companions_id_fk"
  FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_member_state"
  ADD CONSTRAINT "companion_member_state_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_member_state"
  ADD CONSTRAINT "companion_member_state_companion_fk"
  FOREIGN KEY ("org_id", "companion_id")
  REFERENCES "public"."companions"("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_member_state"
  ADD CONSTRAINT "companion_member_state_membership_fk"
  FOREIGN KEY ("org_id", "user_id")
  REFERENCES "public"."memberships"("org_id", "user_id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "companion_member_state_member_idx"
  ON "companion_member_state" ("org_id", "user_id");
--> statement-breakpoint
ALTER TABLE "companion_member_state" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_member_state" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Each member reads and writes only their own preferences for Companions they can already see.
CREATE POLICY "companion_member_state_self_rls" ON "companion_member_state"
  FOR ALL
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.org_id = companion_member_state.org_id
        AND m.user_id = companion_member_state.user_id
    )
    AND EXISTS (
      SELECT 1 FROM public.companions c
      WHERE c.org_id = companion_member_state.org_id
        AND c.id = companion_member_state.companion_id
        AND (
          c.owner_id = NULLIF(current_setting('app.user_id', true), '')
          OR EXISTS (
            SELECT 1 FROM public.companion_workspace_access a
            WHERE a.org_id = c.org_id
              AND a.companion_id = c.id
          )
        )
    )
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.org_id = companion_member_state.org_id
        AND m.user_id = companion_member_state.user_id
    )
    AND EXISTS (
      SELECT 1 FROM public.companions c
      WHERE c.org_id = companion_member_state.org_id
        AND c.id = companion_member_state.companion_id
        AND (
          c.owner_id = NULLIF(current_setting('app.user_id', true), '')
          OR EXISTS (
            SELECT 1 FROM public.companion_workspace_access a
            WHERE a.org_id = c.org_id
              AND a.companion_id = c.id
          )
        )
    )
  );

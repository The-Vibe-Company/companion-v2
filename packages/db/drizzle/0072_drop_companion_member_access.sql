-- THE-329 cuts individual Companion sharing: access is workspace-only (private | viewer | editor).
-- Rewrite every ACL policy that still referenced per-member grants so it depends only on the owner
-- and the workspace grant, then drop the now-unreferenced companion_member_access table. Recreating
-- the policies before the DROP is what lets the table go without CASCADE taking the policies with it.
DROP POLICY "companions_acl_read_rls" ON "companions";
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
        SELECT 1 FROM public.companion_workspace_access a
        WHERE a.org_id = companions.org_id
          AND a.companion_id = companions.id
      )
    )
  );
--> statement-breakpoint
DROP POLICY "companions_runtime_update_rls" ON "companions";
--> statement-breakpoint
CREATE POLICY "companions_runtime_update_rls" ON "companions"
  FOR UPDATE
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND (
      "owner_id" = NULLIF(current_setting('app.user_id', true), '')
      OR EXISTS (
        SELECT 1 FROM public.companion_workspace_access a
        WHERE a.org_id = companions.org_id
          AND a.companion_id = companions.id
          AND a.role = 'editor'
      )
    )
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND (
      "owner_id" = NULLIF(current_setting('app.user_id', true), '')
      OR EXISTS (
        SELECT 1 FROM public.companion_workspace_access a
        WHERE a.org_id = companions.org_id
          AND a.companion_id = companions.id
          AND a.role = 'editor'
      )
    )
  );
--> statement-breakpoint
DROP POLICY "companion_transcript_entries_editor_insert_rls" ON "companion_transcript_entries";
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
            SELECT 1 FROM public.companion_workspace_access a
            WHERE a.org_id = c.org_id
              AND a.companion_id = c.id
              AND a.role = 'editor'
          )
        )
    )
  );
--> statement-breakpoint
DROP POLICY "companion_threads_editor_write_rls" ON "companion_threads";
--> statement-breakpoint
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
            SELECT 1 FROM public.companion_workspace_access a
            WHERE a.org_id = c.org_id
              AND a.companion_id = c.id
              AND a.role = 'editor'
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
            SELECT 1 FROM public.companion_workspace_access a
            WHERE a.org_id = c.org_id
              AND a.companion_id = c.id
              AND a.role = 'editor'
          )
        )
    )
  );
--> statement-breakpoint
DROP TABLE "companion_member_access";

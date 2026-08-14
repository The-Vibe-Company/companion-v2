-- A tool run is its own transcript entry, so it keeps the ordinal that places it between the turns
-- it happened between rather than being folded into one of them.
ALTER TYPE "companion_transcript_role" ADD VALUE IF NOT EXISTS 'tool';--> statement-breakpoint

ALTER TABLE "companion_transcript_entries" ADD COLUMN "tool" jsonb;--> statement-breakpoint

-- Both checks compare the role as text on purpose: PostgreSQL refuses to read an enum label added
-- earlier in the same transaction, and this migration adds 'tool' a few statements up.
ALTER TABLE "companion_transcript_entries"
  ADD CONSTRAINT "companion_transcript_entries_tool_role_check"
  CHECK (("role"::text = 'tool') = ("tool" IS NOT NULL));--> statement-breakpoint

-- One downscaled Box frame plus the run detail. Anything larger is dropped before it reaches a row.
ALTER TABLE "companion_transcript_entries"
  ADD CONSTRAINT "companion_transcript_entries_tool_size_check"
  CHECK ("tool" IS NULL OR octet_length("tool"::text) <= 262144);--> statement-breakpoint

-- Transcript entries were insert-only until a run had to settle, so RLS never granted an update and a
-- chip's result would have written nothing at all. Settling a run and attaching its frame reach the
-- same rows the same writer already inserts, so the update is scoped exactly like that insert: the
-- Companion's owner or an editor, inside the tenant, with the row staying in the tenant it began in.
CREATE POLICY "companion_transcript_entries_editor_update_rls" ON "companion_transcript_entries"
  FOR UPDATE USING (
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
  ) WITH CHECK (
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

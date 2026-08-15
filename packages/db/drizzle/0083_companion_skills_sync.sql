-- Companion skills sync status: desired vs applied revision so the UI can answer "is the saved
-- skill list effective on the Box yet". Mirrors the github_sync_destinations revision pattern.
ALTER TABLE "companions"
  ADD COLUMN "skills_revision" integer DEFAULT 1 NOT NULL,
  ADD COLUMN "skills_applied_revision" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "skills_applied_at" timestamp with time zone,
  ADD COLUMN "skills_last_error" text;
--> statement-breakpoint
-- Existing rows are backfilled as in-sync: their skill set was staged by whatever start last ran,
-- and marking the whole fleet "pending" on deploy would be a lie in the other direction.
UPDATE "companions" SET "skills_applied_revision" = "skills_revision";
--> statement-breakpoint
ALTER TABLE "companions"
  ADD CONSTRAINT "companions_skills_revision_check"
  CHECK ("skills_revision" >= 1 AND "skills_applied_revision" >= 0 AND "skills_applied_revision" <= "skills_revision");
--> statement-breakpoint
ALTER TABLE "companions"
  ADD CONSTRAINT "companions_skills_last_error_check"
  CHECK ("skills_last_error" IS NULL OR char_length("skills_last_error") <= 500);

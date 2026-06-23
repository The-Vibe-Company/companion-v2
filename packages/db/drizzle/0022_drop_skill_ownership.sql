-- Remove the skill owner axis entirely. Every skill is now visible to every member of its org and
-- any member may edit it. `creator_id` (NOT NULL since the first migration) stays as the
-- provenance/Activity principal; the editable `owner_id` and both owner-team links are dropped.

-- Carry forward existing organization: a team-owned skill is filed under a shared label named for its
-- team's slug, so the grouping the team provided survives in the new label axis (the teams themselves
-- are dropped in 0023). Guarded by a `teams` existence check + ON CONFLICT so re-applying this migration
-- after 0023 has dropped `teams` is a clean no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'teams'
  ) THEN
    INSERT INTO "labels" ("org_id", "path")
      SELECT DISTINCT t."org_id", t."slug"
      FROM "teams" t JOIN "skills" s ON s."owner_team_id" = t."id"
      ON CONFLICT ("org_id", "path") DO NOTHING;
    INSERT INTO "skill_labels" ("org_id", "skill_id", "path")
      SELECT s."org_id", s."id", t."slug"
      FROM "skills" s JOIN "teams" t ON t."id" = s."owner_team_id"
      WHERE s."owner_team_id" IS NOT NULL
      ON CONFLICT ("org_id", "skill_id", "path") DO NOTHING;
  END IF;
END $$;--> statement-breakpoint

DROP INDEX IF EXISTS "skills_owner_team_idx";--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT IF EXISTS "skills_owner_team_org_fk";--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT IF EXISTS "skills_owner_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN IF EXISTS "owner_team_id";--> statement-breakpoint

ALTER TABLE "skills" DROP CONSTRAINT IF EXISTS "skills_owner_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN IF EXISTS "owner_id";

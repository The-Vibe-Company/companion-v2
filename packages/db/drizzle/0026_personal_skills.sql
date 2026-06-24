-- Personal skills: one new `scope` axis on `skills`. This re-introduces a per-user library on top of
-- the org-wide one (the design's "My Skills" vs "Organization").
--   * 'org'      — the existing org-wide library (DEFAULT, so every existing row keeps its behavior):
--                  visible to every member, any member may edit.
--   * 'personal' — private to `creator_id` (the owner). Visible only to that user, even to admins.
-- "Installed" is NOT modeled here: it stays the existing `skill_installs` rows, surfaced under My
-- Skills. The slug stays workspace-unique across scopes (`skills_org_slug_uq` is unchanged) so the
-- slug-keyed dependency graph stays unambiguous. The scope filter is enforced in the service layer;
-- the `skills` table keeps its org-scoped RLS from 0004.

CREATE TYPE "skill_scope" AS ENUM ('personal', 'org');--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "scope" "skill_scope" DEFAULT 'org' NOT NULL;--> statement-breakpoint
CREATE INDEX "skills_org_scope_creator_idx" ON "skills" USING btree ("org_id","scope","creator_id");

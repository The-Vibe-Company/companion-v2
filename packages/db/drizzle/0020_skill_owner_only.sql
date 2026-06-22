-- Collapse skill visibility + ownership into a single "Owner" axis.
--
-- Before: a skill had `everyone` (workspace-wide read) + zero or more `skill_team_shares` rows
-- (per-team read), independent of who owned it (`owner_team_id`).
-- After: the owner IS the access axis. `owner_team_id` NULL = Personal (private to `owner_id`);
-- set = owned by that team and readable by the whole workspace. No `everyone`, no team shares.
--
-- Backfill principle: NEVER move edit rights during the upgrade. The old model separated read
-- (everyone/shares) from write (owner); the new model fuses them. So we only convert a skill to
-- team-owned when doing so keeps the SAME editors — i.e. when the skill's own owner is an admin/editor
-- of the assigned team. Concretely:
--   * Already team-owned skills are untouched (their editors are unchanged).
--   * Everyone-visible personal skills whose owner admins/edits a team are assigned that team: the
--     skill stays workspace-visible AND its owner keeps edit rights (its team gains edit, which is the
--     intended team-owned model).
--   * Everything else (team-SHARED read-only skills, and everyone-visible skills whose owner has no
--     editable team) stays Personal. This may NARROW visibility for those skills, but that is the safe
--     direction: it never silently grants a previously read-only team edit rights, and never strips the
--     original owner's edit rights. The owner re-shares by moving the skill to a team via
--     `PUT /v1/skills/:slug/owner`.
--
-- Known trade-off (intentional, security-first): the old model separated read (everyone/shares) from
-- write (owner); the new model fuses them, so no backfill can preserve every property at once. By
-- refusing to move edit rights we accept that a workspace-visible skill which depended on an
-- everyone-visible skill whose owner has no editable team will, after upgrade, have a Personal
-- dependency — its dependency shows a live "visibility mismatch" status until an admin re-homes that
-- dependency to a team. Existing installs are unaffected (the status is informational and only gates
-- *future* publishes of the dependent). This is preferred over the alternative of silently granting a
-- read-only team write access to skills it could previously only read.

UPDATE "skills" s SET "owner_team_id" = (
	SELECT tm.team_id FROM "team_memberships" tm
	JOIN "teams" t ON t."id" = tm.team_id
	WHERE tm.org_id = s."org_id" AND tm.user_id = s."owner_id" AND tm.team_role IN ('admin', 'editor')
	ORDER BY t."name" ASC
	LIMIT 1
)
WHERE s."owner_team_id" IS NULL AND s."everyone" = true
	AND EXISTS (
		SELECT 1 FROM "team_memberships" tm2 JOIN "teams" t2 ON t2."id" = tm2.team_id
		WHERE tm2.org_id = s."org_id" AND tm2.user_id = s."owner_id" AND tm2.team_role IN ('admin', 'editor')
	);--> statement-breakpoint

-- (3) Drop the legacy visibility columns/index and the team-share table.
DROP INDEX IF EXISTS "skills_everyone_idx";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN IF EXISTS "everyone";--> statement-breakpoint
DROP POLICY IF EXISTS "skill_team_shares_tenant_rls" ON "skill_team_shares";--> statement-breakpoint
DROP TABLE IF EXISTS "skill_team_shares";--> statement-breakpoint

-- (4) Strip now-stale filter entries from saved filter preferences and views: `visibility` filters
--     (values changed from private/team/everyone to the owner-kind set personal/team) and `owner`
--     filters (the web now matches the owner PRINCIPAL ID, not the display name, so legacy name-based
--     owner filters would silently match nothing).
UPDATE "skill_filter_preferences"
SET "active_filters" = COALESCE((
	SELECT jsonb_agg(filter)
	FROM jsonb_array_elements("active_filters") AS filter
	WHERE filter->>'type' NOT IN ('visibility', 'owner')
), '[]'::jsonb);--> statement-breakpoint
UPDATE "skill_filter_preferences"
SET "custom_views" = COALESCE((
	SELECT jsonb_agg(
		CASE
			WHEN jsonb_typeof(view->'filters') = 'array' THEN jsonb_set(
				view,
				'{filters}',
				COALESCE((
					SELECT jsonb_agg(filter)
					FROM jsonb_array_elements(view->'filters') AS filter
					WHERE filter->>'type' NOT IN ('visibility', 'owner')
				), '[]'::jsonb),
				true
			)
			ELSE view
		END
	)
	FROM jsonb_array_elements("custom_views") AS view
), '[]'::jsonb);

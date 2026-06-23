-- Saved skill filters lose their owner-era dimensions. `visibility` / `owner` / `team` filter
-- entries no longer have any meaning (skills are flat and org-wide), so strip them from each member's
-- `active_filters`. Saved views ("custom_views") are removed entirely — drop the column.

UPDATE "skill_filter_preferences"
SET "active_filters" = COALESCE((
	SELECT jsonb_agg(filter)
	FROM jsonb_array_elements("active_filters") AS filter
	WHERE filter->>'type' NOT IN ('visibility', 'owner', 'team')
), '[]'::jsonb);--> statement-breakpoint

ALTER TABLE "skill_filter_preferences" DROP COLUMN IF EXISTS "custom_views";

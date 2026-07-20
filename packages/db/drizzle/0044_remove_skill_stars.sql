-- Remove the retired starred filter without disturbing the order or contents of other preferences.
UPDATE "skill_filter_preferences"
SET "active_filters" = COALESCE(
  (
    SELECT jsonb_agg(filter ORDER BY ordinal)
    FROM jsonb_array_elements("active_filters") WITH ORDINALITY AS saved(filter, ordinal)
    WHERE filter->>'type' IS DISTINCT FROM 'starred'
  ),
  '[]'::jsonb
),
"updated_at" = now()
WHERE jsonb_path_exists("active_filters", '$[*] ? (@.type == "starred")');--> statement-breakpoint

-- PostgreSQL cannot change a function's OUT columns with CREATE OR REPLACE. Recreate the private
-- pre-tenant preview seam without the retired popularity field before dropping its source table.
DROP FUNCTION companion_public_skill_preview(text);--> statement-breakpoint
CREATE FUNCTION companion_public_skill_preview(p_token text)
RETURNS TABLE (
  "slug" text,
  "display_name" text,
  "description" text,
  "creator_name" text,
  "creator_initials" text,
  "current_version" text,
  "frontmatter" text,
  "updated_at" timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s."slug", s."display_name", s."description", p."name", p."initials", v."version",
         v."frontmatter", s."updated_at"
  FROM public."skills" s
  JOIN public."profiles" p ON p."id" = s."creator_id"
  JOIN public."skill_versions" v
    ON v."org_id" = s."org_id" AND v."skill_id" = s."id" AND v."id" = s."current_version_id"
  WHERE s."share_token" = p_token AND s."scope" = 'org' AND s."archived_at" IS NULL
  LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_public_skill_preview(text) FROM PUBLIC;--> statement-breakpoint

-- DROP TABLE removes the table's RLS policy, indexes, constraints, and historical rows together.
DROP TABLE "skill_stars";

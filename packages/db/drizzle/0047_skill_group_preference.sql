-- Re-declare the 0046 function so rebased development databases recover when the former
-- 0046_skill_group_preference migration was already recorded before 0046_api_token_refresh landed.
-- Fresh databases have the function already; CREATE OR REPLACE keeps this path idempotent.
CREATE OR REPLACE FUNCTION companion_lock_api_token_for_refresh(p_token_hash text)
RETURNS TABLE (
  "token_id" uuid,
  "org_id" uuid,
  "user_id" text,
  "token_name" text,
  "scopes" jsonb,
  "expires_at" timestamp with time zone,
  "is_expired" boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    t."id",
    t."org_id",
    t."user_id",
    t."name",
    t."scopes",
    t."expires_at",
    t."expires_at" <= clock_timestamp()
  FROM public."api_tokens" t
  JOIN public."memberships" m
    ON m."org_id" = t."org_id" AND m."user_id" = t."user_id"
  WHERE t."token_hash" = p_token_hash
    AND t."revoked_at" IS NULL
    AND t."expires_at" >= clock_timestamp() - interval '30 days'
  LIMIT 1
  FOR UPDATE OF t
  FOR KEY SHARE OF m
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_lock_api_token_for_refresh(text) FROM PUBLIC;--> statement-breakpoint
ALTER TABLE "skill_filter_preferences" ADD COLUMN IF NOT EXISTS "group_by" text DEFAULT 'folder' NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "skill_filter_preferences"
    ADD CONSTRAINT "skill_filter_preferences_group_by_check"
    CHECK ("group_by" in ('folder', 'none'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

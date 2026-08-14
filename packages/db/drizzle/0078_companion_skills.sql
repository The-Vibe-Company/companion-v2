-- THE-360: per-Companion skill allow-list and write-on-behalf.
ALTER TABLE "companions"
  ADD COLUMN "selected_skill_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN "can_write_skills" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Postgres CHECK cannot use subqueries; UUID element shape is enforced in contracts/core.
ALTER TABLE "companions"
  ADD CONSTRAINT "companions_selected_skill_ids_check"
  CHECK (jsonb_typeof("selected_skill_ids") = 'array');
--> statement-breakpoint

-- Companion write-on-behalf PATs reuse source_agent_id as the Companion id.
ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_source_provenance_check";
--> statement-breakpoint
ALTER TABLE "api_tokens"
  ADD CONSTRAINT "api_tokens_source_provenance_check"
  CHECK (
    ("source_type" = 'human' AND "source_agent_id" IS NULL AND "target_workspace_id" IS NULL)
    OR ("source_type" = 'agent_auth' AND "source_agent_id" IS NOT NULL)
    OR (
      "source_type" = 'companion'
      AND "source_agent_id" IS NOT NULL
      AND "source_agent_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  );
--> statement-breakpoint

-- Resolver returns Companion provenance so skills:write can re-check can_write_skills.
-- OUT columns changed, so drop both overloads before recreate (CREATE OR REPLACE cannot widen them).
DROP FUNCTION IF EXISTS companion_resolve_api_token(text, text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS companion_resolve_api_token(text);
--> statement-breakpoint
CREATE FUNCTION companion_resolve_api_token(p_token_hash text, p_target_workspace_id text)
RETURNS TABLE (
  "org_id" uuid,
  "user_id" text,
  "scopes" jsonb,
  "email" text,
  "name" text,
  "source_type" text,
  "source_agent_id" text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH candidate AS MATERIALIZED (
    SELECT t."id", t."org_id", t."user_id", t."scopes", t."source_type", t."source_agent_id",
           COALESCE(p."email", u."email") AS "email",
           COALESCE(NULLIF(p."name", ''), NULLIF(u."name", ''), p."email", u."email", t."user_id") AS "name"
    FROM public."api_tokens" t
    JOIN public."memberships" m ON m."org_id" = t."org_id" AND m."user_id" = t."user_id"
    JOIN public."user" u ON u."id" = t."user_id"
    LEFT JOIN public."profiles" p ON p."id" = t."user_id"
    WHERE t."token_hash" = p_token_hash
      AND t."revoked_at" IS NULL
      AND t."expires_at" > clock_timestamp()
      AND (t."target_workspace_id" IS NULL OR t."target_workspace_id" = p_target_workspace_id)
    LIMIT 1
    FOR UPDATE OF t
  ), touched AS (
    UPDATE public."api_tokens" t
    SET "last_used_at" = clock_timestamp()
    FROM candidate c
    WHERE t."id" = c."id"
    RETURNING t."id"
  )
  SELECT c."org_id", c."user_id", c."scopes", c."email", c."name", c."source_type", c."source_agent_id"
  FROM candidate c
  JOIN touched ON touched."id" = c."id"
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_resolve_api_token(text, text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION companion_resolve_api_token(p_token_hash text)
RETURNS TABLE (
  "org_id" uuid,
  "user_id" text,
  "scopes" jsonb,
  "email" text,
  "name" text,
  "source_type" text,
  "source_agent_id" text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM public.companion_resolve_api_token(p_token_hash, NULL::text)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_resolve_api_token(text) FROM PUBLIC;

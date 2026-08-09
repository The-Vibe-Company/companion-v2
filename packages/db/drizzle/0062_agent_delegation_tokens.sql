ALTER TABLE "api_tokens"
  ADD COLUMN "source_type" text DEFAULT 'human' NOT NULL,
  ADD COLUMN "source_agent_id" text,
  ADD COLUMN "target_workspace_id" text;
--> statement-breakpoint
ALTER TABLE "api_tokens"
  ADD CONSTRAINT "api_tokens_source_provenance_check"
  CHECK (
    ("source_type" = 'human' AND "source_agent_id" IS NULL AND "target_workspace_id" IS NULL)
    OR ("source_type" = 'agent_auth' AND "source_agent_id" IS NOT NULL)
  );
--> statement-breakpoint
CREATE INDEX "api_tokens_source_agent_idx"
  ON "api_tokens" ("source_agent_id")
  WHERE "source_agent_id" IS NOT NULL;
--> statement-breakpoint

-- Add the target-aware resolver without removing the hash-only overload used by live old API
-- replicas during migration-first deployments. This is a bearer binding, not remote-workspace
-- attestation.
CREATE FUNCTION companion_resolve_api_token(p_token_hash text, p_target_workspace_id text)
RETURNS TABLE (
  "org_id" uuid,
  "user_id" text,
  "scopes" jsonb,
  "email" text,
  "name" text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH candidate AS MATERIALIZED (
    SELECT t."id", t."org_id", t."user_id", t."scopes",
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
  SELECT c."org_id", c."user_id", c."scopes", c."email", c."name"
  FROM candidate c
  JOIN touched ON touched."id" = c."id"
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_resolve_api_token(text, text) FROM PUBLIC;
--> statement-breakpoint

-- Keep old PAT callers working through rolling deploys and rollbacks, but fail closed for a bound
-- delegated PAT when the old caller cannot supply its target identifier.
CREATE OR REPLACE FUNCTION companion_resolve_api_token(p_token_hash text)
RETURNS TABLE (
  "org_id" uuid,
  "user_id" text,
  "scopes" jsonb,
  "email" text,
  "name" text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM public.companion_resolve_api_token(p_token_hash, NULL::text)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_resolve_api_token(text) FROM PUBLIC;
--> statement-breakpoint

-- Preserve the browser-session overload while giving PAT downloads truthful audit provenance.
-- The four-argument function owns the authorization/audit logic; the old signature remains a
-- compatibility wrapper for live and rolled-back API replicas.
CREATE FUNCTION companion_authorize_public_skill_package(
  p_token text,
  p_version text,
  p_user_id text,
  p_auth_kind text
)
RETURNS TABLE (
  "org_id" uuid,
  "skill_id" uuid,
  "skill_version_id" uuid,
  "slug" text,
  "version" text,
  "storage_path" text,
  "checksum" text,
  "size_bytes" integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  package record;
BEGIN
  IF p_auth_kind NOT IN ('session', 'api_token') THEN
    RETURN;
  END IF;

  SELECT s."org_id", s."id" AS "skill_id", v."id" AS "skill_version_id", s."slug",
         v."version", v."storage_path", s."public_package_checksum" AS "checksum",
         s."public_package_size_bytes" AS "size_bytes"
    INTO package
  FROM public."skills" s
  JOIN public."skill_versions" v
    ON v."org_id" = s."org_id" AND v."skill_id" = s."id" AND v."id" = s."public_version_id"
  JOIN public."user" u ON u."id" = p_user_id AND u."email_verified" = true
  WHERE s."share_token" = p_token
    AND s."scope" = 'org'
    AND s."archived_at" IS NULL
    AND v."version" = p_version
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO public."audit_log" ("org_id", "actor_id", "action", "target_type", "target_id", "metadata")
  VALUES (
    package."org_id", p_user_id, 'skill.public_package.download_authorized', 'skill',
    package."skill_id"::text,
    jsonb_build_object(
      'version', package."version",
      'checksum', package."checksum",
      'auth', p_auth_kind
    )
  );

  RETURN QUERY SELECT package."org_id", package."skill_id", package."skill_version_id",
                      package."slug", package."version", package."storage_path",
                      package."checksum", package."size_bytes";
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_authorize_public_skill_package(text, text, text, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION companion_authorize_public_skill_package(
  p_token text,
  p_version text,
  p_user_id text
)
RETURNS TABLE (
  "org_id" uuid,
  "skill_id" uuid,
  "skill_version_id" uuid,
  "slug" text,
  "version" text,
  "storage_path" text,
  "checksum" text,
  "size_bytes" integer
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM public.companion_authorize_public_skill_package(
    p_token,
    p_version,
    p_user_id,
    'session'
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_authorize_public_skill_package(text, text, text) FROM PUBLIC;
--> statement-breakpoint

-- A delegated PAT is a terminal child credential. It cannot mint a longer-lived successor through
-- the legacy recovery route; only human-issued PATs retain refresh compatibility.
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
    AND t."source_type" = 'human'
    AND t."revoked_at" IS NULL
    AND t."expires_at" >= clock_timestamp() - interval '30 days'
  LIMIT 1
  FOR UPDATE OF t
  FOR KEY SHARE OF m
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_lock_api_token_for_refresh(text) FROM PUBLIC;
